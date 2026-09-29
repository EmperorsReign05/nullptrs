import { expect, it } from "vitest";
import { DistributedFleet } from "../src/core/distributed/fleet";
import { createInitialWorld } from "../src/core/simulation/state";
it("local lifecycle goal overrides routing without changing task ownership", () => {
 const world=createInitialWorld(), robot=world.robots[0];
 robot.position={x:0,y:0}; robot.currentTaskId="owned";
 const task={id:"owned",pickup:{x:0,y:3},dropoff:{x:0,y:4},weight:1,priority:1,createdAt:0,status:"assigned" as const,assignedRobotId:robot.id};
 let override: {x:number;y:number}|null|undefined={x:2,y:0};
 const fleet=new DistributedFleet(world.map,[robot],[task],{goalOverride:()=>override,arrivalAllowed:()=>false});
 fleet.advance(0);expect(robot.position).toEqual({x:1,y:0});expect(robot.currentTaskId).toBe("owned");expect(task.status).toBe("assigned");
 override=null;fleet.advance(1);expect(robot.position).toEqual({x:1,y:0});
 override=undefined;fleet.advance(2);expect(fleet.getAgent(robot.id)!.getLocal().path.at(-1)).toEqual(task.pickup);
});
