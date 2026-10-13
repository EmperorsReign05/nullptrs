'use client';

import React from 'react';
import type { Task, RobotState } from '@/core/types';
import { getRobotColor } from './types';
import { RollingText } from './RollingText';

interface ActiveTasksProps {
  tasks: Task[];
  robots: RobotState[];
  /**
   * Task ids the operator injected by hand, so a just-announced job reads as
   * "awaiting auction" instead of the generic "unassigned".
   *
   * A newly announced task legitimately sits `pending` with no owner until the
   * next ownership epoch, which at the 250 ms tick rate is up to eight seconds,
   * and a full pickup-and-delivery is more like thirty. Showing that interval as
   * an indistinguishable blank is what made the create-task button look broken,
   * so the waiting is named rather than hidden.
   */
  awaitingAuction?: readonly string[];
}

/** Live work first, then waiting work, then the most recent completions. */
const ORDER: Record<Task['status'], number> = { in_progress: 0, assigned: 1, pending: 2, completed: 3 };
/** Rows rendered at once. Polled 4x a second, an unbounded list re-rendered every job ever announced. */
const MAX_ROWS = 40;

export function ActiveTasks({ tasks, robots, awaitingAuction }: ActiveTasksProps) {
  const activeCount = tasks.filter(t => t.status !== 'pending' && t.status !== 'completed').length;
  const awaiting = new Set(awaitingAuction ?? []);
  const ordered = [...tasks].sort((a, b) => ORDER[a.status] - ORDER[b.status] ||
    (a.status === 'completed' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt));
  const shown = ordered.slice(0, MAX_ROWS);

  return (
    <div className="bg-[#12161F]/35 backdrop-blur-xl rounded-xl border border-white/10 flex flex-col shrink-0 shadow-xl overflow-hidden">
      <div className="h-12 px-5 border-b border-white/10 flex justify-between items-center bg-white/[0.03] backdrop-blur-sm">
        <h3 className="text-sm font-semibold tracking-wide text-zinc-100">active tasks</h3>
        <span className="text-xs text-zinc-300">
          active: <RollingText className="text-[#C9F27D] font-semibold" value={activeCount} />
        </span>
      </div>
      <div className="p-2 flex flex-col max-h-[220px] overflow-y-auto divide-y divide-white/[0.06]">
        {shown.map((t) => (
          <TaskRow key={t.id} id={t.id} status={t.status} assignedRobotId={t.assignedRobotId}
            px={t.pickup.x} py={t.pickup.y} dx={t.dropoff.x} dy={t.dropoff.y} awaitingAuction={awaiting.has(t.id)} />
        ))}
        {ordered.length > shown.length && (
          <div className="px-4 py-2 text-[11px] font-mono text-zinc-400">
            <RollingText value={`+${ordered.length - shown.length} more queued`} />
          </div>
        )}
      </div>
    </div>
  );
}

/** One task row, memoized on what it shows, for the same reason as FleetStatus rows. */
const TaskRow = React.memo(function TaskRow({ id, status, assignedRobotId, px, py, dx, dy, awaitingAuction }: {
  id: string; status: Task['status']; assignedRobotId?: string; px: number; py: number; dx: number; dy: number; awaitingAuction: boolean;
}) {
  const t = { id, status, assignedRobotId, pickup: { x: px, y: py }, dropoff: { x: dx, y: dy } };
  const robotColor = t.assignedRobotId
    ? getRobotColor(t.assignedRobotId)
    : '#545C6B';

  return (
    <div 
      className={`px-4 py-3 flex justify-between items-center hover:bg-white/[0.06] transition-colors duration-150 ${
        t.status === 'pending' ? 'opacity-60' : ''
      }`}
    >
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <span className="font-mono font-bold text-sm text-[#E6E9EF] tracking-wide">{t.id}</span>
          <span className="text-[12px] text-[#A8B2C4]">({t.pickup.x},{t.pickup.y}) → ({t.dropoff.x},{t.dropoff.y})</span>
        </div>
        <div className="text-[12px] font-bold tracking-wider" style={{ color: robotColor }}>
          <RollingText value={t.assignedRobotId ?? (awaitingAuction ? 'awaiting auction' : 'unassigned')} />
        </div>
      </div>
      
      {t.status === 'pending' && awaitingAuction && (
        <span className="bg-white/[0.06] border border-white/10 text-[#E6E9EF] text-[9px] font-sans font-bold px-2.5 py-1 rounded-full tracking-wider flex items-center gap-1.5 shadow-sm">
          <span className="w-1.5 h-1.5 rounded-full bg-[#A8B2C4] animate-pulse"></span>
          announced
        </span>
      )}

      {t.status === 'in_progress' && (
        <span className="bg-white/[0.06] border border-white/10 text-[#E6E9EF] text-[9px] font-sans font-bold px-2.5 py-1 rounded-full tracking-wider flex items-center gap-1.5 shadow-sm">
          <span className="w-1.5 h-1.5 rounded-full bg-[#34D399] animate-pulse"></span>
          in progress
        </span>
      )}
      {t.status === 'assigned' && (
        <span className="bg-white/[0.06] border border-white/10 text-[#8A93A3] text-[9px] font-sans font-bold px-2.5 py-1 rounded-full tracking-wider">
          assigned
        </span>
      )}
      {t.status === 'pending' && (
        <span className="bg-white/[0.06] border border-white/10 text-[#545C6B] text-[9px] font-sans font-bold px-2.5 py-1 rounded-full tracking-wider">
          pending
        </span>
      )}
      {t.status === 'completed' && (
        <span className="bg-[#34D399]/15 border border-[#34D399]/30 text-[#34D399] text-[9px] font-sans font-bold px-2.5 py-1 rounded-full tracking-wider">
          completed
        </span>
      )}
    </div>
  );
});
