/** Nav2 physical fixture: replaces the grid choke geometry with a crossing whose
 * robot origins match the fleet config exactly. The ROS physical world and the
 * host grid must agree or every /initialize is rejected, so both read the same
 * file instead of restating the origin arithmetic. */
import { loadFleetConfig } from './fleet-config.mjs';

export function configureNav2Fleet(s, crossing = true, config = loadFleetConfig()) {
  if (s.robots.length > config.robots.length) {
    throw new Error(
      `Fixture has ${s.robots.length} robots but the fleet config declares ${config.robots.length}. ` +
        `Run: npm run fleet:n -- --robots ${s.robots.length}`,
    );
  }
  for (const cell of s.map.cells) cell.blocked = false;
  s.robots.forEach((r, i) => {
    r.position = { ...config.robots[i].origin };
    r.home = { ...r.position };
  });
  s.tasks.forEach((t, i) => {
    t.pickup = { ...s.robots[i].position };
    // Robots 0 and 1 exchange rows through the shared column; the rest run
    // straight to their own row. Generates for any N without colliding goals.
    t.dropoff = { x: 3, y: crossing && i < 2 ? 4 - 3 * i : 1 + 3 * i };
  });
  if (s.tasks.length !== s.robots.length) {
    throw new Error(`Fixture needs one task per robot; got ${s.tasks.length} tasks for ${s.robots.length} robots`);
  }
  const obstacle = s.map.cells.find((c) => c.position.x === 5 && c.position.y === 4);
  if (!obstacle) throw new Error('Nav2 obstacle cell (5,4) missing from fixture map');
  obstacle.blocked = true;
  return config;
}
