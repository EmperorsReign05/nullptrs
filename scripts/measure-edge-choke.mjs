import { readFile, writeFile, mkdir } from "node:fs/promises";
import { EdgeSimulation, startAgents } from "./edge-sim.mjs";
const accepting=process.argv.includes("--accept");
const remote=process.argv.find(a=>a.startsWith("--endpoints="))?.split("=")[1];
const endpoints=remote?JSON.parse(await readFile(remote,"utf8")):[0,1,2].map(i=>({id:`AMR-0${i+1}`,host:"127.0.0.1",controlPort:17401+i,ownershipPort:17501+i,motionPort:17601+i}));
const dir="artifacts/edge-choke-v1";await mkdir(dir,{recursive:true});
const protocol={mode:accepting?"acceptance":"development",seedStart:accepting?24000:23000,seeds:accepting?40:4,
  fleetSize:3,horizon:512,motionStartTick:112,map:"two rooms, sole bridge cell (9,6), charger stubs do not bypass bridge",
  tasks:"three opposing journeys, announced to only AMR-01; distributed auction; simultaneous motion release",
  allocation:"same frozen guarded MLP and quorum ownership in both arms",energy:"same per-move remaining-work + charging + reserve gate",
  motion:"fresh pose/desired-step exchange, then proposals and local confirmation; negotiated head-on winner holds while loser yields; baseline preferred-cell-only",
  sharedPlanning:"same A*, obstruction memory including unknown-contender safety envelope, and per-move energy gate",
  deployment:remote?"provided endpoints; hardware identity must be verified separately":"three OS processes on this host, peer-to-peer UDP, simulated sensors/time",
  controls:"physics host advances time, supplies local contacts, audits moves; no route or movement-winner computation",
  performance:"both-completed pairs only; end-to-end and motion-window ticks; capped failures excluded",
  hardwareValidated:false,network:"connected; 8ms delivery opportunity, unknown/late contender means local hold; no delivery guarantee",
  modelRetrained:false};
await writeFile(`${dir}/${protocol.mode}-protocol.json`,JSON.stringify(protocol,null,2)+"\n");
const local=remote?null:await startAgents(endpoints),rows=[];
const average=a=>a.length?a.reduce((a,b)=>a+b,0)/a.length:null;
const median=a=>{if(!a.length)return null;const s=[...a].sort((a,b)=>a-b),i=Math.floor(s.length/2);return s.length%2?s[i]:(s[i-1]+s[i])/2;};
try {
  for(let i=0;i<protocol.seeds;i++){
    const seed=protocol.seedStart+i,pair={seed};
    // Alternate execution order so OS warmup is not assigned to one policy.
    for(const policy of i%2?["negotiated","stop-and-wait"]:["stop-and-wait","negotiated"]){
      const sim=new EdgeSimulation(endpoints);await sim.initialize(seed,policy,`${Date.now()}-${seed}-${policy}`);
      while(sim.tick<protocol.horizon&&sim.snapshot().world.tasks.some(t=>t.status!=="completed"))await sim.step();
      pair[policy]=sim.result();
    }
    rows.push(pair);console.log(JSON.stringify({seed,baseline:[pair["stop-and-wait"].completedTasks,pair["stop-and-wait"].ticks],negotiated:[pair.negotiated.completedTasks,pair.negotiated.ticks]}));
    await writeFile(`${dir}/${protocol.mode}-rows.json`,JSON.stringify(rows,null,2)+"\n");
  }
  const paired=rows.filter(r=>r.negotiated.completed&&r["stop-and-wait"].completed);
  const performance=field=>{
    const b=paired.map(r=>r["stop-and-wait"][field]),n=paired.map(r=>r.negotiated[field]),d=b.map((v,i)=>v-n[i]);
    let state=984521;const random=()=>((state=(Math.imul(state,1664525)+1013904223)>>>0)/4294967296),boot=[];
    if(paired.length)for(let j=0;j<10000;j++){let sum=0,base=0;for(let k=0;k<paired.length;k++){const i=Math.floor(random()*paired.length);sum+=d[i];base+=b[i];}boot.push(100*sum/base);}
    boot.sort((a,b)=>a-b);
    return {pairs:paired.length,baselineMean:average(b),negotiatedMean:average(n),meanTicksSaved:average(d),medianTicksSaved:median(d),
      improvementPercent:paired.length?100*average(d)/average(b):null,improvement95CI:boot.length?[boot[250],boot[9750]]:null,
      wins:d.filter(x=>x>0).length,ties:d.filter(x=>x===0).length,losses:d.filter(x=>x<0).length};
  };
  const summary={byPolicy:Object.fromEntries(["stop-and-wait","negotiated"].map(p=>[p,{
    completedRuns:rows.filter(r=>r[p].completed).length,completedTasks:rows.reduce((a,r)=>a+r[p].completedTasks,0),
    runsAllThreeCrossed:rows.filter(r=>r[p].allThreeCrossed).length,runsAllThreeAssignedAtRelease:rows.filter(r=>r[p].allThreeAssignedAtRelease).length,
    safety:Object.fromEntries(Object.keys(rows[0][p].safety).map(k=>[k,rows.reduce((a,r)=>a+r[p].safety[k],0)])),
  }])),endToEnd:performance("ticks"),motionWindow:performance("motionTicks")};
  await writeFile(`${dir}/${protocol.mode}-report.json`,JSON.stringify({protocol,summary},null,2)+"\n");
  console.log(JSON.stringify(summary,null,2));
}finally{await local?.close();}
