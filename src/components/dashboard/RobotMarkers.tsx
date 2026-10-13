'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RobotState } from '@/core/types';
import { getRobotColor } from './types';
import { formatBattery } from './RollingText';
import { MotionPlayer, type MotionFrame } from './motion';

type RobotMarkersProps = {
  robots: RobotState[];
  selectedRobotId: string | null;
  onSelectRobot: (id: string | null) => void;
  mapWidth: number;
  mapHeight: number;
  tick?: number;
  motionHistory?: readonly MotionFrame[];
  runtimeId?: string;
  /** False while paused, connecting or disconnected: finish known motion, then hold. */
  running?: boolean;
  /** Blocked cells as "x,y"; prediction never draws a robot entering one. */
  blocked?: ReadonlySet<string>;
};

const transformOf = (x: number, y: number) => `translate3d(${x * 100}%, ${y * 100}%, 0)`;

/**
 * Robot markers and their routes.
 *
 * React renders this layer only when telemetry or selection changes. Motion is
 * written straight to the DOM from one requestAnimationFrame loop, as a
 * compositor-only `transform`: the previous version re-rendered every marker
 * through React at display rate and moved them with `left`/`top`, which forces
 * layout and paint on every frame inside a stack of backdrop-blurred panels.
 *
 * The animated properties (marker transform, arrow transform, route points) are
 * deliberately absent from the JSX. React only writes the style keys it was
 * given, so a telemetry re-render can never stomp the animated position back to
 * the raw server cell.
 */
