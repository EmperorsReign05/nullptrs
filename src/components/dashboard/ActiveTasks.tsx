'use client';

import React from 'react';
import type { Task, RobotState } from '@/core/types';
import { getRobotColor } from './types';

interface ActiveTasksProps {
  tasks: Task[];
  robots: RobotState[];
}

export function ActiveTasks({ tasks, robots }: ActiveTasksProps) {
  const activeCount = tasks.filter(t => t.status !== 'pending' && t.status !== 'completed').length;

  return (
    <div className="bg-[#12161F]/35 backdrop-blur-xl rounded-xl border border-white/10 flex flex-col shrink-0 shadow-xl overflow-hidden">
      <div className="h-12 px-5 border-b border-white/10 flex justify-between items-center bg-white/[0.03] backdrop-blur-sm">
        <h3 className="font-mono text-sm font-semibold tracking-wide text-zinc-200">active tasks</h3>
        <span className="text-xs font-mono text-zinc-400">
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
                  <span className="text-[11px] font-mono text-[#8A93A3]">({t.pickup.x},{t.pickup.y}) → ({t.dropoff.x},{t.dropoff.y})</span>
                </div>
                <div className="text-[11px] font-mono font-bold tracking-wider" style={{ color: robotColor }}>
                  {t.assignedRobotId ?? 'unassigned'}
                </div>
              </div>
              
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
