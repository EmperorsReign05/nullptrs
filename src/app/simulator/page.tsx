'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { Position, Task, WorldState } from '@/core/types';
import { createInitialWorld } from '@/core/simulation/state';
import { runDispatchTick } from '@/core/simulation/dispatch';
import { ROBOT_MODELS } from '@/core/simulation/robotModels';
import {
  Header,
  WarehouseMap,
  ControlPanel,
  MetricsBar,
  FleetStatus,
  ActiveTasks,
  EventLog,
  type LogEntry,
  type MapTooltip
} from '@/components/dashboard';

// x=6 is a single-cell-wide open corridor for its entire height (no shelf
// ever occupies that column) — the narrowest possible stage for a head-on
// encounter neither robot can just step around.
const CONFLICT_CORRIDOR_TOP: Position = { x: 6, y: 1 };
const CONFLICT_CORRIDOR_BOTTOM: Position = { x: 6, y: 11 };

// x=12,13,14 are three consecutive fully-open columns (the gap between the
// col4 and col5 shelf racks) — this 2x2 box sits inside that open area,
// clear of the waiting zones and intersections nearby.
const DEADLOCK_BOX: Position[] = [
  { x: 12, y: 1 },
  { x: 13, y: 1 },
  { x: 13, y: 2 },
  { x: 12, y: 2 },
];

// A true single-file stretch: shelves flank both sides of x=9 at rows 5-7,
// so blocking it forces a real detour rather than just a sidestep.
const AISLE_BLOCK_CELLS: Position[] = [
  { x: 9, y: 5 },
  { x: 9, y: 6 },
  { x: 9, y: 7 },
];

// Any task a repurposed demo robot was holding (current or queued) goes
// back to "pending" so it re-enters the auction instead of being silently
// abandoned mid-flight, referencing a robot that's now doing something else.
function releaseRobotTasks(tasks: Task[], robotIds: Set<string>): Task[] {
  return tasks.map((t) =>
    t.assignedRobotId && robotIds.has(t.assignedRobotId) && t.status !== 'completed'
      ? { ...t, status: 'pending' as const, assignedRobotId: undefined }
      : t
  );
}

// A synthetic task that pins a demo robot to a target cell — pickup and
// dropoff are the same cell, so arriving there completes it in two ticks
// flat (one to register the pickup, one to register the dropoff at the
// same position). Its status starts "assigned", not "pending": the whole
// point is that it's NOT up for auction and can't be reassigned out from
// under the robot. Earlier version of this demo just set the robot idle
// and pointed its `home` at the target — which meant the very next
// runDispatchTick's auction round could (and, verified live, reliably
// did) immediately hijack an "idle" demo robot into a real pending task
// before the staged encounter ever got a chance to play out. A robot with
// a currentTaskId keeps working that task no matter what it wins in the
// same auction round — winning something else just appends to its queue.
function makeDemoTask(robotId: string, target: Position, tick: number): Task {
  return {
    id: `DEMO-${robotId}-${tick}-${Math.random().toString(36).slice(2, 7)}`,
    pickup: target,
    dropoff: target,
    weight: 1,
    createdAt: tick,
    priority: 5,
    status: 'assigned',
    assignedRobotId: robotId,
  };
}

const TOOLTIP_LIFETIME_MS = 2200;

// Which robot to point the tooltip at, and what to say — derived from a
// real state transition PIBT just made (a robot that only just became
// "waiting" this tick), not a guess: it's the robot the algorithm chose to
// hold back in favor of someone else, right as it made that choice.
function findYieldingRobots(prevWorld: WorldState, nextWorld: WorldState): { robotId: string; position: Position }[] {
  const prevById = new Map(prevWorld.robots.map((r) => [r.id, r]));
  const yielded: { robotId: string; position: Position }[] = [];
  for (const r of nextWorld.robots) {
    const prevR = prevById.get(r.id);
    if (prevR && prevR.status !== 'waiting' && r.status === 'waiting') {
      yielded.push({ robotId: r.id, position: r.position });
    }
  }
  return yielded;
}

const INITIAL_LOGS: LogEntry[] = [
  { time: '14:32:00', text: 'simulation engine ready (a* + pibt active)', type: 'info' },
  { time: '14:31:45', text: 'amr-02 assigned to t-102', type: 'info' },
  { time: '14:31:12', text: 'amr-03 assigned to t-103', type: 'info' },
  { time: '14:30:05', text: 'warehouse grid and congestion field initialized', type: 'info' },
  { time: '14:27:10', text: 'task t-104 queued pending', type: 'info' },
  { time: '14:25:00', text: 'system initialized with live worldstate', type: 'info' },
];

