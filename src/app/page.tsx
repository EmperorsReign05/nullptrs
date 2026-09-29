'use client';
import { useEffect, useState } from 'react';
import { WarehouseMap, FleetStatus, ActiveTasks, EventLog, MetricsBar } from '@/components/dashboard';
import type { FleetRuntime, RuntimeCommand } from '@/core/distributed/runtime';
type Snapshot = ReturnType<FleetRuntime['snapshot']> & {
  execution?: { robotId: string; kind?: string; fault?: string | null;
    feedback?: { pose?: { x: number; y: number } | null; actions?: number; collisions?: number } | null }[];
};
export default function Page() {
  const [state, setState] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try { const response = await fetch('/api/fleet', { cache: 'no-store' }); if (!response.ok) throw new Error('Telemetry unavailable');
        const data = await response.json(); if (!disposed) { setState(data); setError(''); }
      } catch (e) { if (!disposed) setError(String(e)); }
    };
    void refresh(); const timer = setInterval(refresh, 500);
    return () => { disposed = true; clearInterval(timer); };
  }, []);
  const command = async (input: RuntimeCommand) => {
    try { const response = await fetch('/api/fleet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error); setState(data);
    } catch (e) { setError(String(e)); }
  };
  if (!state) return <main className="p-8">Connecting to fleet runtime… {error}</main>;
  const { world } = state;
  const live = world.robots.filter(r => r.status !== 'failed');
  const candidate = world.map.cells.find(c => !c.blocked && !world.robots.some(r => r.position.x === c.position.x && r.position.y === c.position.y) && world.robots.some(r => r.path.slice(1).some(p => p.x === c.position.x && p.y === c.position.y)));
  const button = 'rounded border border-zinc-600 px-3 py-2 hover:bg-zinc-800 disabled:opacity-40';
  return <main className="min-h-screen bg-zinc-950 text-zinc-100 p-6 space-y-4">
    <header><h1 className="text-2xl">Fleet runtime</h1><p className="text-zinc-400">{state.deployment} · tick {world.tick}</p>
      <a href="/simulator" className="underline">Open the separate central PIBT simulator</a></header>
    {error && <p role="alert" className="text-red-400">{error}</p>}
    <div className="flex flex-wrap gap-2">
      <button className={button} onClick={() => command({ kind: state.running ? 'pause' : 'run' })}>{state.running ? 'Pause fleet' : 'Run fleet'}</button>
      <button className={button} onClick={() => command({ kind: state.aiEnabled ? 'ai-off' : 'ai-on' })}>{state.aiEnabled ? 'Disable' : 'Enable'} learned bids</button>
      <button className={button} disabled={!live.length} onClick={() => command({ kind: 'task', task: { id: `UI-${Date.now()}`, pickup: { x: 6, y: 2 }, dropoff: { x: 12, y: 10 }, weight: 10, status: 'pending', createdAt: world.tick, priority: 1 } })}>Announce task</button>
      <button className={button} disabled={!candidate} onClick={() => candidate && command({ kind: 'block', position: candidate.position, blocked: true })}>Block a route cell</button>
      <button className={button} disabled={!live.length} onClick={() => command({ kind: 'fail', robotId: selected ?? live[0].id })}>Fail selected robot</button>
      <button className={button} disabled={live.length < 2} onClick={() => command({ kind: 'link', a: live[0].id, b: live[1].id, reachable: false })}>Sever live peer link</button>
      <button className={button} onClick={() => command({ kind: 'heal' })}>Heal links</button>
    </div>
    <p className="text-sm text-zinc-400">Bids with AI: {state.metrics.aiBidAttempts} · nonzero corrections: {state.metrics.nonzeroCorrections} · deterministic fallbacks: {state.metrics.disabledFallbacks + state.metrics.failedModelFallbacks} · observed overlaps: {state.safety.overlaps}</p>
    <div className="grid lg:grid-cols-3 gap-4"><div className="lg:col-span-2"><WarehouseMap robots={world.robots} map={world.map} selectedRobotId={selected} onSelectRobot={setSelected} shelfColCount={6} tooltips={[]} /></div>
      <FleetStatus robots={world.robots} selectedRobotId={selected} onSelectRobot={setSelected} /></div>
    {state.execution?.some(e => e.kind === 'nav2') && <section aria-label="Nav2 execution" className="rounded border border-zinc-700 p-3">
      <h2>Continuous simulation — Nav2 execution</h2>
      <p className="text-sm text-zinc-400">Measured positions below use each robot’s local map frame in metres. The grid advances only after arrival is confirmed.</p>
      <ul>{state.execution.map(e => <li key={e.robotId}>
        {e.robotId}: {e.fault ? `stopped: ${e.fault}` : e.kind ?? 'unavailable'}
        {e.feedback?.pose && ` · measured (${e.feedback.pose.x.toFixed(2)}, ${e.feedback.pose.y.toFixed(2)}) m`}
        {e.feedback?.actions !== undefined && ` · path actions: ${e.feedback.actions}`}
        {e.feedback?.collisions !== undefined && ` · observed collision ticks: ${e.feedback.collisions}`}
      </li>)}</ul>
    </section>}
    <MetricsBar tasks={world.tasks} robots={world.robots} metrics={world.metrics} />
    <ActiveTasks tasks={world.tasks} robots={world.robots} />
    <p>Manual load recovery required: {state.ownership.flatMap(p => p.tasks.filter(t => t.recoveryRequired).map(t => t.taskId)).filter((id, i, all) => all.indexOf(id) === i).join(', ') || 'none'}</p>
    <EventLog logs={state.events.map(e => ({ time: `tick ${e.tick}`, text: e.text, type: 'info' as const }))} />
    <p className="text-sm text-zinc-500">Simulated sensors and shared tick rounds. Closing this page does not stop the robot controllers. Physical robots and edge hardware remain unvalidated.</p>
  </main>;
}
