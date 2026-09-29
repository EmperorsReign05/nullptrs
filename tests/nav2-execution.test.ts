import {expect,it,vi} from 'vitest';
import {EdgePeer} from '../src/core/distributed/edge-peer';
import {InMemoryBus,InMemoryTransport} from '../src/core/distributed/transport';
import type {OwnershipMessage} from '../src/core/distributed/ownership';
import type {Message} from '../src/core/distributed/protocol';
import {edgeChokeScenario} from '../src/core/bench/edge-choke';
function peers(){
  const s=edgeChokeScenario(23000,'negotiated');const a=new InMemoryBus<OwnershipMessage>(),m=new InMemoryBus<Message>();
  return s.configs.map(c=>{const at=new InMemoryTransport(c.self.id,a),mt=new InMemoryTransport(c.self.id,m);c.members.filter(id=>id!==c.self.id).forEach(id=>{at.addPeer(id);mt.addPeer(id);});return new EdgePeer(c,at,mt);});
}
function prepare(ps:EdgePeer[],tick:number){ps.forEach(p=>p.prepare(tick,ps.filter(q=>p!==q).map(q=>q.world.robots[0].position)));ps.forEach(p=>p.propose(tick));}
it('external execution cannot advance logical pose or task until measured arrival resolves',async()=>{
 const ps=peers();for(let t=0;t<112;t++){prepare(ps,t);ps.forEach(p=>p.commit(t));}prepare(ps,112);
 const p=ps[0],before=p.snapshot();let done!:()=>void;const wait=new Promise<void>(r=>done=r);const execute=vi.fn(()=>wait);
 const pending=p.commitExecuted(112,execute);expect(execute).toHaveBeenCalledOnce();expect(p.snapshot()).toEqual(before);
 await expect(p.commitExecuted(112,execute)).rejects.toThrow('in flight');expect(()=>p.commit(112)).toThrow('in flight');expect(()=>p.prepare(113,[])).toThrow();
 done();await pending;expect(p.metrics.moves).toBeGreaterThan(0);
});
it('rejected or partial execution never settles arrival and latches future phases',async()=>{
 const ps=peers();for(let t=0;t<112;t++){prepare(ps,t);ps.forEach(p=>p.commit(t));}prepare(ps,112);const p=ps[0],before=p.snapshot();
 await expect(p.commitExecuted(112,async()=>{throw new Error('partial pose');})).rejects.toThrow('partial pose');
 expect(p.snapshot()).toEqual(before);expect(()=>p.prepare(113,[])).toThrow();await expect(p.commitExecuted(112,async()=>{})).rejects.toThrow('in flight');
});
it('inactive peer cannot dispatch a stale moving decision',async()=>{
 const p=peers()[0];p.prepare(0,[]);p.propose(0);const agent=p.fleet.getAgent(p.config.self.id)!;
 const from=p.world.robots[0].position;agent.overrideDecision({from,to:{x:from.x+1,y:from.y},reason:'no-move'});
 const execute=vi.fn(async(a,b)=>{expect(b).toEqual(a);});await p.commitExecuted(0,execute);expect(p.metrics.moves).toBe(0);
});
