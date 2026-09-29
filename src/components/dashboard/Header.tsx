'use client';

import React from 'react';
import { HelpCircle } from 'lucide-react';

/**
 * Three optional props, because this header is shared by two genuinely
 * different backends and must not describe either as the other:
 *
 *   /            the distributed fleet runtime (defaults below)
 *   /simulator   the central PIBT simulation — the fair baseline the
 *                stop-and-wait comparison is measured against
 *
 * The hardcoded "central simulation" line was accurate when the central sim
 * was the only backend. Once the fleet runtime took over the main dashboard,
 * leaving it there would have had the page claiming to be something it isn't.
 *
 * `onOpenTutorial` drives the judge tour added in PR #24.
 */
interface HeaderProps {
  onOpenTutorial?: () => void;
  subtitle?: string;
  source?: string;
}

export function Header({
  onOpenTutorial,
  subtitle = 'distributed fleet runtime • A* routing • peer-local motion commit',
  source = 'source: node-hosted fleet telemetry',
}: HeaderProps) {
  return (
    <header className="h-[76px] border-b border-zinc-800/80 flex items-center justify-between px-6 shrink-0 bg-zinc-950/40 backdrop-blur-xl sticky top-0 z-50">
      <div className="flex items-center gap-4">
        <div>
          <h1 className="leading-none">
            <span className="font-serif italic font-normal text-3xl tracking-normal text-[#C9F27D]">
              amr dashboard
            </span>
          </h1>
          <p className="text-[13px] text-zinc-300 mt-1 tracking-wide">
            {subtitle}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-4 text-xs text-zinc-300">
        {onOpenTutorial && (
          <button
            id="tour-restart-btn"
            onClick={onOpenTutorial}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 hover:border-[#C9F27D]/40 bg-white/[0.04] hover:bg-[#C9F27D]/10 text-zinc-200 hover:text-[#C9F27D] text-xs transition-all duration-150 cursor-pointer shadow-sm"
          >
            <HelpCircle size={14} className="text-[#C9F27D]" />
            <span>tutorial</span>
          </button>
        )}
        <span className="flex items-center gap-2">
          {source}
        </span>
      </div>
    </header>
  );
}
