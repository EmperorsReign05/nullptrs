'use client';

import React from 'react';
import { HelpCircle } from 'lucide-react';

interface HeaderProps {
  onOpenTutorial?: () => void;
}

export function Header({ onOpenTutorial }: HeaderProps) {
  return (
    <header className="h-[76px] border-b border-zinc-800/80 flex items-center justify-between px-6 shrink-0 bg-zinc-950/40 backdrop-blur-xl sticky top-0 z-50">
      <div className="flex items-center gap-4">
        <div>
          <h1 className="leading-none">
            <span className="font-serif italic font-normal text-3xl tracking-normal text-[#C9F27D]">
              amr dashboard
            </span>
          </h1>
          <p className="text-[12px] font-mono text-zinc-400 mt-1 tracking-wide">
            central simulation • A* routing • PIBT coordination
          </p>
        </div>
      </div>
      <div className="flex items-center gap-4 text-xs font-mono text-zinc-400">
        {onOpenTutorial && (
          <button
            id="tour-restart-btn"
            onClick={onOpenTutorial}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 hover:border-[#C9F27D]/40 bg-white/[0.04] hover:bg-[#C9F27D]/10 text-zinc-300 hover:text-[#C9F27D] font-mono text-xs transition-all duration-150 cursor-pointer shadow-sm"
          >
            <HelpCircle size={14} className="text-[#C9F27D]" />
            <span>tutorial</span>
          </button>
        )}
        <span className="flex items-center gap-2">
          source: simulated state
        </span>
      </div>
    </header>
  );
}