export default function Dashboard() {
  const [world, setWorld] = useState<WorldState>(() => {
    const initial = createInitialWorld();
    return {
      ...initial,
      robots: initial.robots.map((r) => 
        r.id === 'AMR-03' ? { ...r, home: { x: 1, y: 5 } } : r
      )
    };
  });
  const [logs, setLogs] = useState<LogEntry[]>(INITIAL_LOGS);
  const [isSimulating, setIsSimulating] = useState(false);
  const [robotCount, setRobotCount] = useState(() => createInitialWorld().robots.length);
  const [shelfColCount, setShelfColCount] = useState(6);
  const [selectedRobotId, setSelectedRobotId] = useState<string | null>(null);
  const [aisleBlocked, setAisleBlocked] = useState(false);
  const [conflictTooltips, setConflictTooltips] = useState<MapTooltip[]>([]);

  const addLog = useCallback((text: string, type: 'info' | 'warning' | 'error' = 'info') => {
    const now = new Date();
    setLogs((prev) => [...prev, { time: now.toLocaleTimeString('en-GB', { hour12: false }), text, type }]);
  }, []);

  // Mirrors `world` for the tick loop below. A setState updater function
  // isn't guaranteed to run exactly once (React may invoke it more than
  // once, e.g. under StrictMode in dev) — fine for a pure state transition,
  // but the tick loop also fires real side effects (addLog, spawning
  // tooltips) off the prev/next diff, and those must run exactly once per
  // real tick. Reading/writing a ref outside the updater keeps prevWorld
  // and the side effects it drives tied to one actual tick, not to however
  // many times React happens to call the updater.
  const worldRef = useRef(world);
  useEffect(() => {
    worldRef.current = world;
  }, [world]);

  useEffect(() => {
    if (!isSimulating) return;

    const timer = setInterval(() => {
      const prevWorld = worldRef.current;
      const nextWorld = runDispatchTick(prevWorld);
      worldRef.current = nextWorld;
      setWorld(nextWorld);

      prevWorld.tasks.forEach((t) => {
        const nextT = nextWorld.tasks.find((nt) => nt.id === t.id);
        if (nextT && t.status !== nextT.status) {
          if (nextT.status === 'assigned' && t.status === 'pending') {
            addLog(`task ${nextT.id.toLowerCase()} won by ${(nextT.assignedRobotId ?? 'a robot').toLowerCase()} at auction`, 'info');
          } else if (nextT.status === 'in_progress') {
            addLog(`${(nextT.assignedRobotId ?? 'robot').toLowerCase()} reached pickup for ${nextT.id.toLowerCase()}`, 'info');
          } else if (nextT.status === 'completed') {
            addLog(`task ${nextT.id.toLowerCase()} completed at dropoff`, 'info');
          }
        }
      });

      if (nextWorld.metrics.conflictCount > prevWorld.metrics.conflictCount) {
        addLog(`pibt conflict resolved at tick ${nextWorld.tick}`, 'warning');

        // Spawn a tooltip right on the robot that actually yielded, not a
        // generic corner toast — the payoff should land exactly where the
        // audience's eyes already are.
        for (const { robotId, position } of findYieldingRobots(prevWorld, nextWorld)) {
          const tooltipId = `${robotId}-${nextWorld.tick}`;
          setConflictTooltips((prev) => [
            ...prev,
            { id: tooltipId, robotId, text: `${robotId} yields — priority inherited`, position },
          ]);
          setTimeout(() => {
            setConflictTooltips((prev) => prev.filter((t) => t.id !== tooltipId));
          }, TOOLTIP_LIFETIME_MS);
        }
      }
    }, 650);

    return () => clearInterval(timer);
  }, [isSimulating, addLog]);

  const handleCreateTask = () => {
    setWorld((prev) => {
      const taskId = `T-${105 + prev.tasks.length}`;
      const pickupLocations = [{ x: 1, y: 0 }, { x: 14, y: 0 }, { x: 3, y: 9 }, { x: 9, y: 9 }];
      const dropoffLocations = [{ x: 6, y: 12 }, { x: 17, y: 12 }, { x: 9, y: 1 }, { x: 13, y: 1 }];
      const pickup = pickupLocations[prev.tasks.length % pickupLocations.length];
      const dropoff = dropoffLocations[(prev.tasks.length + 1) % dropoffLocations.length];

      const newTask: Task = {
        id: taskId,
        pickup,
        dropoff,
        weight: Math.floor(Math.random() * 80) + 10, // 10-90kg — sometimes exceeds a Scout Agile 2.0's capacity on purpose
        createdAt: prev.tick,
        priority: 1,
        status: 'pending',
      };

      // No manual assignment here — it's just added as pending. The next
      // simulation tick's auction (see runDispatchTick) picks it up and
      // assigns it to whichever eligible robot actually bids lowest, the
      // same way every other task gets assigned.
      addLog(`task ${taskId.toLowerCase()} created (pending auction)`, 'info');
      return {
        ...prev,
        tasks: [...prev.tasks, newTask],
      };
    });
  };

  const handleToggleSimulation = () => {
    if (isSimulating) {
      addLog('simulation paused', 'warning');
    } else {
      addLog('simulation started (a* routing and pibt stepping active)', 'info');
    }
    setIsSimulating(!isSimulating);
  };

  const handleSimulateConflict = () => {
    setWorld((prev) => {
      const eligible = prev.robots.filter((r) => r.status !== 'failed');
      if (eligible.length < 2) {
        addLog('need at least 2 active robots for a conflict demo', 'error');
        return prev;
      }
      const [a, b] = eligible;
      const releasedTasks = releaseRobotTasks(prev.tasks, new Set([a.id, b.id]));
      const taskA = makeDemoTask(a.id, CONFLICT_CORRIDOR_BOTTOM, prev.tick);
      const taskB = makeDemoTask(b.id, CONFLICT_CORRIDOR_TOP, prev.tick);
      const robots = prev.robots.map((r) => {
        if (r.id === a.id) {
          return { ...r, position: CONFLICT_CORRIDOR_TOP, currentTaskId: taskA.id, queuedTaskIds: [], path: [], status: 'assigned' as const };
        }
        if (r.id === b.id) {
          return { ...r, position: CONFLICT_CORRIDOR_BOTTOM, currentTaskId: taskB.id, queuedTaskIds: [], path: [], status: 'assigned' as const };
        }
        return r;
      });
      addLog(`conflict scenario: ${a.id.toLowerCase()} and ${b.id.toLowerCase()} sent head-on down the x=6 aisle — watch pibt resolve it`, 'warning');
      return { ...prev, robots, tasks: [...releasedTasks, taskA, taskB] };
    });
  };

  const handleSimulateDeadlock = () => {
    setWorld((prev) => {
      const eligible = prev.robots.filter((r) => r.status !== 'failed');
      if (eligible.length < 4) {
        addLog('need at least 4 active robots for a deadlock demo', 'error');
        return prev;
      }
      const chosen = eligible.slice(0, 4);
      const chosenIds = new Set(chosen.map((r) => r.id));
      const releasedTasks = releaseRobotTasks(prev.tasks, chosenIds);
      // Each robot's target is the cell the next one (clockwise) starts
      // on — a pure rotation where everyone wants a cell someone else is
      // standing on, the classic case only backtracking actually solves.
      const demoTasks = chosen.map((r, idx) =>
        makeDemoTask(r.id, DEADLOCK_BOX[(idx + 1) % DEADLOCK_BOX.length], prev.tick)
      );
      const robots = prev.robots.map((r) => {
        const idx = chosen.findIndex((c) => c.id === r.id);
        if (idx === -1) return r;
        return {
          ...r,
          position: DEADLOCK_BOX[idx],
          currentTaskId: demoTasks[idx].id,
          queuedTaskIds: [],
          path: [],
          status: 'assigned' as const,
        };
      });
      addLog(`deadlock scenario: ${chosen.map((r) => r.id.toLowerCase()).join(', ')} locked in a rotation at (12-13, 1-2) — priority inheritance engaging`, 'warning');
      return { ...prev, robots, tasks: [...releasedTasks, ...demoTasks] };
    });
  };

  const handleBlockAisle = () => {
    setWorld((prev) => {
      const nextBlocked = !aisleBlocked;
      const blockedSet = new Set(AISLE_BLOCK_CELLS.map((p) => `${p.x},${p.y}`));
      const map = {
        ...prev.map,
        cells: prev.map.cells.map((cell) =>
          blockedSet.has(`${cell.position.x},${cell.position.y}`) ? { ...cell, blocked: nextBlocked } : cell
        ),
      };
      addLog(
        nextBlocked
          ? 'aisle blocked at x=9 (rows 5-7) — any robot routed through it has to replan live'
          : 'aisle cleared at x=9 — back to the shortest path',
        nextBlocked ? 'warning' : 'info'
      );
      return { ...prev, map };
    });
    setAisleBlocked((prev) => !prev);
  };

  const handleFailAMR = () => {
    setWorld((prev) => {
      const target = prev.robots.find((r) => r.id === 'AMR-02') || prev.robots[0];
      if (!target || target.status === 'failed') return prev;
      addLog(`${target.id.toLowerCase()} failure injected! pibt rerouting fleet`, 'error');
      return {
        ...prev,
        robots: prev.robots.map((r) =>
          r.id === target.id ? { ...r, status: 'failed' as const, path: [] } : r
        ),
      };
    });
  };

  const handleReset = () => {
    const initial = createInitialWorld();
    const freshRobots = initial.robots.map((r) =>
      r.id === 'AMR-03' ? { ...r, home: { x: 1, y: 5 } } : r
    );
    setWorld({ ...initial, robots: freshRobots });
    setIsSimulating(false);
    setRobotCount(freshRobots.length);
    setShelfColCount(6);
    setSelectedRobotId(null);
    setAisleBlocked(false);
    setConflictTooltips([]);
    addLog('system state reset to initial conditions', 'info');
  };

  const handleRobotCountChange = (newCount: number) => {
    setRobotCount(newCount);
    setWorld((prev) => {
      if (newCount > prev.robots.length) {
        // Open, non-shelf cells clear of every station, intersection,
        // waiting zone, and the seeded fleet's own start positions —
        // enough headroom to grow well past the default 10-robot seed.
        const safeSpawns = [
          { x: 0, y: 0 }, { x: 0, y: 8 }, { x: 0, y: 12 },
          { x: 3, y: 6 }, { x: 6, y: 1 }, { x: 6, y: 11 },
          { x: 9, y: 7 }, { x: 9, y: 12 }, { x: 12, y: 1 },
          { x: 13, y: 12 }, { x: 14, y: 6 }, { x: 17, y: 9 },
        ];
        const startIndex = prev.robots.length;
        const newRobots = [...prev.robots];
        for (let i = startIndex; i < newCount; i++) {
          // Relative to where this batch starts, not a hardcoded base
          // fleet size — correct no matter how many robots already exist.
          const spawnIdx = (i - startIndex) % safeSpawns.length;
          const pos = safeSpawns[spawnIdx];
          newRobots.push({
            id: `AMR-${(i + 1).toString().padStart(2, '0')}`,
            position: pos,
            home: pos,
            battery: Math.floor(Math.random() * 30) + 70,
            status: 'idle',
            model: ROBOT_MODELS[i % ROBOT_MODELS.length],
            path: [],
            priority: 0,
          });
        }
        return { ...prev, robots: newRobots };
      } else if (newCount < prev.robots.length) {
        return { ...prev, robots: prev.robots.slice(0, newCount) };
      }
      return prev;
    });
  };

  return (
    <div className="min-h-screen bg-[#09090b] text-[#fafafa] bg-[url('/bg.png')] bg-cover bg-fixed bg-center font-sans py-6 px-4 md:px-8 lg:px-12 flex justify-center items-start selection:bg-[#C9F27D]/30">
      <div className="w-full max-w-[1520px] bg-black/40 backdrop-blur-2xl rounded-2xl border border-zinc-800/80 shadow-[0_25px_70px_-15px_rgba(0,0,0,0.85)] flex flex-col overflow-hidden">
        <Header />

        <div className="p-4 flex gap-4">
          <div className="w-[72%] flex flex-col gap-4 min-w-0">
            <WarehouseMap
              robots={world.robots}
              selectedRobotId={selectedRobotId}
              onSelectRobot={setSelectedRobotId}
              shelfColCount={shelfColCount}
              map={world.map}
              tooltips={conflictTooltips}
            />

            <div className="shrink-0 flex flex-col gap-4">
              <ControlPanel
                isSimulating={isSimulating}
                robotCount={robotCount}
                shelfColCount={shelfColCount}
                aisleBlocked={aisleBlocked}
                onCreateTask={handleCreateTask}
                onToggleSimulation={handleToggleSimulation}
                onSimulateConflict={handleSimulateConflict}
                onSimulateDeadlock={handleSimulateDeadlock}
                onFailAMR={handleFailAMR}
                onBlockAisle={handleBlockAisle}
                onReset={handleReset}
                onRobotCountChange={handleRobotCountChange}
                onShelfColCountChange={setShelfColCount}
              />

              <MetricsBar 
                tasks={world.tasks}
                robots={world.robots}
                metrics={world.metrics}
              />
            </div>
          </div>

          <div className="w-[28%] flex flex-col gap-4 min-w-0">
            <FleetStatus 
              robots={world.robots}
              selectedRobotId={selectedRobotId}
              onSelectRobot={setSelectedRobotId}
            />

            <ActiveTasks 
              tasks={world.tasks}
              robots={world.robots}
            />

            <EventLog logs={logs} />
          </div>
        </div>
      </div>
    </div>
  );
}
