'use client';

import React from 'react';
import { BatteryFull, BatteryMedium, BatteryLow } from 'lucide-react';
import type { RobotState } from '@/core/types';
import { getRobotColor } from './types';

interface FleetStatusProps {
  robots: RobotState[];
  selectedRobotId: string | null;
  onSelectRobot: (id: string | null) => void;
}

export function FleetStatus({ robots, selectedRobotId, onSelectRobot }: FleetStatusProps) {
  const onlineCount = robots.filter(r => r.status !== 'failed').length;

  return (
    <div id="tour-fleet-status" className="bg-[#12161F]/35 backdrop-blur-xl rounded-xl border border-white/10 flex flex-col shadow-xl overflow-hidden">
      <div className="h-12 px-5 border-b border-white/10 flex justify-between items-center bg-white/[0.03] backdrop-blur-sm shrink-0">
        <h3 className="text-sm font-semibold tracking-wide text-zinc-100">fleet status</h3>
        <span className="text-xs text-zinc-300">
          active: <span className="text-[#C9F27D] font-semibold">{onlineCount} / {robots.length}</span>
        </span>
      </div>
      <div className="p-2 flex flex-col gap-1 overflow-y-auto max-h-[580px]">
        {robots.map((r) => {
          const isSelected = selectedRobotId === r.id;
          const identityColor = getRobotColor(r.id);
          const batteryColor = r.battery > 70 ? '#C9F27D' : r.battery > 30 ? '#FBBF24' : '#F87171';
          const batteryTextColor = r.battery > 70 ? 'text-[#C9F27D]' : r.battery > 30 ? 'text-[#FBBF24]' : 'text-[#F87171]';

          return (
            <div 
              key={r.id} 
              onClick={() => onSelectRobot(isSelected ? null : r.id)}
              className={`px-3 py-1.5 rounded-lg flex items-center justify-between transition-all duration-150 cursor-pointer ${
                isSelected 
                  ? 'bg-[#C9F27D]/10 border border-[#C9F27D]/50 shadow-[0_0_15px_rgba(201,242,125,0.2)]' 
                  : 'hover:bg-white/[0.06] hover:border-white/10 border border-transparent'
              }`}
            >
              <div className="flex items-center gap-3.5">
                <div 
                  className="w-3.5 h-3.5 rounded-full shadow-lg relative shrink-0" 
                  style={{ backgroundColor: identityColor, boxShadow: `0 0 10px ${identityColor}` }}
                >
                  {isSelected && <span className="absolute -inset-1 rounded-full border border-white animate-ping opacity-60"></span>}
                </div>
                <div>
                  <div className="font-mono font-bold text-sm text-[#E6E9EF] tracking-wide flex items-center gap-2">
                    <span>{r.id}</span>
                    {isSelected && (
                      <span className="text-[11px] bg-[#C9F27D]/20 text-[#C9F27D] border border-[#C9F27D]/40 font-bold px-1.5 py-0.5 rounded">
                        selected
                      </span>
                    )}
                  </div>
                  <div className="text-[12px] text-zinc-300 mt-0.5 flex items-center gap-1.5">
                    {r.status === 'moving' && <span className="w-1.5 h-1.5 rounded-full bg-[#C9F27D] animate-pulse"></span>}
                    {r.status === 'failed' ? <span className="text-[#F87171] font-bold">failed</span> : r.status}
                  </div>
                </div>
              </div>
              <div className="flex flex-col items-end gap-1 font-mono font-medium">
                <div className="flex items-center gap-1.5">
                  <span className="text-[13px] text-[#E6E9EF]">{r.battery}%</span>
                  {r.battery > 70 ? (
                    <BatteryFull size={16} className={batteryTextColor} strokeWidth={2} />
                  ) : r.battery > 30 ? (
                    <BatteryMedium size={16} className={batteryTextColor} strokeWidth={2} />
                  ) : (
                    <BatteryLow size={16} className={batteryTextColor} strokeWidth={2} />
                  )}
                </div>
                <div className="w-14 h-1 bg-white/[0.08] border border-white/10 rounded-full overflow-hidden">
                  <div 
                    className="h-full rounded-full transition-all duration-300"
                    style={{ 
                      width: `${r.battery}%`, 
                      backgroundColor: batteryColor 
                    }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
