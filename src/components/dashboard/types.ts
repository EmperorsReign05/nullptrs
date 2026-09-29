import type { Position, RobotState } from '@/core/types';

export type LogEntry = {
  time: string;
  text: string;
  type: 'info' | 'warning' | 'error';
};

// A short-lived callout anchored to a specific map cell — used for
// surfacing an algorithm event (e.g. PIBT priority inheritance) right
// where it actually happened, instead of in a corner toast disconnected
// from the map the audience is watching.
export type MapTooltip = {
  id: string;
  robotId: string;
  text: string;
  position: Position;
};

/** Robot colour is derived from the robot id, never from its position in a list.
 * Index-based colouring collides once the fleet is larger than the palette and
 * silently changes a robot's colour when an earlier robot fails or is filtered
 * out. Hashing the id keeps identity stable and the palette unbounded. */
export function getRobotColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  // Spread hues away from the muddy yellow-green band and keep saturation and
  // lightness fixed so every robot reads equally well on the dark map.
  const hue = (hash % 320 + 200) % 360;
  return `hsl(${hue} 78% 62%)`;
}

export function getRobotHeading(robot: RobotState): 'up' | 'down' | 'left' | 'right' | undefined {
  if (!robot.path || robot.path.length < 2) return undefined;
  const next = robot.path[1];
  if (next.x > robot.position.x) return 'right';
  if (next.x < robot.position.x) return 'left';
  if (next.y > robot.position.y) return 'down';
  if (next.y < robot.position.y) return 'up';
  return undefined;
}
