'use client';

import React, { useMemo } from 'react';
import { X, Navigation, BatteryCharging, Zap, AlertTriangle } from 'lucide-react';
import {
  WAREHOUSE_WIDTH,
  WAREHOUSE_HEIGHT,
  SHELF_BLOCKS,
  WAITING_ZONES,
  PICKUP_STATIONS,
  DROPOFF_STATIONS,
  CHARGING_STATIONS,
  INTERSECTIONS
} from '@/core/map/warehouse';
import type { RobotState, WarehouseMap as WarehouseMapData } from '@/core/types';
import { getRobotColor, getRobotHeading, type MapTooltip } from './types';

interface WarehouseMapProps {
  robots: RobotState[];
  selectedRobotId: string | null;
  onSelectRobot: (id: string | null) => void;
  shelfColCount: number;
  map?: WarehouseMapData;
  tooltips?: MapTooltip[];
}

export function WarehouseMap({
  robots,
  selectedRobotId,
  onSelectRobot,
  shelfColCount,
  map,
  tooltips = []
}: WarehouseMapProps) {
  const mapWidth = map?.width ?? WAREHOUSE_WIDTH;
  const mapHeight = map?.height ?? WAREHOUSE_HEIGHT;

  const shelfCols = useMemo(() => {
    return Array.from(new Set(SHELF_BLOCKS.map(b => b[0]))).sort((a, b) => a - b);
  }, []);
  const displayedShelfBlocks = useMemo(() => {
    const blocked = new Set(map?.cells.filter(c => c.blocked).map(c => `${c.position.x},${c.position.y}`));
    return SHELF_BLOCKS.filter(([x, y, width, height]) => {
      const colIndex = shelfCols.indexOf(x);
      if (colIndex === -1 || colIndex >= shelfColCount) return false;
      if (!map) return true;
      // A supplied simulation map is authoritative: do not paint stock racks
      // over traversable cells in a custom choke-point scenario.
      for (let dx = 0; dx < width; dx++) for (let dy = 0; dy < height; dy++) {
        if (!blocked.has(`${x + dx},${y + dy}`)) return false;
      }
      return true;
    });
  }, [map, shelfColCount, shelfCols]);
  const dynamicBlockedCells = useMemo(() => {
    if (!map) return [];
    return map.cells.filter(cell => cell.blocked && !displayedShelfBlocks.some(([x, y, w, h]) =>
      cell.position.x >= x && cell.position.x < x + w && cell.position.y >= y && cell.position.y < y + h));
  }, [map, displayedShelfBlocks]);

  const selectedRobot = useMemo(() => {
    return robots.find(r => r.id === selectedRobotId);
  }, [robots, selectedRobotId]);

  const aisleLanes = useMemo(() => {
    const horizontalRows = [4, 8];
    const verticalCols = [6, 13];
    return { horizontalRows, verticalCols };
  }, []);

  const renderShelf = (x: number, y: number, w: number, h: number) => {
    return (
      <div 
        key={`shelf-${x}-${y}`} 
        className="absolute bg-[#181E29] border border-[#283242] p-[2px] rounded-[3px] shadow-sm z-10"
        style={{ 
          left: `calc(100% * ${x}/${mapWidth})`, 
          top: `calc(100% * ${y}/${mapHeight})`, 
          width: `calc(100% * ${w}/${mapWidth})`, 
          height: `calc(100% * ${h}/${mapHeight})`,
          display: 'grid',
          gridTemplateColumns: `repeat(${w}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${h}, minmax(0, 1fr))`,
          gap: '2px'
        }}
      >
        {Array.from({ length: w * h }).map((_, i) => (
          <div 
            key={i} 
            className="w-full h-full bg-[#222B3A] border border-[#323F52] p-[1.5px] flex flex-col justify-between rounded-[1px]"
          >
            <div className="w-full h-[40%] bg-[#2B3648] border border-[#3D4B60] rounded-[1px]"></div>
            <div className="w-full h-[40%] bg-[#2B3648] border border-[#3D4B60] rounded-[1px]"></div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div id="tour-warehouse-map" className="border border-zinc-800/80 bg-zinc-900/40 backdrop-blur-md rounded-xl flex flex-col overflow-hidden shadow-2xl relative min-h-[580px]">
      
      <div className="h-12 border-b border-zinc-800/80 flex items-center justify-between px-6 bg-zinc-950/40 backdrop-blur-sm shrink-0 z-10 select-none">
        <h2 className="font-mono text-sm font-semibold tracking-wide text-zinc-200">
          warehouse layout (2d)
        </h2>
      </div>
      
      <div className="flex-1 bg-black/30 backdrop-blur-sm pt-8 pl-8 pr-4 pb-4 flex items-center justify-center overflow-hidden relative">
         <div className="warehouse-map relative" style={{ 
             width: '100%',
             height: '100%',
             maxHeight: '100%',
             aspectRatio: `${mapWidth} / ${mapHeight}`,
             display: 'grid', 
             gridTemplateColumns: `repeat(${mapWidth}, minmax(0, 1fr))`, 
             gridTemplateRows: `repeat(${mapHeight}, minmax(0, 1fr))`,
             gap: '1px'
         }}>
            {Array.from({ length: mapWidth * mapHeight }).map((_, i) => {
              const x = i % mapWidth;
              const y = Math.floor(i / mapWidth);
              const isAisle = aisleLanes.horizontalRows.includes(y) || [0, 3, 6, 9, 13, 14, 17].includes(x);
              return (
                <div 
                  key={i} 
                  className={`border border-white/[0.06] ${isAisle ? 'bg-white/[0.03]' : 'bg-transparent'}`}
                ></div>
              );
            })}

            {aisleLanes.horizontalRows.map((y) => (
              <div 
                key={`lane-h-${y}`}
                className="absolute pointer-events-none border-b border-dashed border-[#545C6B]/40 w-full"
                style={{
                  top: `calc(100% * ${y + 0.5}/${mapHeight})`,
                  left: 0
                }}
              />
            ))}

            {aisleLanes.verticalCols.map((x) => (
              <div 
                key={`lane-v-${x}`}
                className="absolute pointer-events-none border-r border-dashed border-[#545C6B]/40 h-full"
                style={{
                  left: `calc(100% * ${x + 0.5}/${mapWidth})`,
                  top: 0
                }}
              />
            ))}

            {Array.from({ length: mapWidth }).map((_, i) => (
              <div 
                key={`col-${i}`} 
                className="absolute top-[-22px] text-[10px] text-[#8A93A3] font-mono font-medium -translate-x-1/2" 
                style={{ left: `calc((100% / ${mapWidth}) * ${i + 0.5})` }}
              >
                {i}
              </div>
            ))}
            {Array.from({ length: mapHeight }).map((_, i) => (
              <div 
                key={`row-${i}`} 
                className="absolute left-[-22px] text-[10px] text-[#8A93A3] font-mono font-medium -translate-y-1/2" 
                style={{ top: `calc((100% / ${mapHeight}) * ${i + 0.5})` }}
              >
                {i}
              </div>
            ))}

            {[1, 5, 9].map((y) => (
              <div
                key={`dock-${y}`}
                className="absolute border border-dashed border-zinc-700/80 bg-zinc-900/40 rounded-[2px] flex flex-col justify-around p-[2px] z-10"
                style={{
                  left: `calc(100% * 0/${mapWidth})`,
                  top: `calc(100% * ${y}/${mapHeight})`,
                  width: `calc(100% * 1/${mapWidth})`,
                  height: `calc(100% * 3/${mapHeight})`,
                  display: y + 2 >= mapHeight ? 'none' : 'flex' // Hide if map is smaller than the dock coordinates
                }}
              >
                <div className="w-full h-[24%] border border-zinc-700/60 bg-zinc-800/40 rounded-[1px]" />
                <div className="w-full h-[24%] border border-zinc-700/60 bg-zinc-800/40 rounded-[1px]" />
                <div className="w-full h-[24%] border border-zinc-700/60 bg-zinc-800/40 rounded-[1px]" />
              </div>
            ))}

            {displayedShelfBlocks.map(block => renderShelf(block[0], block[1], block[2], block[3]))}

            {INTERSECTIONS.map((pos, idx) => (
              <div 
                key={`intersection-${idx}`} 
                className="absolute border border-[#283242] bg-[#181E29]/60 flex items-center justify-center z-10" 
                style={{ 
                  left: `calc(100% * ${pos.x}/${mapWidth})`, 
                  top: `calc(100% * ${pos.y}/${mapHeight})`, 
                  width: `calc(100% * 1/${mapWidth})`, 
                  height: `calc(100% * 1/${mapHeight})`,
                  display: pos.x >= mapWidth || pos.y >= mapHeight ? 'none' : 'flex'
                }}
              >
                <div className="w-[1px] h-full bg-[#545C6B] rotate-45 absolute"></div>
                <div className="w-[1px] h-full bg-[#545C6B] -rotate-45 absolute"></div>
              </div>
            ))}

            {WAITING_ZONES.map((zone) => (
              <div 
                key={zone.id} 
                className="absolute border-2 border-dashed border-[#38bdf8]/80 bg-[#38bdf8]/10 rounded-md flex flex-col items-center justify-center z-10 shadow-[0_0_15px_rgba(56,189,248,0.15)]" 
                style={{ 
                  left: `calc(100% * ${zone.x}/${mapWidth})`, 
                  top: `calc(100% * ${zone.y}/${mapHeight})`, 
                  width: `calc(100% * ${zone.width}/${mapWidth})`, 
                  height: `calc(100% * ${zone.height}/${mapHeight})`,
                  display: zone.x >= mapWidth || zone.y >= mapHeight ? 'none' : 'flex'
                }}
              >
                 <span className="text-[10px] text-[#38bdf8] font-mono font-bold text-center leading-tight">
                   waiting zone<br/>{zone.id.toLowerCase()}
                 </span>
              </div>
            ))}

            {PICKUP_STATIONS.map((station) => (
              <div 
                key={station.id} 
                className="absolute bg-[#22c55e] rounded-[3px] shadow-[0_0_18px_rgba(34,197,94,0.45)] flex items-center justify-center z-20" 
                style={{ 
                  left: `calc(100% * ${station.position.x}/${mapWidth})`, 
                  top: `calc(100% * ${station.position.y}/${mapHeight})`, 
                  width: `calc(100% * 1/${mapWidth})`, 
                  height: `calc(100% * 1/${mapHeight})`,
                  display: station.position.x >= mapWidth || station.position.y >= mapHeight ? 'none' : 'flex'
                }}
              >
                 <div className="absolute -top-1.5 w-6 h-1.5 bg-[#22c55e]/30 border-t border-x border-[#22c55e] rounded-t-sm" />
                 <span className="text-[12px] text-[#090C11] font-mono font-black">{station.id.toLowerCase()}</span>
              </div>
            ))}

            {DROPOFF_STATIONS.map((station) => (
              <div 
                key={station.id} 
                className="absolute bg-[#ef4444] rounded-[3px] shadow-[0_0_18px_rgba(239,68,68,0.45)] flex items-center justify-center z-20" 
                style={{ 
                  left: `calc(100% * ${station.position.x}/${mapWidth})`, 
                  top: `calc(100% * ${station.position.y}/${mapHeight})`, 
                  width: `calc(100% * 1/${mapWidth})`, 
                  height: `calc(100% * 1/${mapHeight})`,
                  display: station.position.x >= mapWidth || station.position.y >= mapHeight ? 'none' : 'flex'
                }}
              >
                 <span className="text-[12px] text-[#090C11] font-mono font-black">{station.id.toLowerCase()}</span>
              </div>
            ))}

            {CHARGING_STATIONS.map((station) => (
              <div
                key={station.id}
                className="absolute bg-[#0f172a] border-2 border-[#f59e0b] rounded-[3px] shadow-[0_0_18px_rgba(245,158,11,0.45)] flex items-center justify-center z-20"
                style={{
                  left: `calc(100% * ${station.position.x}/${mapWidth})`,
                  top: `calc(100% * ${station.position.y}/${mapHeight})`,
                  width: `calc(100% * 1/${mapWidth})`,
                  height: `calc(100% * 1/${mapHeight})`,
                  display: station.position.x >= mapWidth || station.position.y >= mapHeight ? 'none' : 'flex'
                }}
              >
                <BatteryCharging size={12} className="text-[#f59e0b]" />
              </div>
            ))}

            {dynamicBlockedCells.map((cell) => (
              <div
                key={`block-${cell.position.x}-${cell.position.y}`}
                className="absolute border-2 border-[#F87171] bg-[repeating-linear-gradient(45deg,rgba(248,113,113,0.35)_0px,rgba(248,113,113,0.35)_4px,rgba(15,23,42,0.6)_4px,rgba(15,23,42,0.6)_8px)] flex items-center justify-center z-25 animate-pulse"
                style={{
                  left: `calc(100% * ${cell.position.x}/${mapWidth})`,
                  top: `calc(100% * ${cell.position.y}/${mapHeight})`,
                  width: `calc(100% * 1/${mapWidth})`,
                  height: `calc(100% * 1/${mapHeight})`
                }}
              >
                <AlertTriangle size={12} className="text-[#F87171] drop-shadow-[0_0_4px_rgba(248,113,113,0.8)]" />
              </div>
            ))}

            <svg
              className="absolute inset-0 w-full h-full pointer-events-none z-20 overflow-hidden"
              viewBox={`0 0 ${mapWidth} ${mapHeight}`}
              preserveAspectRatio="none"
            >
              {robots.map((robot) => {
                if (!robot.path || robot.path.length < 2) return null;
                const isSelected = selectedRobotId === robot.id;
                const color = getRobotColor(robot.id);
                const pointsStr = robot.path.map(p => `${p.x + 0.5},${p.y + 0.5}`).join(' ');

                return (
                  <g key={`path-${robot.id}`}>
                    {isSelected && (
                      <polyline
                        points={pointsStr}
                        fill="none"
                        stroke={color}
                        strokeWidth="0.25"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        opacity={0.35}
                      />
                    )}
                    <polyline
                      points={pointsStr}
                      fill="none"
                      stroke={color}
                      strokeWidth={isSelected ? "0.14" : "0.1"}
                      strokeDasharray="0.3 0.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity={selectedRobotId ? (isSelected ? 1.0 : 0.3) : 0.9}
                      className="transition-all duration-300"
                    />
                  </g>
                );
              })}
            </svg>

            {robots.map((robot) => {
              const isSelected = selectedRobotId === robot.id;
              const color = getRobotColor(robot.id);
              const heading = getRobotHeading(robot);
              return (
                <div 
                  key={robot.id}
                  onClick={() => onSelectRobot(isSelected ? null : robot.id)}
                  className={`absolute flex flex-col items-center justify-center transition-all duration-[650ms] ease-linear cursor-pointer z-30 group ${isSelected ? 'scale-110' : 'hover:scale-105'}`} 
                  style={{ 
                    left: `calc(100% * ${robot.position.x}/${mapWidth})`, 
                    top: `calc(100% * ${robot.position.y}/${mapHeight})`, 
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

                   <span className="bg-[#090C11]/90 border border-[#1F2633] px-1.5 py-0.2 rounded text-[10px] font-mono font-bold text-[#E6E9EF] shadow-md absolute top-[102%] whitespace-nowrap">
                     {robot.id}
                   </span>
                </div>
              );
            })}

            {tooltips.map((tip) => (
              <div
                key={tip.id}
                className="absolute z-50 pointer-events-none animate-in fade-in duration-200"
                style={{
                  left: `calc(100% * ${tip.position.x + 0.5}/${mapWidth})`,
                  top: `calc(100% * ${tip.position.y}/${mapHeight})`,
                  transform: 'translate(-50%, -135%)'
                }}
              >
                <div className="relative bg-[#1c1206]/95 border border-[#f59e0b] text-[#f59e0b] text-[10px] font-mono font-semibold px-2 py-1 rounded-md shadow-[0_0_12px_rgba(245,158,11,0.5)] whitespace-nowrap">
                  {tip.text}
                  <div className="absolute left-1/2 top-full -translate-x-1/2 w-0 h-0 border-l-[4px] border-l-transparent border-r-[4px] border-r-transparent border-t-[5px] border-t-[#f59e0b]" />
                </div>
              </div>
            ))}

         </div>

         {selectedRobot && (
           <div className="absolute bottom-3 left-6 right-6 bg-zinc-950/85 backdrop-blur-md border border-zinc-800 rounded-lg p-2.5 px-4 flex items-center justify-between shadow-2xl animate-in fade-in duration-200 z-40">
             <div className="flex items-center gap-4">
               <div className="flex items-center gap-2">
                 <div 
                   className="w-3 h-3 rounded-full" 
                   style={{ backgroundColor: getRobotColor(selectedRobot.id) }} 
                 />
                 <span className="font-mono font-bold text-xs text-[#E6E9EF]">{selectedRobot.id}</span>
               </div>
               <div className="text-[11px] font-mono text-[#8A93A3] flex items-center gap-1.5">
                 <Navigation size={12} className="text-[#8A93A3]" />
                 <span>pos [{selectedRobot.position.x}, {selectedRobot.position.y}]</span>
               </div>
               <div className="text-[11px] font-mono flex items-center gap-1.5">
                 <Zap size={12} className="text-[#8A93A3]" />
                 <span className={`font-bold ${selectedRobot.status === 'failed' ? 'text-[#F87171]' : 'text-[#8A93A3]'}`}>
                   {selectedRobot.status}
                 </span>
               </div>
               <div className="text-[11px] font-mono flex items-center gap-1.5">
                 <BatteryCharging size={12} className={selectedRobot.battery > 70 ? 'text-[#34D399]' : selectedRobot.battery > 30 ? 'text-[#FBBF24]' : 'text-[#F87171]'} />
                 <span className={selectedRobot.battery > 70 ? 'text-[#34D399]' : selectedRobot.battery > 30 ? 'text-[#FBBF24]' : 'text-[#F87171]'}>{selectedRobot.battery}%</span>
               </div>
               {selectedRobot.path && selectedRobot.path.length > 1 && (
                 <div className="text-[11px] font-mono text-[#8A93A3]">
                   {selectedRobot.path.length - 1} steps to target
                 </div>
               )}
             </div>
             <button 
               onClick={() => onSelectRobot(null)} 
               className="text-[#8A93A3] hover:text-[#E6E9EF] p-1 rounded hover:bg-[#1A202C] transition-colors cursor-pointer"
             >
               <X size={14} />
             </button>
           </div>
         )}
      </div>

      <div className="h-11 border-t border-zinc-800/80 px-6 bg-zinc-950/40 backdrop-blur-sm flex items-center justify-between text-[11px] font-mono text-zinc-400 shrink-0 select-none overflow-x-auto gap-4">
        <div className="flex items-center gap-2">
          <div className="w-3.5 h-3.5 bg-[#181E29] border border-[#283242] rounded-[2px] flex flex-col justify-between p-[1px]">
            <div className="w-full h-[35%] bg-[#222B3A]"></div>
            <div className="w-full h-[35%] bg-[#222B3A]"></div>
          </div>
          <span>shelf</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 border-t border-zinc-600 border-dashed"></div>
          <span>navigable path</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 border border-[#283242] flex items-center justify-center relative">
            <div className="w-[1px] h-3 bg-zinc-600 rotate-45 absolute"></div>
            <div className="w-[1px] h-3 bg-zinc-600 -rotate-45 absolute"></div>
          </div>
          <span>intersection</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 bg-[#22c55e] rounded-[2px]"></div>
          <span>pickup station</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 bg-[#ef4444] rounded-[2px]"></div>
          <span>drop station</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 border border-dashed border-[#38bdf8]/80 bg-[#38bdf8]/20 rounded-[2px]"></div>
          <span>waiting zone</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 bg-[#0f172a] border-2 border-[#f59e0b] rounded-[2px] flex items-center justify-center">
            <BatteryCharging size={8} className="text-[#f59e0b]" />
          </div>
          <span>docking station</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 border-2 border-[#F87171] bg-[repeating-linear-gradient(45deg,rgba(248,113,113,0.35)_0px,rgba(248,113,113,0.35)_2px,rgba(15,23,42,0.6)_2px,rgba(15,23,42,0.6)_4px)]"></div>
          <span>blocked aisle</span>
        </div>
        <div className="flex items-center gap-2">
          {/* One swatch per rendered robot, so the legend matches the actual
              configured fleet rather than a fixed number of dots. */}
          <div className="flex items-center gap-1">
            {robots.slice(0, 8).map((r) => (
              <div key={r.id} className="w-2 h-2 rounded-full" style={{ backgroundColor: getRobotColor(r.id) }}></div>
            ))}
            {robots.length > 8 && <span className="text-[11px] text-slate-300">+{robots.length - 8}</span>}
          </div>
          <span>amr fleet ({robots.length})</span>
        </div>
      </div>
    </div>
  );
}
