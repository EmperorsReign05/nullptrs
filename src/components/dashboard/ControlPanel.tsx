'use client';

import React, { useRef, useState } from 'react';
import { Plus, Play, Pause, AlertTriangle, XOctagon, AlertCircle, RefreshCw } from 'lucide-react';
import { RollingText } from './RollingText';

interface ControlPanelProps {
  isSimulating: boolean;
  simulationPending?: boolean;
  amrFailed?: boolean;
  failurePending?: boolean;
  /** The robot the fail/recover button acts on, so its label never names another. */
  failTargetId?: string;
  robotCount: number;
  /** Largest fleet the runtime can actually build. */
  maxRobots?: number;
  shelfColCount: number;
  aisleBlocked: boolean;
  aislePending?: boolean;
  onCreateTask: () => void;
  onToggleSimulation: () => void;
  onSimulateConflict: () => void;
  onSimulateDeadlock: () => void;
  /**
   * Controls that have no honest implementation on the distributed runtime, with
   * the one-line reason to show on them.
   *
   * These used to render as fully enabled primary-styled buttons whose only
   * effect was to append an internal error string to the event log. On a demo
   * screen that is the worst of both worlds: it looks live, it accepts the
   * click, and it does nothing. A disabled control with a visible reason is
   * honest and is also a standing to-do list. Keyed by prop name.
   */
  unavailable?: Partial<Record<'simConflict' | 'simDeadlock' | 'reset' | 'robotCount' | 'shelfColCount', string>>;
  onFailAMR: () => void;
  onBlockAisle: () => void;
  onReset: () => void;
  onRobotCountChange: (count: number) => void;
  onShelfColCountChange: (count: number) => void;
}

/** Keyboard steps settle for this long before committing, so holding an arrow key is one restart. */
const KEY_COMMIT_MS = 450;

/**
 * A range input that commits once, when the user lets go.
 *
 * Every commit rebuilds the fleet. Committing on `onChange` fired one restart
 * per value crossed — a drag from 3 to 14 built eleven runtimes — and each poll
 * that landed mid-drag reset the controlled value under the user's thumb. The
 * draft is local while dragging; the committed value comes from the server.
 */
