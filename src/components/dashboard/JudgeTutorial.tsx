'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronRight, ChevronLeft, X, Check } from 'lucide-react';

export interface TutorialStep {
  id: string;
  targetId: string;
  title: string;
  description: string;
  actionHint?: string;
  placement?: 'top' | 'bottom' | 'left' | 'right' | 'center';
}

const TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: 'welcome',
    targetId: 'tour-warehouse-map',
    title: 'Welcome to AMR Fleet Command',
    description: 'This platform coordinates autonomous mobile robot fleets in real time. We replace slow centralized solvers with a decentralized two-layer engine: global A* routing paired with real-time PIBT collision avoidance.',
    actionHint: 'Take this quick 60-second tour to see what to click and observe.',
    placement: 'right',
  },
  {
    id: 'warehouse-map',
    targetId: 'tour-warehouse-map',
    title: 'Warehouse Grid & Navigation',
    description: 'The 20x13 grid represents the physical floor. Static shelves act as obstacles. P1/P2 (green) are inventory pickup bays, D1/D2 (red) are delivery dropoffs, and yellow tiles are automated battery charging docks.',
    actionHint: 'Watch robots navigate aisles using dynamic congestion avoidance.',
    placement: 'right',
  },
  {
    id: 'fleet-status',
    targetId: 'tour-fleet-status',
    title: 'Heterogeneous Fleet Telemetry',
    description: 'Displays live robot telemetry, battery levels, and assignments. We simulate two distinct hardware profiles: Scout Agile 2.0 (50kg max payload) and Addverb Dynamo 100 (100kg heavy hauler).',
    actionHint: 'Click any robot in the list to highlight its live path and destination.',
    placement: 'left',
  },
  {
    id: 'start-sim',
    targetId: 'tour-start-sim',
    title: 'Start Simulation Engine',
    description: 'Starts the 650ms continuous dispatch tick loop. On every tick, the engine matches tasks via market auctions, verifies battery charging thresholds, and advances robot movement.',
    actionHint: 'Click "start sim" to watch the fleet come alive.',
    placement: 'right',
  },
  {
    id: 'sim-conflict',
    targetId: 'tour-sim-conflict',
    title: 'PIBT Conflict Resolution',
    description: 'Simulates two robots head-on in a single-lane corridor. Priority Inheritance with Backtracking (PIBT) dynamically resolves the encounter: the higher-priority robot pushes the lower-priority unit, which yields into a bay with zero collisions.',
    actionHint: 'Click "sim conflict" to see on-map priority inheritance in action.',
    placement: 'right',
  },
  {
    id: 'fault-controls',
    targetId: 'tour-fault-controls',
    title: 'Deadlocks & Dynamic Fault Tolerance',
    description: '"sim deadlock" tests a 4-robot circular deadlock resolved via backtracking. "fail amr-02" injects hardware motor failure, while "block aisle" simulates corridor blockage. The fleet reroutes immediately.',
    actionHint: 'Use these buttons to demonstrate real-time fault recovery to judges.',
    placement: 'right',
  },
  {
    id: 'tasks-and-logs',
    targetId: 'tour-tasks-and-logs',
    title: 'Market Auctions & Audit Log',
    description: 'Active Tasks shows payload-aware bidding where robots bid based on distance, battery, and payload limits. The Event Log streams real-time status transitions and verified PIBT conflict resolutions.',
    actionHint: 'Watch new tasks get auctioned and claimed by optimal robots.',
    placement: 'right',
  },
];

interface JudgeTutorialProps {
  isOpen: boolean;
  onClose: () => void;
}

