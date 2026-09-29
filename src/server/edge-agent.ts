/** One robot process. HTTP supplies simulated sensors/clock, never a route or
 * auction winner. Ownership and motion packets go directly to peer UDP ports.
 * Not an asynchronous physical-robot safety controller.
 */
import http from "node:http";
import { Nav2Executor } from "./nav2-executor";
import { readFileSync } from "node:fs";
import { EdgePeer, type EdgeConfig } from "../core/distributed/edge-peer";
import { UdpTransport, type Transport } from "../core/distributed/transport";
import type { OwnershipMessage } from "../core/distributed/ownership";
import { RosBridge } from "../core/distributed/ros-transport";
import type { Message } from "../core/distributed/protocol";

export type EdgeEndpoint = { id: string; host: string; controlPort: number; ownershipPort: number; motionPort: number };
type Wire<T> = Transport<T> & { stats: { sent: number; received: number; dropped: number }; setReachable(id: string, reachable: boolean): void };
type Envelope<T> = { from: string; session: string; payload: T };
class SessionTransport<T> implements Transport<T> {
  get kind() { return `session-${this.wire.kind}`; }
  constructor(private id: string, private session: string, private wire: Wire<Envelope<T>>) {}
  send(to: string | undefined, payload: T) { this.wire.send(to,{from:this.id,session:this.session,payload}); }
  drain() { return this.wire.drain().filter(m=>m.session===this.session).map(m=>m.payload); }
  close() {}
}
async function main() {
  const file=process.argv[2],id=process.argv[3];
  if(!file||!id) throw new Error("usage: edge-agent CONFIG.json ROBOT_ID");
  const endpoints=JSON.parse(readFileSync(file,"utf8")) as EdgeEndpoint[];
  const self=endpoints.find(p=>p.id===id); if(!self)throw new Error("Unknown self");
  const bind=process.env.EDGE_BIND??"127.0.0.1",token=process.env.EDGE_TOKEN;
  if(bind!=="127.0.0.1"&&!token)throw new Error("EDGE_TOKEN is required for non-loopback control");
  const transportKind = process.env.EDGE_TRANSPORT ?? "udp";
  if (!["udp", "ros2"].includes(transportKind)) throw new Error("Unknown EDGE_TRANSPORT");
  let allocation: Wire<Envelope<OwnershipMessage>> | undefined, motion: Wire<Envelope<Message>> | undefined, bridge: RosBridge | undefined;
  if (transportKind === "udp") {
    const a = new UdpTransport<Envelope<OwnershipMessage>>(id,self.ownershipPort,
      Object.fromEntries(endpoints.filter(p=>p.id!==id).map(p=>[p.id,{host:p.host,port:p.ownershipPort}])),bind);
    const m = new UdpTransport<Envelope<Message>>(id,self.motionPort,
      Object.fromEntries(endpoints.filter(p=>p.id!==id).map(p=>[p.id,{host:p.host,port:p.motionPort}])),bind);
    await a.bind();await m.bind();allocation=a;motion=m;
  }
  let controller:EdgePeer|undefined,session="",cpuUs=0;
  let executor: Nav2Executor | undefined;
  const state=()=>{
    bridge?.refreshDiscovery();
    return {pid:process.pid,id,session,cpuUs,rssMb:process.memoryUsage().rss/1048576,
      transport:{kind:transportKind,subscriptions:bridge?.discovery},
      execution:executor ? {kind:"nav2",fault:executor.fault,feedback:executor.feedback} : {kind:"grid"},
      datagrams:{allocation:allocation?.stats,motion:motion?.stats},state:controller?.snapshot()};
  };
  const server=http.createServer(async(req,res)=>{
    res.setHeader("Content-Type","application/json");
    if(token&&req.headers.authorization!==`Bearer ${token}`){res.writeHead(401);res.end('{"error":"unauthorized"}');return;}
    try{
      if(req.method==="GET"&&req.url==="/state"){res.end(JSON.stringify(state()));return;}
      if(req.method!=="POST")throw new Error("POST required");
      let raw="";for await(const chunk of req){raw+=chunk;if(raw.length>2_000_000)throw new Error("Body too large");}
      const body=JSON.parse(raw);
      const started=process.cpuUsage();
      switch(req.url){
        case "/initialize": {
          if(executor) throw new Error("Nav2 reinitialization requires physical executor restart/relocalization");
          const config=body.config as EdgeConfig;
          if(typeof body.session!=="string"||!body.session||config.self.id!==id||
            JSON.stringify([...config.members].sort())!==JSON.stringify(endpoints.map(p=>p.id).sort()))throw new Error("Invalid session membership");
          session=body.session;
          if(transportKind==="ros2") {
            controller=undefined;bridge?.close();
            const command=JSON.parse(process.env.ROS_BRIDGE_COMMAND ?? '["podman","run","--rm","-i","--network=host","-e","ROS_DOMAIN_ID=83","localhost/teamrocket-ros2:jazzy"]');
            if(!Array.isArray(command)||!command.length||command.some(v=>typeof v!=="string"))throw new Error("ROS_BRIDGE_COMMAND must be a JSON argv array");
            bridge=await RosBridge.start({id,members:endpoints.map(p=>p.id),session,command});
            allocation=bridge.channel("ownership");motion=bridge.channel("motion");
          }
          allocation!.drain();motion!.drain();
          for(const p of endpoints){allocation!.setReachable(p.id,true);motion!.setReachable(p.id,true);}
          controller=new EdgePeer(config,new SessionTransport(id,session,allocation!),new SessionTransport(id,session,motion!));
          if(process.env.NAV2_EXECUTOR_BASE_PORT) {
            executor=new Nav2Executor(`http://127.0.0.1:${Number(process.env.NAV2_EXECUTOR_BASE_PORT)+endpoints.indexOf(self)}`,session);
            await executor.initialize(config.self.position,config.map);
          }
          cpuUs=0;break;
        }
        case "/prepare": {
          if(!controller||body.session!==session)throw new Error("Wrong session");
          const position=controller.world.robots[0].position;
          if(!Array.isArray(body.contacts)||body.contacts.some((p:{x:number;y:number})=>!Number.isInteger(p.x)||!Number.isInteger(p.y)||Math.abs(p.x-position.x)+Math.abs(p.y-position.y)>2))throw new Error("Only local sensor contacts accepted");
          if(executor && body.blocks?.length) throw new Error("Dynamic grid blocks are unsupported by the Nav2 physical-map adapter");
          controller.prepare(body.tick,body.contacts,body.blocks??[]);break;
        }
        case "/propose":
          if(!controller||body.session!==session)throw new Error("Wrong session");
          controller.propose(body.tick);break;
        case "/commit":
          if(!controller||body.session!==session)throw new Error("Wrong session");
          if(executor) await controller.commitExecuted(body.tick,(from,to)=>executor!.execute(from,to));
          else controller.commit(body.tick);break;
        case "/link":
          if(!endpoints.some(p=>p.id===body.peer)||typeof body.reachable!=="boolean")throw new Error("Invalid link");
          allocation!.setReachable(body.peer,body.reachable);motion!.setReachable(body.peer,body.reachable);break;
        case "/announce": {
          if(!controller)throw new Error("Not initialized");
          const t=body.task;
          if(!t||typeof t.id!=="string"||!t.id||t.status!=="pending"||t.assignedRobotId||!Number.isFinite(t.weight)||t.weight<0||
            !Number.isFinite(t.priority)||!Number.isInteger(t.createdAt)||
            ![t.pickup,t.dropoff].every(p=>p&&controller!.world.map.cells.some(c=>!c.blocked&&c.position.x===p.x&&c.position.y===p.y)))throw new Error("Invalid task");
          controller.ownership.announce(t);break;
        }
        case "/ai":
          if(!controller||typeof body.enabled!=="boolean")throw new Error("Invalid AI control");
          controller.aiEnabled=body.enabled;break;
        default:throw new Error("Unknown command");
      }
      const cpu=process.cpuUsage(started);cpuUs+=cpu.user+cpu.system;res.end(JSON.stringify(state()));
    }catch(e){res.writeHead(400);res.end(JSON.stringify({error:String(e)}));}
  });
  server.listen(self.controlPort,bind,()=>process.stdout.write(JSON.stringify({ready:true,id,pid:process.pid})+"\n"));
  const stop=()=>{server.close();allocation?.close();motion?.close();bridge?.close();};
  process.on("SIGTERM",async()=>{
    if(executor) { try { await executor.revoke(); } catch { /* no physical-stop claim */ } }
    stop();process.exit(0);
  });
}
main().catch(e=>{console.error(e);process.exitCode=1;});