function CommitSlider({ value, min, max, onCommit, disabledReason, label }: {
  value: number; min: number; max: number; onCommit: (v: number) => void; disabledReason?: string; label: string;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const keyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shown = draft ?? value;
  const commit = (v: number | null) => {
    if (keyTimer.current) { clearTimeout(keyTimer.current); keyTimer.current = null; }
    setDraft(null);
    if (v !== null && v !== value) onCommit(v);
  };
  return (
    <div className="flex-1 flex items-center gap-3">
      <label className="text-[12px] text-zinc-300 tracking-wider whitespace-nowrap w-24">
        {label} (<RollingText className="text-zinc-100 font-semibold" value={shown} />)
      </label>
      <input
        type="range"
        min={min}
        max={max}
        value={Math.min(shown, max)}
        onChange={e => setDraft(parseInt(e.target.value))}
        onPointerUp={e => commit(parseInt((e.target as HTMLInputElement).value))}
        onKeyUp={e => {
          const v = parseInt((e.target as HTMLInputElement).value);
          if (keyTimer.current) clearTimeout(keyTimer.current);
          keyTimer.current = setTimeout(() => commit(v), KEY_COMMIT_MS);
        }}
        onBlur={() => commit(draft)}
        disabled={!!disabledReason}
        title={disabledReason}
        className={`w-full h-1.5 bg-white/[0.08] border border-white/10 rounded-lg appearance-none transition-all ${
          disabledReason ? 'cursor-not-allowed opacity-40' : 'cursor-pointer accent-[#C9F27D] hover:accent-[#C9F27D]'}`}
      />
    </div>
  );
}

/** Visibly inert, and legible as inert. Never a hover-highlight, never a pointer. */
const DISABLED =
  'bg-white/[0.02] border border-white/[0.07] text-zinc-600 px-3.5 py-2 rounded-md text-[12px] font-semibold ' +
  'tracking-wider flex items-center gap-1.5 whitespace-nowrap cursor-not-allowed select-none';

export function ControlPanel({
  isSimulating,
  simulationPending = false,
  amrFailed = false,
  failurePending = false,
  failTargetId = 'AMR-02',
  robotCount,
  maxRobots = 10,
  shelfColCount,
  aisleBlocked,
  aislePending = false,
  onCreateTask,
  onToggleSimulation,
  onSimulateConflict,
  onSimulateDeadlock,
  onFailAMR,
  onBlockAisle,
  onReset,
  onRobotCountChange,
  onShelfColCountChange,
  unavailable,
}: ControlPanelProps) {
  return (
    <div id="tour-control-panel" className="bg-[#12161F]/35 backdrop-blur-xl p-4 rounded-xl border border-white/10 flex flex-col justify-between shadow-xl">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold tracking-wide text-zinc-100">control panel</h3>
        <div className="flex items-center gap-2 text-xs text-zinc-300">
          <span className={`w-2 h-2 rounded-full ${isSimulating ? 'bg-[#C9F27D] shadow-[0_0_8px_#C9F27D] animate-pulse' : 'bg-zinc-600'}`}></span>
          <span>simulation: <RollingText className={isSimulating ? 'text-[#C9F27D]' : 'text-zinc-500'} value={isSimulating ? 'active' : 'paused'} /></span>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button 
          onClick={onCreateTask} 
          className="bg-[#C9F27D]/10 border border-[#C9F27D]/40 text-[#C9F27D] hover:bg-[#C9F27D] hover:text-[#090C11] hover:border-[#C9F27D] hover:shadow-[0_0_15px_rgba(201,242,125,0.35)] px-3.5 py-2 rounded-md text-[12px] font-semibold tracking-wider flex items-center gap-1.5 transition-all duration-150 hover:-translate-y-0.5 active:scale-95 whitespace-nowrap cursor-pointer"
        >
          <Plus size={15} strokeWidth={2.5} /> create task
        </button>
        <button 
          id="tour-start-sim"
          disabled={simulationPending}
          aria-busy={simulationPending}
          onClick={onToggleSimulation} 
          className={`border px-3.5 py-2 rounded-md text-[12px] font-semibold tracking-wider flex items-center gap-1.5 transition-all duration-150 hover:-translate-y-0.5 active:scale-95 whitespace-nowrap cursor-pointer ${
            isSimulating 
               ? 'bg-[#C9F27D]/25 border-[#C9F27D] text-[#C9F27D] hover:bg-[#C9F27D] hover:text-[#090C11] hover:shadow-[0_0_15px_rgba(201,242,125,0.35)]' 
              : 'bg-[#C9F27D]/10 border-[#C9F27D]/40 text-[#C9F27D] hover:bg-[#C9F27D] hover:text-[#090C11] hover:border-[#C9F27D] hover:shadow-[0_0_15px_rgba(201,242,125,0.25)]'
          }`}
        >
          {isSimulating ? <Pause size={15} strokeWidth={2.5} /> : <Play size={15} strokeWidth={2.5} />}
          {simulationPending ? (isSimulating ? 'pausing…' : 'starting…') : (isSimulating ? 'pause sim' : 'start sim')}
        </button>
        <button
          id="tour-sim-conflict"
          onClick={onSimulateConflict}
          disabled={!!unavailable?.simConflict}
          title={unavailable?.simConflict}
          className={unavailable?.simConflict ? DISABLED :
            "bg-[#C9F27D]/10 border border-[#C9F27D]/40 text-[#C9F27D] hover:bg-[#C9F27D] hover:text-[#090C11] hover:border-[#C9F27D] hover:shadow-[0_0_15px_rgba(201,242,125,0.35)] px-3.5 py-2 rounded-md text-[12px] font-semibold tracking-wider flex items-center gap-1.5 transition-all duration-150 hover:-translate-y-0.5 active:scale-95 whitespace-nowrap cursor-pointer"}
        >
          <AlertTriangle size={15} strokeWidth={2.5} /> sim conflict
        </button>
        <div id="tour-fault-controls" className="flex flex-wrap gap-2">
          <button
            onClick={onSimulateDeadlock}
            disabled={!!unavailable?.simDeadlock}
            title={unavailable?.simDeadlock}
            className={unavailable?.simDeadlock ? DISABLED :
              "bg-[#C9F27D]/10 border border-[#C9F27D]/40 text-[#C9F27D] hover:bg-[#C9F27D] hover:text-[#090C11] hover:border-[#C9F27D] hover:shadow-[0_0_15px_rgba(201,242,125,0.35)] px-3.5 py-2 rounded-md text-[12px] font-semibold tracking-wider flex items-center gap-1.5 transition-all duration-150 hover:-translate-y-0.5 active:scale-95 whitespace-nowrap cursor-pointer"}
          >
            <XOctagon size={15} strokeWidth={2.5} /> sim deadlock
          </button>
          <button 
            onClick={onFailAMR} 
            disabled={failurePending}
            aria-busy={failurePending}
            className="disabled:opacity-50 disabled:pointer-events-none bg-[#C9F27D]/10 border border-[#C9F27D]/40 text-[#C9F27D] hover:bg-[#C9F27D] hover:text-[#090C11] hover:border-[#C9F27D] hover:shadow-[0_0_15px_rgba(201,242,125,0.35)] px-3.5 py-2 rounded-md text-[12px] font-semibold tracking-wider flex items-center gap-1.5 transition-all duration-150 hover:-translate-y-0.5 active:scale-95 whitespace-nowrap cursor-pointer"
          >
            <AlertCircle size={15} strokeWidth={2.5} /> {failurePending ? (amrFailed ? 'recovering…' : 'failing…') : `${amrFailed ? 'recover' : 'fail'} ${failTargetId.toLowerCase()}`}
          </button>
          <button 
            onClick={onBlockAisle}
            disabled={aislePending}
            aria-busy={aislePending}
            className={`disabled:opacity-50 disabled:pointer-events-none border px-3.5 py-2 rounded-md text-[12px] font-semibold tracking-wider flex items-center gap-1.5 transition-all duration-150 hover:-translate-y-0.5 active:scale-95 whitespace-nowrap cursor-pointer ${
              aisleBlocked
                ? 'bg-[#F87171]/25 border-[#F87171] text-[#F87171] hover:bg-[#F87171] hover:text-[#090C11] hover:shadow-[0_0_15px_rgba(248,113,113,0.35)]'
                : 'bg-[#C9F27D]/10 border-[#C9F27D]/40 text-[#C9F27D] hover:bg-[#C9F27D] hover:text-[#090C11] hover:border-[#C9F27D] hover:shadow-[0_0_15px_rgba(201,242,125,0.35)]'
            }`}
          >
            <XOctagon size={15} strokeWidth={2.5} /> {aisleBlocked ? 'clear aisle' : 'block aisle'}
          </button>
        </div>
        <div className="flex-1"></div>
        <button
          onClick={onReset}
          disabled={!!unavailable?.reset}
          title={unavailable?.reset}
          className={unavailable?.reset ? DISABLED :
            "group bg-white/[0.05] border border-white/10 text-zinc-400 hover:text-white hover:border-[#C9F27D]/40 hover:bg-[#C9F27D]/10 hover:shadow-[0_0_15px_rgba(201,242,125,0.2)] px-3.5 py-2 rounded-md text-[12px] font-semibold tracking-wider flex items-center gap-1.5 transition-all duration-150 hover:-translate-y-0.5 active:scale-95 whitespace-nowrap cursor-pointer"}
        >
          <RefreshCw size={15} strokeWidth={2.5} className="group-hover:rotate-180 transition-transform duration-500" /> reset
        </button>
      </div>

      <div className="mt-3 pt-3 border-t border-white/10 flex gap-6">
        <CommitSlider label="robots" value={robotCount} min={1} max={maxRobots}
          onCommit={onRobotCountChange} disabledReason={unavailable?.robotCount} />
        <CommitSlider label="shelves" value={shelfColCount} min={0} max={6}
          onCommit={onShelfColCountChange} disabledReason={unavailable?.shelfColCount} />
      </div>
    </div>
  );
}