interface TargetRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function JudgeTutorial({ isOpen, onClose }: JudgeTutorialProps) {
  const [currentStepIdx, setCurrentStepIdx] = useState(0);
  const [targetRect, setTargetRect] = useState<TargetRect | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [popoverPos, setPopoverPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [arrowPoints, setArrowPoints] = useState<{ startX: number; startY: number; endX: number; endY: number }>({
    startX: 0,
    startY: 0,
    endX: 0,
    endY: 0,
  });

  useEffect(() => {
    if (!isOpen) return;
    // In a callback, not synchronously in the effect body: a synchronous
    // setState here cascades a render and trips react-hooks/set-state-in-effect.
    const id = setTimeout(() => setCurrentStepIdx(0), 0);
    return () => clearTimeout(id);
  }, [isOpen]);

  const step = TUTORIAL_STEPS[currentStepIdx];
  const totalSteps = TUTORIAL_STEPS.length;

  const updateTargetRect = useCallback(() => {
    if (!isOpen || !step) return;

    const el = document.getElementById(step.targetId);
    if (!el) {
      setTargetRect(null);
      return;
    }

    const rect = el.getBoundingClientRect();
    const padding = 8;
    const newRect = {
      x: Math.max(0, rect.left - padding),
      y: Math.max(0, rect.top - padding),
      width: rect.width + padding * 2,
      height: rect.height + padding * 2,
    };
    setTargetRect(newRect);

    const popoverW = Math.min(360, window.innerWidth - 32);
    const popoverH = 260;
    const margin = 20;

    let posX = 0;
    let posY = 0;

    if (step.placement === 'left') {
      posX = Math.max(16, newRect.x - popoverW - margin);
      const targetCenterY = newRect.y + newRect.height / 2;
      posY = Math.max(16, Math.min(targetCenterY - popoverH / 2, window.innerHeight - popoverH - 16));
    } else {
      const fleetEl = document.getElementById('tour-fleet-status');
      const fleetRect = fleetEl?.getBoundingClientRect();

      if (fleetRect && fleetRect.width >= popoverW) {
        posX = fleetRect.left + (fleetRect.width - popoverW) / 2;
      } else {
        posX = Math.max(newRect.x + newRect.width + margin, window.innerWidth - popoverW - 16);
      }

      if (posX + popoverW > window.innerWidth - 16) {
        posX = window.innerWidth - popoverW - 16;
      }
      if (posX < 16) {
        posX = 16;
      }

      const targetCenterY = newRect.y + newRect.height / 2;
      posY = Math.max(20, Math.min(targetCenterY - popoverH / 2, window.innerHeight - popoverH - 20));
    }

    setPopoverPos({ x: posX, y: posY });

    let startX = 0;
    let startY = 0;
    let endX = 0;
    let endY = 0;

    if (step.placement === 'left') {
      startX = posX + popoverW;
      startY = posY + popoverH / 2;
      endX = Math.max(0, newRect.x - 4);
      endY = Math.min(Math.max(startY, newRect.y + 16), newRect.y + newRect.height - 16);
    } else {
      if (posX >= newRect.x + newRect.width) {
        startX = posX;
        startY = posY + popoverH / 2;
        endX = newRect.x + newRect.width + 4;
        endY = Math.min(Math.max(startY, newRect.y + 16), newRect.y + newRect.height - 16);
      } else {
        startX = posX + popoverW / 2;
        startY = posY > newRect.y + newRect.height ? posY : posY + popoverH;
        endX = newRect.x + newRect.width / 2;
        endY = posY > newRect.y + newRect.height ? newRect.y + newRect.height : newRect.y;
      }
    }

    // Deferred for the same reason as above: this runs synchronously inside the
    // effect, and a synchronous setState in an effect body cascades a render.
    const id = setTimeout(() => setArrowPoints({ startX, startY, endX, endY }), 0);
    return () => clearTimeout(id);
  }, [isOpen, step]);

  useEffect(() => {
    if (!isOpen || !step) return;

    const el = document.getElementById(step.targetId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // All three measurements are in timers: updateTargetRect ends in a
    // setState, and calling it synchronously from the effect body cascades a
    // render (react-hooks/set-state-in-effect).
    const timer0 = setTimeout(() => {
      updateTargetRect();
    }, 0);
    const timer1 = setTimeout(() => {
      updateTargetRect();
    }, 150);
    const timer2 = setTimeout(() => {
      updateTargetRect();
    }, 400);

    window.addEventListener('resize', updateTargetRect);
    window.addEventListener('scroll', updateTargetRect, true);

    return () => {
      clearTimeout(timer0);
      clearTimeout(timer1);
      clearTimeout(timer2);
      window.removeEventListener('resize', updateTargetRect);
      window.removeEventListener('scroll', updateTargetRect, true);
    };
  }, [isOpen, step, updateTargetRect]);

  const handleNext = () => {
    if (currentStepIdx < totalSteps - 1) {
      setCurrentStepIdx((prev) => prev + 1);
    } else {
      handleComplete();
    }
  };

  const handlePrev = () => {
    if (currentStepIdx > 0) {
      setCurrentStepIdx((prev) => prev - 1);
    }
  };

  const handleComplete = () => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('amr_judge_tour_completed_v2', 'true');
    }
    setCurrentStepIdx(0);
    onClose();
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === 'Escape') {
        handleComplete();
      } else if (e.key === 'ArrowRight') {
        handleNext();
      } else if (e.key === 'ArrowLeft') {
        handlePrev();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, currentStepIdx]);

  if (!isOpen || !step) return null;

  return (
    <div className="fixed inset-0 z-[9999] overflow-hidden pointer-events-none">
      <svg className="absolute inset-0 w-full h-full pointer-events-none">
        <defs>
          <mask id="spotlight-hole-mask">
            <rect width="100%" height="100%" fill="white" />
            {targetRect && (
              <rect
                x={targetRect.x}
                y={targetRect.y}
                width={targetRect.width}
                height={targetRect.height}
                rx="14"
                ry="14"
                fill="black"
              />
            )}
          </mask>
          <marker
            id="white-arrowhead"
            viewBox="0 0 10 10"
            refX="6"
            refY="5"
            markerWidth="8"
            markerHeight="8"
            orient="auto-start-reverse"
          >
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#FFFFFF" />
          </marker>
        </defs>

        <rect
          width="100%"
          height="100%"
          fill="rgba(0, 0, 0, 0.82)"
          mask="url(#spotlight-hole-mask)"
          className="backdrop-blur-sm"
        />

        {targetRect && (
          <path
            d={`M ${arrowPoints.startX} ${arrowPoints.startY} Q ${(arrowPoints.startX + arrowPoints.endX) / 2} ${(arrowPoints.startY + arrowPoints.endY) / 2} ${arrowPoints.endX} ${arrowPoints.endY}`}
            fill="none"
            stroke="#FFFFFF"
            strokeWidth="2.5"
            strokeDasharray="6 4"
            markerEnd="url(#white-arrowhead)"
            className="animate-pulse"
          />
        )}
      </svg>

      {/* SVG masking only hides pixels; it does not create a clickable hole.
          Block the four regions outside the spotlight so the highlighted
          warehouse control receives the actual click. */}
      {(targetRect ? [
        { top: 0, left: 0, right: 0, height: targetRect.y },
        { top: targetRect.y + targetRect.height, left: 0, right: 0, bottom: 0 },
        { top: targetRect.y, left: 0, width: targetRect.x, height: targetRect.height },
        { top: targetRect.y, left: targetRect.x + targetRect.width, right: 0, height: targetRect.height },
      ] : [{ top: 0, left: 0, right: 0, bottom: 0 }]).map((style, i) => (
        <div key={i} aria-hidden className="absolute pointer-events-auto cursor-pointer" style={style} onClick={handleNext} />
      ))}

      {targetRect && (
        <div
          className="absolute pointer-events-none rounded-xl ring-2 ring-white shadow-[0_0_35px_rgba(255,255,255,0.7),0_0_70px_rgba(201,242,125,0.35)] transition-all duration-300 ease-out"
          style={{
            top: targetRect.y,
            left: targetRect.x,
            width: targetRect.width,
            height: targetRect.height,
          }}
        >
          <div className="absolute -inset-1 rounded-2xl border border-white/40 animate-ping opacity-30" />
        </div>
      )}

      <div
        ref={popoverRef}
        className="absolute pointer-events-auto z-[10000] w-[360px] max-w-[calc(100vw-32px)] bg-black/95 text-white rounded-2xl border-2 border-white/80 p-5 shadow-[0_20px_60px_rgba(0,0,0,0.9),0_0_30px_rgba(255,255,255,0.2)] backdrop-blur-2xl transition-all duration-300 ease-out"
        style={{
          top: popoverPos.y,
          left: popoverPos.x,
        }}
      >
        <div className="flex items-center justify-between pb-3 border-b border-white/15">
          <div className="flex items-center gap-2">
            <span className="flex items-center justify-center w-6 h-6 rounded-full bg-white text-black font-mono font-bold text-xs">
              {currentStepIdx + 1}
            </span>
            <span className="font-mono text-xs font-bold tracking-widest text-zinc-300 uppercase">
              Step {currentStepIdx + 1} of {totalSteps}
            </span>
          </div>

          <button
            onClick={handleComplete}
            className="text-zinc-400 hover:text-white transition-colors p-1 rounded-md hover:bg-white/10 cursor-pointer"
            aria-label="Skip tour"
          >
            <X size={16} strokeWidth={2.5} />
          </button>
        </div>

        <div className="py-4 flex flex-col gap-2.5">
          <h3 className="font-mono text-base font-bold tracking-wide text-white">
            {step.title}
          </h3>

          <p className="font-sans text-[13px] leading-relaxed text-zinc-200">
            {step.description}
          </p>

          {step.actionHint && (
            <div className="mt-1 bg-white/10 border border-white/20 rounded-lg p-2.5 text-[11px] font-mono text-white flex items-start gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-[#C9F27D] shrink-0 mt-1" />
              <span>{step.actionHint}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between pt-3 border-t border-white/15">
          <button
            onClick={handleComplete}
            className="text-xs font-mono text-zinc-400 hover:text-white transition-colors underline underline-offset-4 cursor-pointer"
          >
            Skip Tutorial
          </button>

          <div className="flex items-center gap-2">
            {currentStepIdx > 0 && (
              <button
                onClick={handlePrev}
                className="px-3 py-1.5 rounded-lg border border-white/30 text-white hover:bg-white/10 text-xs font-mono font-semibold tracking-wider flex items-center gap-1 transition-all cursor-pointer"
              >
                <ChevronLeft size={14} /> Back
              </button>
            )}

            <button
              onClick={handleNext}
              className="px-4 py-1.5 rounded-lg bg-white text-black hover:bg-[#C9F27D] hover:shadow-[0_0_15px_rgba(201,242,125,0.4)] text-xs font-mono font-bold tracking-wider flex items-center gap-1 transition-all cursor-pointer"
            >
              {currentStepIdx === totalSteps - 1 ? (
                <>
                  <Check size={14} strokeWidth={3} /> Finish
                </>
              ) : (
                <>
                  Next <ChevronRight size={14} />
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
