import http from "node:http";
import {configureNav2Fleet} from "./nav2-fleet-scenario.mjs";
import { readFile } from "node:fs/promises";
import { EdgeSimulation, startAgents, sleep } from "./edge-sim.mjs";
const remote=process.argv.find(a=>a.startsWith("--endpoints="))?.split("=")[1];
const endpoints=remote?JSON.parse(await readFile(remote,"utf8")):[0,1,2].map(i=>({id:`AMR-0${i+1}`,host:"127.0.0.1",controlPort:18401+i,ownershipPort:18501+i,motionPort:18601+i}));
const local=remote?null:await startAgents(endpoints),sim=new EdgeSimulation(endpoints);
await sim.initialize(23000,"negotiated",`demo-${Date.now()}`,process.env.NAV2_EXECUTOR_BASE_PORT?configureNav2Fleet:()=>{});
const pending=[];let stopping=false;
const server=http.createServer(async(req,res)=>{
  res.setHeader("Content-Type","application/json");res.setHeader("Cache-Control","no-store");
  try{
    if(req.method==="GET"&&req.url==="/state"){
      if(process.env.NAV2_EXECUTOR_BASE_PORT) {
        const latest=await Promise.all(endpoints.map((_e,i)=>sim.request(i,"/state")));
        latest.forEach((s,i)=>{sim.states[i].execution=s.execution;});
      }
      res.end(JSON.stringify(sim.snapshot()));return;
    }
    if(req.method!=="POST"||req.url!=="/command"){res.writeHead(404);res.end("{}");return;}
    let text="";for await(const chunk of req){text+=chunk;if(text.length>16384)throw new Error("Command too large");}
    const command=JSON.parse(text);
    if(process.env.NAV2_EXECUTOR_BASE_PORT && ["block","fail"].includes(command.kind))throw new Error("Nav2 live demo does not support dynamic grid blocks or mid-cell recovery; use the dedicated cancellation/crash smoke");
    await new Promise((resolve,reject)=>pending.push({command,resolve,reject}));
    res.end(JSON.stringify(sim.snapshot()));
  }catch(e){res.writeHead(400);res.end(JSON.stringify({error:String(e)}));}
});
const port=Number(process.env.EDGE_SIM_PORT??4011);
server.listen(port,"127.0.0.1",()=>console.log(`Edge simulation on 127.0.0.1:${port}; start dashboard with FLEET_URL=http://127.0.0.1:${port} npm run dev`));
process.on("SIGTERM",()=>{stopping=true;});
process.on("SIGINT",()=>{stopping=true;});
try{
  while(!stopping){
    for(const p of pending.splice(0)){
      try{
        await sim.command(p.command);
        if(p.command.kind==="fail")local?.children[endpoints.findIndex(e=>e.id===p.command.robotId)].kill();
        p.resolve();
      }catch(e){p.reject(e);}
    }
    await sim.step();await sleep(80);
  }
}finally{server.close();await local?.close();}
