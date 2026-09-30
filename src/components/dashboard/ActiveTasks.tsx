'use client';

import React from 'react';
import type { Task, RobotState } from '@/core/types';
import { getRobotColor } from './types';

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

export function ActiveTasks({ tasks, robots, awaitingAuction }: ActiveTasksProps) {
  const activeCount = tasks.filter(t => t.status !== 'pending' && t.status !== 'completed').length;
  const awaiting = new Set(awaitingAuction ?? []);

  return (
    <div className="bg-[#12161F]/35 backdrop-blur-xl rounded-xl border border-white/10 flex flex-col shrink-0 shadow-xl overflow-hidden">
      <div className="h-12 px-5 border-b border-white/10 flex justify-between items-center bg-white/[0.03] backdrop-blur-sm">
        <h3 className="text-sm font-semibold tracking-wide text-zinc-100">active tasks</h3>
        <span className="text-xs text-zinc-300">
          active: <span className="text-[#C9F27D] font-semibold">{activeCount}</span>
        </span>
      </div>
      <div className="p-2 flex flex-col max-h-[220px] overflow-y-auto divide-y divide-white/[0.06]">
        {tasks.map((t) => {
          const robotColor = t.assignedRobotId
            ? getRobotColor(t.assignedRobotId)
            : '#545C6B';

          return (
            <div 
              key={t.id} 
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
                  {t.assignedRobotId ?? (awaiting.has(t.id) ? 'awaiting auction' : 'unassigned')}
                </div>
              </div>
              
              {t.status === 'pending' && awaiting.has(t.id) && (
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
        })}
      </div>
    </div>
  );
}
