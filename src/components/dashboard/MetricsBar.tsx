'use client';

import React from 'react';
import { ListTodo, CheckCircle2, AlertTriangle, Clock, TrendingUp, BatteryMedium } from 'lucide-react';
import type { Task, RobotState, PathfindingMetrics } from '@/core/types';

interface MetricsBarProps {
  tasks: Task[];
  robots: RobotState[];
  metrics: PathfindingMetrics;
}

export function MetricsBar({ tasks, robots, metrics }: MetricsBarProps) {
  const completedCount = tasks.filter(t => t.status === 'completed').length;
  const activeCount = robots.filter(r => r.status === 'moving' || r.status === 'assigned' || r.status === 'waiting').length;
  const fleetUtil = robots.length > 0 ? `${Math.round((activeCount / robots.length) * 100)}%` : '0%';
  const avgBatteryVal = robots.length > 0 ? Math.round(robots.reduce((sum, r) => sum + r.battery, 0) / robots.length) : 0;
  const avgBattery = `${avgBatteryVal}%`;

  const batteryStatusColor = avgBatteryVal > 70 ? 'text-[#C9F27D]' : avgBatteryVal > 30 ? 'text-amber-400' : 'text-red-400';
  const batteryBadgeBg = avgBatteryVal > 70 ? 'bg-[#C9F27D]/15' : avgBatteryVal > 30 ? 'bg-amber-500/15' : 'bg-red-500/15';

  return (
    <div className="w-full bg-zinc-900/40 backdrop-blur-md rounded-xl border border-zinc-800/80 flex shadow-2xl divide-x divide-zinc-800/80">
      <div className="flex-1 p-3 flex flex-col justify-center gap-1 transition-all">
        <div className="flex items-center justify-between text-zinc-500 gap-1">
          <span className="text-[11px] tracking-wider whitespace-nowrap overflow-hidden text-ellipsis">total tasks</span>
          <div className="w-5 h-5 rounded-md bg-zinc-950/60 border border-zinc-800/60 flex items-center justify-center shrink-0 text-zinc-400">
            <ListTodo size={12} strokeWidth={2} />
          </div>
        </div>
        <div className="text-2xl font-mono font-bold text-zinc-100 mt-1">{tasks.length}</div>
      </div>

      <div className="flex-1 p-3 flex flex-col justify-center gap-1 transition-all">
        <div className="flex items-center justify-between gap-1">
          <span className="text-[11px] tracking-wider text-zinc-400 whitespace-nowrap overflow-hidden text-ellipsis">completed</span>
          <div className="w-5 h-5 rounded-md bg-[#C9F27D]/15 border border-[#C9F27D]/30 text-[#C9F27D] flex items-center justify-center shrink-0">
            <CheckCircle2 size={12} strokeWidth={2} />
          </div>
        </div>
        <div className="text-2xl font-mono font-bold text-[#C9F27D] mt-1">{completedCount}</div>
      </div>

      <div className="flex-1 p-3 flex flex-col justify-center gap-1 transition-all">
        <div className="flex items-center justify-between gap-1">
          <span className="text-[11px] tracking-wider text-zinc-400 whitespace-nowrap overflow-hidden text-ellipsis">conflicts</span>
          <div className="w-5 h-5 rounded-md bg-red-500/15 border border-red-500/30 text-red-400 flex items-center justify-center shrink-0">
            <AlertTriangle size={12} strokeWidth={2} />
          </div>
        </div>
        <div className="text-2xl font-mono font-bold text-red-400 mt-1">{metrics.conflictCount}</div>
      </div>

      <div className="flex-1 p-3 flex flex-col justify-center gap-1">
        <div className="flex items-center justify-between gap-1">
          <span className="text-[11px] tracking-wider text-zinc-400 whitespace-nowrap overflow-hidden text-ellipsis">replans</span>
          <div className="w-5 h-5 rounded-md bg-amber-500/15 border border-amber-500/30 text-amber-400 flex items-center justify-center shrink-0">
            <Clock size={12} strokeWidth={2} />
          </div>
        </div>
        <div className="text-2xl font-mono font-bold text-amber-400 mt-1">{metrics.replans}</div>
      </div>

      <div className="flex-1 p-3 flex flex-col justify-center gap-1">
        <div className="flex items-center justify-between gap-1">
          <span className="text-[11px] tracking-wider text-zinc-400 whitespace-nowrap overflow-hidden text-ellipsis">fleet util</span>
          <div className="w-5 h-5 rounded-md bg-zinc-950/60 border border-zinc-800/60 text-zinc-400 flex items-center justify-center shrink-0">
            <TrendingUp size={12} strokeWidth={2} />
          </div>
        </div>
        <div className="text-2xl font-mono font-bold text-zinc-100 mt-1">{fleetUtil}</div>
      </div>

      <div className="flex-1 p-3 flex flex-col justify-center gap-1">
        <div className="flex items-center justify-between gap-1">
          <span className="text-[11px] tracking-wider text-zinc-400 whitespace-nowrap overflow-hidden text-ellipsis">avg battery</span>
          <div className={`w-5 h-5 rounded-md ${batteryBadgeBg} ${batteryStatusColor} border border-current/20 flex items-center justify-center shrink-0`}>
            <BatteryMedium size={12} strokeWidth={2} />
          </div>
        </div>
        <div className={`text-2xl font-mono font-bold mt-1 ${batteryStatusColor}`}>{avgBattery}</div>
      </div>
    </div>
  );
}
