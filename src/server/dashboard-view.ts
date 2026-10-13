// The slice of a runtime snapshot the dashboard actually draws.
//
// The full snapshot carries every peer's ownership table, charging state and a
// 200-entry event log, and the task list grows for the life of the runtime. It
// reached ~400 KB at ten robots after ten minutes, fetched four times a second:
// about 1.6 MB/s to draw twenty markers, and a JSON parse plus a full re-render
// of every historical task on each poll. None of the dropped fields are read by
// the page. Scripts and benchmarks keep reading the full snapshot from /state.

import type { Task } from "../core/types";

type Snapshot = {
  world: { tasks: Task[] } & Record<string, unknown>;
  events: unknown[];
} & Record<string, unknown>;

/** Recently completed jobs kept for the task panel; the totals stay exact. */
const RECENT_COMPLETED = 12;
const RECENT_EVENTS = 20;

export function dashboardView<S extends Snapshot>(snapshot: S) {
  const { ownership: _ownership, charging: _charging, deployment: _deployment, ...rest } = snapshot;
  void _ownership; void _charging; void _deployment;
  const tasks = snapshot.world.tasks;
  const completed = tasks.filter((t) => t.status === "completed");
  return {
    ...rest,
    events: snapshot.events.slice(-RECENT_EVENTS),
    world: { ...snapshot.world, tasks: [...tasks.filter((t) => t.status !== "completed"), ...completed.slice(-RECENT_COMPLETED)] },
    taskTotals: { total: tasks.length, completed: completed.length },
  };
}
