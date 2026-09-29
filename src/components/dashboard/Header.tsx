'use client';

import React from 'react';

export function Header() {
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
        <span className="flex items-center gap-2">
          source: simulated state
        </span>
      </div>
    </header>
  );
}
