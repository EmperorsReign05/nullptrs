import type { Task, Position } from '../types';
import type { LocalBidInput } from '../ml/bidfeatures';
import { assessBidEnergy, localBidView } from '../ml/bidfeatures';
import { makeLocalBid, type BidModel } from '../ml/bidmodel';
import { planPath } from '../pathfinding/astar';
import { BATTERY_PERCENT_PER_CELL } from '../simulation/robotModels';

export const GROUP_LIMIT = 4;
export type BundleOffer = { taskIds: string[]; cost: number; requiredEnergy: number; battery: number; completionEtas: number[] };
export type GroupBid = { robotId: string; generation: number; groupId: string; taskIds: string[]; tick: number; commitmentIds: string[]; offers: BundleOffer[] };
export type GroupAssignment = { owner: string; taskIds: string[] };
const distance = (a: Position,b: Position)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
export const priorityOrder = (a: Task,b: Task)=>b.priority-a.priority || a.createdAt-b.createdAt || a.id.localeCompare(b.id);
/** Only immutable announced task data; no fleet or future state. */
export function orderGroup(tasks: readonly Task[]): Task[] {
  const left=[...tasks].sort(priorityOrder), result: Task[]=[];
  while(left.length) {
    if(result.length) {
      const anchor=result[result.length-1];
      left.sort((a,b)=>distance(anchor.pickup,a.pickup)+distance(anchor.dropoff,a.dropoff)-distance(anchor.pickup,b.pickup)-distance(anchor.dropoff,b.dropoff) || priorityOrder(a,b));
    }
    result.push(left.shift()!);
  }
  return result;
}
export const groupIdentity=(generation: number,tasks: readonly Task[])=>JSON.stringify([generation,orderGroup(tasks).map(t=>t.id)]);
export function taskGroups(tasks: readonly Task[]): Task[][] {
  const ordered=orderGroup(tasks), groups: Task[][]=[];
  for(let i=0;i<ordered.length;i+=GROUP_LIMIT) groups.push(orderGroup(ordered.slice(i,i+GROUP_LIMIT)));
  return groups;
}
/** Correct full queued ETA, actual active route, every delivery prefix and charger reserve.
 * Hypothetical soft bids use the existing frozen scorer; no model retraining. */
export function bundleOffer(input: LocalBidInput, tasks: readonly Task[], model: BidModel, bound: number): BundleOffer | undefined {
  if(!tasks.length || new Set(tasks.map(t=>t.id)).size!==tasks.length) return;
  const {world}=localBidView(input), self=world.robots[0];
  const commitments=[...(self.currentTaskId?[self.currentTaskId]:[]),...(self.queuedTaskIds??[])];
  if(commitments.length+tasks.length>5 || tasks.some(t=>commitments.includes(t.id))) return;
  // Append preceding bundle jobs to the admission queue; the last job certifies
  // the active route + original queue + all preceding bundle jobs atomically.
  const staged={...self,queuedTaskIds:[...(self.queuedTaskIds??[]),...tasks.slice(0,-1).map(t=>t.id)]};
  const energy=assessBidEnergy(staged,tasks[tasks.length-1],{...world,tasks:[...world.tasks,...tasks]});
  if(!energy.admitted) return;
  let position=self.position, elapsed=0;
  const leg=(to: Position)=>{ const path=planPath(position,to,world); if(!path.found)return false; elapsed+=path.distance; position=to; return true; };
  for(const id of commitments) {
    const task=world.tasks.find(t=>t.id===id); if(!task)return;
    if(id===self.currentTaskId) {
      elapsed+=Math.max(0,self.path.length-1); position=task.status==='in_progress'?task.dropoff:task.pickup;
      if(task.status!=='in_progress'&&!leg(task.dropoff))return;
    } else if(!leg(task.pickup)||!leg(task.dropoff))return;
  }
  let cost=0; const completionEtas:number[]=[];
  for(const task of tasks) {
    const hypothetical={...self,position,battery:self.battery-elapsed*BATTERY_PERCENT_PER_CELL,currentTaskId:undefined,queuedTaskIds:[],path:[],status:'idle' as const};
    const packet=makeLocalBid({...input,self:hypothetical,ownTasks:[],task},model,bound);
    if(!packet.bid || packet.mlCost===null)return;
    if(!leg(task.pickup)||!leg(task.dropoff))return;
    completionEtas.push(elapsed);
    cost+=packet.mlCost+elapsed*(1+Math.max(0,task.priority));
    if(task.deadline!==undefined) cost+=Math.max(0,input.tick+elapsed-task.deadline)*(1+Math.max(0,task.priority));
  }
  return {taskIds:tasks.map(t=>t.id),cost,requiredEnergy:energy.requiredEnergy,battery:self.battery,completionEtas};
}
export function groupBid(input: LocalBidInput, tasks: readonly Task[], generation: number, model: BidModel, bound: number): GroupBid {
  const ordered=orderGroup(tasks),offers:BundleOffer[]=[];
  for(let mask=1;mask<(1<<ordered.length);mask++) {
    const offer=bundleOffer(input,ordered.filter((_,i)=>mask&(1<<i)),model,bound);
    if(offer)offers.push(offer);
  }
  return {robotId:input.self.id,tick:input.tick,generation,groupId:groupIdentity(generation,ordered),taskIds:ordered.map(t=>t.id),
    commitmentIds:[...(input.self.currentTaskId?[input.self.currentTaskId]:[]),...(input.self.queuedTaskIds??[])],offers};
}
/** Exact bounded set-packing DP: maximize task coverage, then minimize bundle
 * cost; each robot gets one ordered subset and no task occurs twice. */
