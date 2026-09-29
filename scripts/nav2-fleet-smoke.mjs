import {configureNav2Fleet} from './nav2-fleet-scenario.mjs';
import {EdgeSimulation,startAgents} from './edge-sim.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
process.env.EDGE_TRANSPORT='ros2';
process.env.NAV2_EXECUTOR_BASE_PORT='19700';
process.env.ROS_BRIDGE_COMMAND=JSON.stringify(['podman','run','--rm','-i','--network=host','-e','ROS_DOMAIN_ID=96','localhost/teamrocket-ros2:jazzy']);
const endpoints=Array.from({length:3},(_,i)=>({id:`AMR-0${i+1}`,host:'127.0.0.1',controlPort:19800+i,ownershipPort:19900+i,motionPort:20000+i}));
const started=Date.now();
const processes=await startAgents(endpoints);
const mode=process.env.NAV2_FLEET_MODE??'crossing';
const output=process.env.NAV2_FLEET_OUTPUT??'/tmp/teamrocket-nav2-fleet';
try {
  const sim=new EdgeSimulation(endpoints,{settleMs:25});
  await sim.initialize(23000,'negotiated',`nav2-${Date.now()}`,s=>configureNav2Fleet(s,mode==='crossing'));
  const call=async(route,body)=>{const r=await fetch('http://127.0.0.1:19700'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return r.json();};
  let injected=false, faultEvidence=null, injection, obstacleEvidence=null;
  while(sim.tick<220&&!sim.result().completed) {
    if(sim.tick===112&&!injected) {
      injected=true;
      injection=(async()=>{await new Promise(r=>setTimeout(r,700));
        if(mode==='fault') return call('/cancel',{});
        if(mode==='crash') {processes.children[0].kill('SIGKILL');return;}
        await call('/obstacle',{blocked:true});await new Promise(r=>setTimeout(r,500));const held1=await call('/inspect',{});await new Promise(r=>setTimeout(r,1000));const held2=await call('/inspect',{});obstacleEvidence={settledDrift:Math.hypot(held2.groundTruth.x-held1.groundTruth.x,held2.groundTruth.y-held1.groundTruth.y),first:held1.groundTruth,last:held2.groundTruth};await call('/obstacle',{blocked:false});
      })();
    }
    try { await sim.step(); }
    catch(error) {
      if(!['fault','crash'].includes(mode))throw error;
      if(mode==='crash')await new Promise(r=>setTimeout(r,2800));
      const observed=mode==='crash'?sim.states[0]:await sim.request(0,'/state'); const actual=await call('/inspect',{});
      faultEvidence={error:String(error),committedCell:observed.state.robot.position,actual,completedTasks:observed.state.completed.length};break;
    }
  }
  await injection;
  if(['fault','crash'].includes(mode)) {
    const passed=!!faultEvidence&&faultEvidence.committedCell.x===1&&faultEvidence.committedCell.y===1&&faultEvidence.actual.pose.x>0&&faultEvidence.actual.pose.x<0.6&&faultEvidence.actual.collisions===0&&faultEvidence.completedTasks===0&&!faultEvidence.actual.cancellationPending;
    await mkdir(output,{recursive:true});await writeFile(`${output}/result.json`,JSON.stringify({passed,mode,wallSeconds:(Date.now()-started)/1000,scope:'Actual Nav2 cancellation or controller SIGKILL during first cell. Grid/task state must not claim arrival; partial continuous pose retained and executor latches.',faultEvidence},null,2)+'\n');
    if(!passed)throw new Error('Partial execution cancellation regression');process.exitCode=0;
  } else {
  const result=sim.result();
  const physical=result.states.map(s=>({id:s.id,pid:s.pid,execution:s.execution,transport:s.transport,metrics:s.state.metrics}));
  const passed=!!obstacleEvidence&&obstacleEvidence.settledDrift<0.015&&result.completed&&Object.values(result.safety).every(x=>x===0)&&physical.every(s=>s.execution.kind==='nav2'&&!s.execution.fault&&s.execution.feedback.actions>=2&&s.execution.feedback.collisions===0);
  const report={schema:1,passed,wallSeconds:(Date.now()-started)/1000,scope:'Three independent Node fleet controllers and Fast DDS peers, each executing locally authorized cell moves through actual Nav2 FollowPath, EKF and CollisionMonitor. Shared ideal continuous physical pose bus ray-casts other robots into lidar. Lockstep clock waits for measured Nav2 arrival before committing cell or task progress.',limitations:['Development smoke on crossing routes with transient sensed obstacle, not throughput or choke-point acceptance','Logical ownership time is frozen while a cell executes; not asynchronous physical robot leases','Ideal sensors and kinematics, no hardware','Initial grid blocked cells become continuous lidar/costmap geometry; dynamic block updates are not yet forwarded','Faults latch with measured partial pose; restart/relocalization is required, no automatic mid-cell recovery'],obstacleEvidence,completed:result.completed,completedTasks:result.completedTasks,ticks:result.ticks,safety:result.safety,physical};
  await mkdir(output,{recursive:true});await writeFile(`${output}/result.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
  if(!passed)throw new Error('Nav2 fleet integration smoke failed');
  }
}finally{await processes.close();}
