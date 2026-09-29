/** Fixed development geometry matched to fleet.launch.py physical origins. */
export function configureNav2Fleet(s, crossing=true) {
  for(const cell of s.map.cells)cell.blocked=false;
  s.robots.forEach((r,i)=>{r.position={x:1,y:1+3*i};r.home={...r.position};});
  s.tasks.forEach((t,i)=>{t.pickup={...s.robots[i].position};t.dropoff={x:3,y:crossing&&i<2?4-3*i:1+3*i};});
  s.map.cells.find(c=>c.position.x===5&&c.position.y===4).blocked=true;
}