export function selectGroup(bids: readonly GroupBid[]): GroupAssignment[] {
  if(!bids.length)return [];
  const ids=bids[0].taskIds;
  if(ids.length>GROUP_LIMIT || new Set(ids).size!==ids.length || new Set(bids.map(b=>b.robotId)).size!==bids.length)throw new Error('Invalid group bids');
  type Plan={cost:number; assignments:GroupAssignment[]};
  let dp=new Map<number,Plan>([[0,{cost:0,assignments:[]}]]);
  const key=(p:Plan)=>JSON.stringify(p.assignments);
  for(const bid of [...bids].sort((a,b)=>a.robotId.localeCompare(b.robotId))) {
    if(bid.groupId!==bids[0].groupId || bid.generation!==bids[0].generation || JSON.stringify(bid.taskIds)!==JSON.stringify(ids))throw new Error('Mixed group');
    const next=new Map(dp);
    for(const offer of bid.offers) {
      if(!Number.isFinite(offer.cost)||offer.cost<0||!Number.isFinite(offer.requiredEnergy)||!Number.isFinite(offer.battery)||offer.requiredEnergy>offer.battery||offer.requiredEnergy<15||!offer.taskIds.length||new Set(offer.taskIds).size!==offer.taskIds.length||offer.taskIds.some(id=>!ids.includes(id))||JSON.stringify(offer.taskIds)!==JSON.stringify(ids.filter(id=>offer.taskIds.includes(id)))||offer.completionEtas.length!==offer.taskIds.length||offer.completionEtas.some(x=>!Number.isFinite(x)||x<0))throw new Error('Invalid bundle');
      const mask=offer.taskIds.reduce((m,id)=>m|(1<<ids.indexOf(id)),0);
      for(const [used,plan] of dp) if(!(used&mask)) {
        const candidate={cost:plan.cost+offer.cost,assignments:[...plan.assignments,{owner:bid.robotId,taskIds:offer.taskIds}]};
        const old=next.get(used|mask);
        if(!old || candidate.cost<old.cost || candidate.cost===old.cost&&key(candidate)<key(old))next.set(used|mask,candidate);
      }
    }
    dp=next;
  }
  const count=(mask:number)=>mask.toString(2).replaceAll('0','').length;
  return [...dp.entries()].sort(([a,x],[b,y])=>count(b)-count(a)||x.cost-y.cost||key(x).localeCompare(key(y)))[0][1].assignments;
}
