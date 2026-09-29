import type { Position, WarehouseMap } from "../core/types";
/** Trusted loopback adapter for lockstep continuous simulation, not a physical
 * wall-clock ownership lease. Failure latches until reinitialization. */
export class Nav2Executor {
  fault: string | null = null;
  feedback: unknown = null;
  private heartbeat?: ReturnType<typeof setInterval>;
  constructor(readonly url: string, readonly session: string) {}
  private async request(route: string, body: unknown) {
    const response = await fetch(this.url + route, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
    const result = await response.json(); this.feedback = result;
    if (!response.ok || !result.ok) throw new Error(JSON.stringify(result));
    return result;
  }
  async initialize(origin: Position, map: WarehouseMap) {
    await this.request('/initialize',{session:this.session,origin,cellMetres:0.6,map});
    this.heartbeat=setInterval(()=>{void this.request('/heartbeat',{session:this.session}).catch(error=>{this.fault=String(error);});},400);this.heartbeat.unref();
  }
  async revoke() { if(this.heartbeat)clearInterval(this.heartbeat);return this.request('/cancel',{}); }
  async execute(from: Position, to: Position) {
    if (this.fault) throw new Error(this.fault);
    try { await this.request('/execute',{session:this.session,from,to}); }
    catch(error) { this.fault=String(error); throw error; }
  }
}
