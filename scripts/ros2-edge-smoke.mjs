import { EdgeSimulation, startAgents } from './edge-sim.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
process.env.EDGE_TRANSPORT='ros2';
const endpoints=Array.from({length:3},(_,i)=>({id:`AMR-0${i+1}`,host:'127.0.0.1',controlPort:19400+i,ownershipPort:19500+i,motionPort:19600+i}));
const processes=await startAgents(endpoints);
try {
  const simulation=new EdgeSimulation(endpoints,{settleMs:20});
  await simulation.initialize(23000,'negotiated',`dds-${Date.now()}`);
  while(simulation.tick<400&&!simulation.result().completed)await simulation.step();
  const result=simulation.result();
  const record={...result,scope:'Three Node controllers, each with its own ROS2 Fast DDS sidecar; grid simulation, shared clock; development smoke, not fresh acceptance or Nav2/hardware proof'};
  await mkdir('artifacts/ros2-integration',{recursive:true});
  await writeFile('artifacts/ros2-integration/edge-smoke.json',JSON.stringify(record,null,2)+'\n');
  if(!result.completed||Object.values(result.safety).some(v=>v!==0))throw new Error('ROS2 fleet did not complete safely');
  if(result.states.some(s=>s.transport.kind!=='ros2'||s.datagrams.allocation.received===0||s.datagrams.motion.received===0))throw new Error('ROS peer delivery not observed');
  console.log(JSON.stringify({completed:result.completed,completedTasks:result.completedTasks,ticks:result.ticks,safety:result.safety,transport:'ROS2/Fast DDS',robotProcesses:result.states.map(s=>s.pid)}));
}finally{await processes.close();}
