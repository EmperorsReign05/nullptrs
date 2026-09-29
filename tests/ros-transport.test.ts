import { expect, it } from "vitest";
import { RosBridge } from "../src/core/distributed/ros-transport";

// Tests the local framing/lifecycle adapter, not DDS. Actual ROS delivery is
// independently exercised by the ROS package's integration checks.
const program = `
const readline=require('node:readline');
process.stdout.write(JSON.stringify({event:'ready',id:'A',rmw:'rmw_fastrtps_cpp'})+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.op==='send')process.stdout.write(JSON.stringify({event:'message',channel:m.channel,message:{...m.message,from:'B'}})+'\\n');
});`;
const delay = () => new Promise(r => setTimeout(r, 20));
it("separates channels, filters cut peers, and fails closed after shutdown", async () => {
  const bridge = await RosBridge.start({ id: "A", members: ["A", "B"], session: "test", command: [process.execPath, "-e", program, "--"] });
  try {
    const motion = bridge.channel<{ from: string; value: number }>("motion"), ownership = bridge.channel("ownership");
    motion.send("B", { from: "A", value: 7 });
    for (let i=0;i<50 && motion.stats.received===0;i++) await delay();
    expect(motion.drain()).toEqual([{ from: "B", value: 7 }]); expect(ownership.drain()).toEqual([]);
    motion.setReachable("B", false); motion.send("B", { from: "A", value: 9 });
    expect(motion.stats.dropped).toBe(1); expect(motion.stats.sent).toBe(1);
    bridge.close(); expect(() => motion.drain()).toThrow("closed");
  } finally { bridge.close(); }
});
it("rejects wrong middleware instead of reporting DDS ready", async () => {
  await expect(RosBridge.start({ id: "A", members: ["A"], session: "test", command: [process.execPath, "-e", "console.log(JSON.stringify({event:'ready',id:'A',rmw:'not-fast-dds'}));setInterval(()=>{},1000)", "--"] })).rejects.toThrow("middleware");
});
