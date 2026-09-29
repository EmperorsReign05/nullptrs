'use client';

import React, { useRef, useEffect } from 'react';
import type { LogEntry } from './types';

interface EventLogProps {
  logs: LogEntry[];
}

export function EventLog({ logs }: EventLogProps) {
  const logContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = 0;
    }
  }, [logs]);

  return (
    <div className="bg-[#12161F]/35 backdrop-blur-xl rounded-xl border border-white/10 flex flex-col shadow-xl overflow-hidden">
      <div className="h-12 px-5 border-b border-white/10 flex justify-between items-center bg-white/[0.03] backdrop-blur-sm shrink-0">
        <h3 className="text-sm font-semibold tracking-wide text-zinc-100">event log</h3>
        <span className="flex items-center gap-2 text-xs text-zinc-300">
          <span className="w-2 h-2 rounded-full bg-[#C9F27D] shadow-[0_0_8px_#C9F27D] animate-pulse"></span>
          feed: <span className="text-[#C9F27D]">live</span>
        </span>
      </div>
      <div 
        ref={logContainerRef} 
        className="h-[250px] overflow-y-auto px-5 py-4 flex flex-col gap-2 text-[12px] tracking-wide"
      >
        {[...logs].reverse().map((log, idx) => (
          <div key={idx} className="flex gap-4 items-start opacity-85 hover:opacity-100 transition-opacity pb-2">
            <span className="text-[#A8B2C4] font-mono text-[11px] shrink-0 pt-0.5">{log.time}</span>
            <span className={`text-[12px] leading-relaxed ${
              log.type === 'warning' ? 'text-[#FBBF24]' : 
              log.type === 'error' ? 'text-[#F87171]' : 
              'text-[#E6E9EF]'
            }`}>
              {log.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
