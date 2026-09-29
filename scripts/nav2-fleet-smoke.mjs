import {configureNav2Fleet} from './nav2-fleet-scenario.mjs';
import {EdgeSimulation,startAgents} from './edge-sim.mjs';
import {loadFleetConfig,buildEndpoints} from './fleet-config.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';

// The fleet config is the only roster. The agent endpoint list is derived from
// it, so controller count, namespaces, origins and executors all scale together.
const config=loadFleetConfig();
const fleetSize=config.robots.length;
process.env.EDGE_TRANSPORT='ros2';
process.env.ROS_BRIDGE_COMMAND=JSON.stringify(['podman','run','--rm','-i','--network=host','-e',`ROS_DOMAIN_ID=${config.rosDomainId}`,'localhost/teamrocket-ros2:jazzy']);
const portBase=Number(process.env.NAV2_FLEET_PORT_BASE??19800);
const endpoints=buildEndpoints(config,portBase);
const started=Date.now();
const processes=await startAgents(endpoints);
const mode=process.env.NAV2_FLEET_MODE??'crossing';
const output=process.env.NAV2_FLEET_OUTPUT??`/tmp/teamrocket-nav2-fleet-n${fleetSize}`;
// The victim is a parameter so a mid-robot failure is exercised, not just the first.
const victim=Math.min(Math.max(Number(process.env.NAV2_FLEET_VICTIM??0),0),fleetSize-1);
const victimRobot=config.robots[victim];
const victimPort=victimRobot.executorPort;
try {
  const sim=new EdgeSimulation(endpoints,{settleMs:25});
  await sim.initialize(23000,'negotiated',`nav2-${Date.now()}`,s=>configureNav2Fleet(s,mode==='crossing',config));
  const call=async(route,body)=>{const r=await fetch('http://127.0.0.1:'+victimPort+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return r.json();};
  // Budget scales with N: a larger fleet has a longer makespan.
  const budget=config.robots.length*120;
  const motionStart=sim.scenario.configs[0].motionStartTick;
  let injected=false, faultEvidence=null, injection, obstacleEvidence=null;
  while(sim.tick<budget&&!sim.result().completed) {
    if(sim.tick===motionStart&&!injected) {
      injected=true;
      injection=(async()=>{await new Promise(r=>setTimeout(r,700));
        if(mode==='fault') return call('/cancel',{});
        if(mode==='crash') {processes.children[victim].kill('SIGKILL');return;}
        await call('/obstacle',{blocked:true});await new Promise(r=>setTimeout(r,500));const held1=await call('/inspect',{});await new Promise(r=>setTimeout(r,1000));const held2=await call('/inspect',{});obstacleEvidence={settledDrift:Math.hypot(held2.groundTruth.x-held1.groundTruth.x,held2.groundTruth.y-held1.groundTruth.y),first:held1.groundTruth,last:held2.groundTruth};await call('/obstacle',{blocked:false});
      })();
    }
    try { await sim.step(); }
    catch(error) {
      if(!['fault','crash'].includes(mode))throw error;
      if(mode==='crash')await new Promise(r=>setTimeout(r,2800));
      const observed=mode==='crash'?sim.states[victim]:await sim.request(victim,'/state'); const actual=await call('/inspect',{});
      faultEvidence={error:String(error),committedCell:observed.state.robot.position,actual,completedTasks:observed.state.completed.length};break;
    }
  }
  await injection;
  if(['fault','crash'].includes(mode)) {
    // The committed cell must be the victim's configured origin, and the retained
    // physical pose must be a partial move off it, not an arrival.
    const origin=victimRobot.origin;
    const passed=!!faultEvidence&&faultEvidence.committedCell.x===origin.x&&faultEvidence.committedCell.y===origin.y
      &&faultEvidence.actual.pose.x>0&&faultEvidence.actual.pose.x<config.cellMetres
      &&faultEvidence.actual.collisions===0&&faultEvidence.completedTasks===0&&!faultEvidence.actual.cancellationPending;
    await mkdir(output,{recursive:true});await writeFile(`${output}/result.json`,JSON.stringify({passed,mode,victim:victimRobot.id,wallSeconds:(Date.now()-started)/1000,scope:'Actual Nav2 cancellation or controller SIGKILL during first cell. Grid/task state must not claim arrival; partial continuous pose retained and executor latches.',faultEvidence},null,2)+'\n');
    if(!passed)throw new Error('Partial execution cancellation regression');process.exitCode=0;
  } else {
  const result=sim.result();
  const physical=result.states.map((s,i)=>({id:s.id,pid:s.pid,namespace:config.robots[i].namespace,origin:config.robots[i].origin,executorPort:endpoints[i].executorPort,execution:s.execution,transport:s.transport,metrics:s.state.metrics}));
  // Every robot must use its own Nav2 stack with no collisions. A robot that
  // legitimately wins no auction may take few actions, so assert on the total
  // and on per-robot safety rather than a per-robot action floor.
  const totalActions=physical.reduce((n,s)=>n+(s.execution.feedback?.actions??0),0);
  const passed=!!obstacleEvidence&&obstacleEvidence.settledDrift<0.015&&result.completed&&Object.values(result.safety).every(x=>x===0)
    &&physical.every(s=>s.execution.kind==='nav2'&&!s.execution.fault&&s.execution.feedback.collisions===0)
    &&totalActions>=fleetSize
    &&physical.every(s=>s.transport.subscriptions.motion===fleetSize&&s.transport.subscriptions.ownership===fleetSize);
  const report={schema:1,passed,robots:fleetSize,controllersStarted:physical.filter(s=>s.pid).length,
    ddsPeersReady:physical.filter(s=>s.transport.subscriptions.motion===fleetSize).length,
    wallSeconds:(Date.now()-started)/1000,
    scope:`${fleetSize} independent Node fleet controllers and Fast DDS peers, each executing locally authorized cell moves through actual Nav2 FollowPath, EKF and CollisionMonitor. Shared ideal continuous physical pose bus ray-casts every other robot into lidar. Lockstep clock waits for measured Nav2 arrival before committing cell or task progress.`,
    limitations:['Development smoke on crossing routes with transient sensed obstacle, not throughput or choke-point acceptance','Logical ownership time is frozen while a cell executes; not asynchronous physical robot leases','Ideal sensors and kinematics, no hardware','Initial grid blocked cells become continuous lidar/costmap geometry; dynamic block updates are not yet forwarded','Faults latch with measured partial pose; restart/relocalization is required, no automatic mid-cell recovery','One transient obstacle is injected on the victim robot only'],
    obstacleEvidence,completed:result.completed,completedTasks:result.completedTasks,totalTasks:result.totalTasks,
    ticks:result.ticks,totalActions,safety:result.safety,physical};
  await mkdir(output,{recursive:true});await writeFile(`${output}/result.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
  if(!passed)throw new Error('Nav2 fleet integration smoke failed');
  }
}finally{await processes.close();}
