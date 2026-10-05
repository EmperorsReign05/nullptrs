'use client';

import React from 'react';
import { Plus, Play, Pause, AlertTriangle, XOctagon, AlertCircle, RefreshCw } from 'lucide-react';

interface ControlPanelProps {
  isSimulating: boolean;
  simulationPending?: boolean;
  amrFailed?: boolean;
  failurePending?: boolean;
  robotCount: number;
  shelfColCount: number;
  aisleBlocked: boolean;
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

/** Visibly inert, and legible as inert. Never a hover-highlight, never a pointer. */
const DISABLED =
  'bg-white/[0.02] border border-white/[0.07] text-zinc-600 px-3.5 py-2 rounded-md text-[12px] font-semibold ' +
  'tracking-wider flex items-center gap-1.5 whitespace-nowrap cursor-not-allowed select-none';

export function ControlPanel({
  isSimulating,
  simulationPending = false,
  amrFailed = false,
  failurePending = false,
  robotCount,
  shelfColCount,
  aisleBlocked,
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
          <span>simulation: <span className={isSimulating ? 'text-[#C9F27D]' : 'text-zinc-500'}>{isSimulating ? 'active' : 'paused'}</span></span>
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
            className="bg-[#C9F27D]/10 border border-[#C9F27D]/40 text-[#C9F27D] hover:bg-[#C9F27D] hover:text-[#090C11] hover:border-[#C9F27D] hover:shadow-[0_0_15px_rgba(201,242,125,0.35)] px-3.5 py-2 rounded-md text-[12px] font-semibold tracking-wider flex items-center gap-1.5 transition-all duration-150 hover:-translate-y-0.5 active:scale-95 whitespace-nowrap cursor-pointer"
          >
            <AlertCircle size={15} strokeWidth={2.5} /> {failurePending ? (amrFailed ? 'recovering…' : 'failing…') : (amrFailed ? 'recover amr-02' : 'fail amr-02')}
          </button>
          <button 
            onClick={onBlockAisle}
            className={`border px-3.5 py-2 rounded-md text-[12px] font-semibold tracking-wider flex items-center gap-1.5 transition-all duration-150 hover:-translate-y-0.5 active:scale-95 whitespace-nowrap cursor-pointer ${
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
        <div className="flex-1 flex items-center gap-3">
          <label className="text-[12px] text-zinc-300 tracking-wider whitespace-nowrap w-24">
            robots (<span className="text-zinc-100 font-semibold">{robotCount}</span>)
          </label>
          <input
            type="range"
            min="1"
            max="20"
            value={robotCount}
            onChange={e => onRobotCountChange(parseInt(e.target.value))}
            disabled={!!unavailable?.robotCount}
            title={unavailable?.robotCount}
            className={`w-full h-1.5 bg-white/[0.08] border border-white/10 rounded-lg appearance-none transition-all ${
              unavailable?.robotCount ? 'cursor-not-allowed opacity-40' : 'cursor-pointer accent-[#C9F27D] hover:accent-[#C9F27D]'}`}
          />
        </div>
        <div className="flex-1 flex items-center gap-3">
          <label className="text-[12px] text-zinc-300 tracking-wider whitespace-nowrap w-24">
            shelves (<span className="text-zinc-100 font-semibold">{shelfColCount}</span>)
          </label>
          <input 
            type="range" 
            min="0" 
            max="6" 
            value={shelfColCount} 
            onChange={e => onShelfColCountChange(parseInt(e.target.value))}
            disabled={!!unavailable?.shelfColCount}
            title={unavailable?.shelfColCount}
            className={`w-full h-1.5 bg-white/[0.08] border border-white/10 rounded-lg appearance-none transition-all ${
              unavailable?.shelfColCount ? 'cursor-not-allowed opacity-40' : 'cursor-pointer accent-[#C9F27D] hover:accent-[#C9F27D]'}`}
          />
        </div>
      </div>
    </div>
  );
}