export function RobotMarkers({ robots, selectedRobotId, onSelectRobot, mapWidth, mapHeight,
  tick, motionHistory, runtimeId, running = true, blocked }: RobotMarkersProps) {
  const [player] = useState(() => new MotionPlayer());
  const layer = useRef<HTMLDivElement>(null);
  const paintRef = useRef<(now: number) => void>(() => {});

  useEffect(() => {
    player.ingest({ robots, tick, history: motionHistory, runtimeId, running, blocked }, performance.now());
  }, [player, robots, tick, motionHistory, runtimeId, running, blocked]);

  useEffect(() => {
    let frame = 0;
    let resets = player.resets;
    const written = new WeakMap<Element, string>();
    const write = (el: Element, value: string, apply: (v: string) => void) => {
      if (written.get(el) === value) return;
      written.set(el, value);
      apply(value);
    };
    const paint = (now: number) => {
      const root = layer.current;
      if (!root) return;
      const pose = player.sample(now);
      if (player.resets !== resets) {
        // A new world (restart, resize, cold start) is a cut, not a journey:
        // fade the layer instead of sliding robots across racks.
        resets = player.resets;
        root.animate([{ opacity: 0.15 }, { opacity: 1 }], { duration: 320, easing: 'ease-out' });
      }
      root.querySelectorAll<HTMLElement>('[data-robot-marker]').forEach((el) => {
        const at = pose[el.dataset.robotMarker!];
        if (at) write(el, transformOf(at.x, at.y), v => { el.style.transform = v; });
      });
      root.querySelectorAll<HTMLElement>('[data-robot-arrow]').forEach((arrow) => {
        const id = arrow.dataset.robotArrow!;
        const at = pose[id];
        if (!at) return;
        const v = player.velocityOf(id);
        const next = player.routeOf(id)[0];
        let angle: number | null = null;
        if (Math.hypot(v.x, v.y) > 0.4) angle = Math.atan2(v.y, v.x);
        else if (next && Math.abs(next.x - at.x) + Math.abs(next.y - at.y) > 0.05) angle = Math.atan2(next.y - at.y, next.x - at.x);
        // Quantised so a straight run writes nothing after the first frame.
        const turn = angle === null ? null : Math.round(angle / 0.04) * 0.04;
        write(arrow, turn === null ? 'hidden' : `rotate(${turn.toFixed(2)}rad) translateX(15px)`, value => {
          arrow.style.visibility = value === 'hidden' ? 'hidden' : 'visible';
          if (value !== 'hidden') arrow.style.transform = value;
        });
      });
      root.querySelectorAll<SVGPolylineElement>('[data-robot-route]').forEach((line) => {
        const id = line.dataset.robotRoute!;
        const at = pose[id];
        if (!at) return;
        // Anchored at the cell the robot is drawn in, not at its exact painted
        // position. The robot travels along the line between cell centres, so it
        // still sits on its route, and the route — one SVG spanning the whole map
        // — is rewritten about once per tick instead of re-rasterised every frame.
        const cell = { x: Math.round(at.x), y: Math.round(at.y) };
        const ahead = player.routeOf(id).filter((p, i) => i > 0 || p.x !== cell.x || p.y !== cell.y);
        const points = [cell, ...ahead];
        const value = points.length < 2 ? '' : points.map(p => `${p.x + 0.5},${p.y + 0.5}`).join(' ');
        write(line, value, v => {
          line.setAttribute('points', v);
          line.style.visibility = v ? 'visible' : 'hidden';
        });
      });
    };
    paintRef.current = paint;
    const loop = (now: number) => { frame = requestAnimationFrame(loop); paint(now); };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [player]);

  // Paint synchronously after every commit, before the browser does. A marker
  // mounted by this render (a new world, a selection change) is placed at once
  // instead of flashing at the origin for a frame.
  useLayoutEffect(() => { paintRef.current(performance.now()); });

  return (
    <div ref={layer} className="absolute inset-0 pointer-events-none z-30">
      <svg
        className="absolute inset-0 w-full h-full overflow-hidden"
        viewBox={`0 0 ${mapWidth} ${mapHeight}`}
        preserveAspectRatio="none"
      >
        {robots.map((robot) => {
          const isSelected = selectedRobotId === robot.id;
          const color = getRobotColor(robot.id);
          return (
            <polyline
              key={`path-${robot.id}`}
              data-robot-route={robot.id}
              fill="none"
              stroke={color}
              strokeWidth={isSelected ? 0.14 : 0.1}
              strokeDasharray="0.3 0.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={selectedRobotId ? (isSelected ? 1 : 0.3) : 0.9}
              style={{ visibility: 'hidden' }}
            />
          );
        })}
      </svg>

      {robots.map((robot) => {
        const isSelected = selectedRobotId === robot.id;
        const failed = robot.status === 'failed';
        const color = failed ? '#F87171' : getRobotColor(robot.id);
        return (
          <div
            key={robot.id}
            data-robot-marker={robot.id}
            className="absolute left-0 top-0 pointer-events-auto"
            style={{ width: `${100 / mapWidth}%`, height: `${100 / mapHeight}%`, willChange: 'transform' }}
          >
            <div
              onClick={() => onSelectRobot(isSelected ? null : robot.id)}
              className={`relative w-full h-full flex flex-col items-center justify-center cursor-pointer group transition-transform duration-150 ${isSelected ? 'scale-110' : 'hover:scale-105'}`}
              title={`${robot.id} | Status: ${robot.status} | Battery: ${formatBattery(robot.battery)}`}
            >
              {isSelected && (
                <div className="absolute inset-[-5px] rounded-full border-2 border-white animate-pulse pointer-events-none shadow-[0_0_15px_rgba(255,255,255,0.6)]"></div>
              )}
              {/* A failed robot stays visible. `animate-ping` on the body itself
                  scaled it up and faded it to transparent, so the robot that most
                  needed watching blinked out of the map. The ping is a ring now. */}
              {failed && (
                <div className="absolute w-[58%] h-[58%] rounded-full border-2 border-[#F87171] animate-ping pointer-events-none" />
              )}
              <div
                className="w-[58%] h-[58%] rounded-full relative z-20 flex items-center justify-center"
                style={{ backgroundColor: color, boxShadow: `0 0 16px ${color}, 0 0 6px ${color}` }}
              >
                <div className="w-2 h-2 rounded-full bg-white shadow-sm" />
              </div>

              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div data-robot-arrow={robot.id} className="text-white" style={{ visibility: 'hidden' }}>
                  <div className="w-0 h-0 border-t-[3px] border-t-transparent border-b-[3px] border-b-transparent border-l-[5px] border-l-white drop-shadow-[0_0_3px_white]" />
                </div>
              </div>

              <span className="bg-[#090C11]/90 border border-[#1F2633] px-1.5 py-0.2 rounded text-[11px] font-mono font-bold text-[#E6E9EF] shadow-md absolute top-[102%] whitespace-nowrap">
                {robot.id}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
