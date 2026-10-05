'use client';

import type { RobotState } from '@/core/types';
import { getRobotColor, getRobotHeading } from './types';
import { useSmoothRobots, type MotionFrame, type Pose } from './useSmoothRobots';

type RobotMarkersProps = {
  robots: RobotState[];
  selectedRobotId: string | null;
  onSelectRobot: (id: string | null) => void;
  mapWidth: number;
  mapHeight: number;
  pose?: Pose;
  tick?: number;
  motionHistory?: readonly MotionFrame[];
  runtimeId?: string;
};

/** Only the markers re-render on animation frames. The map, task list and
 * controls update on telemetry or user input, rather than at 60 Hz. */
export function RobotMarkers({ robots, selectedRobotId, onSelectRobot, mapWidth, mapHeight,
  pose: suppliedPose, tick, motionHistory, runtimeId }: RobotMarkersProps) {
  const smoothPose = useSmoothRobots(robots, tick ?? 0, motionHistory, runtimeId);
  const pose = suppliedPose ?? (tick === undefined ? undefined : smoothPose);
  return <>
            {robots.map((robot) => {
              const isSelected = selectedRobotId === robot.id;
              const color = getRobotColor(robot.id);
              const heading = getRobotHeading(robot);
              // Interpolated position when the caller supplies one, otherwise the
              // raw snapshot position. Fractional cells are fine: the container is
              // sized in percentages, so a half-cell offset is just a percentage.
              const at = pose?.[robot.id] ?? robot.position;
              return (
                <div 
                  key={robot.id}
                  onClick={() => onSelectRobot(isSelected ? null : robot.id)}
                  // No CSS transition on POSITION. The old 650ms `transition-all`
                  // was the direct cause of the stutter: a poll arriving mid-move
                  // restarted it from the current computed value, so every frame
                  // was a partial move and the perceived speed was poll jitter.
                  // Position is now driven per-frame by useSmoothRobots; the
                  // transition is kept only for the scale change, which is a
                  // discrete user action and reads correctly when eased.
                  className={`absolute flex flex-col items-center justify-center cursor-pointer z-30 group transition-transform duration-150 ${isSelected ? 'scale-110' : 'hover:scale-105'}`} 
                  style={{ 
                    left: `calc(100% * ${at.x}/${mapWidth})`, 
                    top: `calc(100% * ${at.y}/${mapHeight})`, 
                    width: `calc(100% * 1/${mapWidth})`, 
                    height: `calc(100% * 1/${mapHeight})` 
                  }}
                  title={`${robot.id} | Status: ${robot.status} | Battery: ${robot.battery}%`}
                >
                   {isSelected && (
                     <div className="absolute inset-[-5px] rounded-full border-2 border-white animate-pulse pointer-events-none shadow-[0_0_15px_rgba(255,255,255,0.6)]"></div>
                   )}

                   <div 
                     className={`w-[58%] h-[58%] rounded-full relative z-20 flex items-center justify-center transition-all ${robot.status === 'failed' ? 'animate-ping' : ''}`} 
                     style={{ 
                       backgroundColor: color, 
                       boxShadow: `0 0 16px ${color}, 0 0 6px ${color}` 
                     }}
                   >
                     <div className="w-2 h-2 rounded-full bg-white shadow-sm" />
                   </div>

                   {heading && (
                     <div 
                       className="absolute pointer-events-none text-white transition-transform duration-300"
                       style={{ 
                         transform: heading === 'up' ? 'translateY(-14px)' : 
                                    heading === 'down' ? 'translateY(14px) rotate(180deg)' : 
                                    heading === 'left' ? 'translateX(-14px) rotate(-90deg)' : 
                                    'translateX(14px) rotate(90deg)' 
                       }}
                     >
                       <div className="w-0 h-0 border-l-[3px] border-l-transparent border-r-[3px] border-r-transparent border-b-[5px] border-b-white drop-shadow-[0_0_3px_white]" />
                     </div>
                   )}

                   <span className="bg-[#090C11]/90 border border-[#1F2633] px-1.5 py-0.2 rounded text-[11px] font-mono font-bold text-[#E6E9EF] shadow-md absolute top-[102%] whitespace-nowrap">
                     {robot.id}
                   </span>
                </div>
              );
            })}
  </>;
}
