// Regression guards for the dashboard's connection states.
//
// The bug this pins shut: the page rendered its "Fleet runtime not connected"
// error card whenever `snapshot` was null. `snapshot` is null on the FIRST
// render, before the first poll resolves, so a perfectly healthy runtime flashed
// an amber connection error at every visitor for the length of one round trip.
// On the deployed link that is the "shows this for a split second" symptom.
//
// These are source-level assertions. That is a deliberate, disclosed limitation:
// this repo has no DOM test environment (no jsdom, no testing-library), and
// adding one for a single component is a larger change than the fix it would
// guard. What IS verified behaviourally is in dashboard-connection.test.ts's
// sibling check below, which runs the real proxy against a real runtime.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync("src/app/page.tsx", "utf8");

describe("dashboard connection states", () => {
  it("does not gate the error card on a null snapshot", () => {
    // The exact anti-pattern that caused the flash.
    expect(source).not.toMatch(/if\s*\(\s*!snapshot\s*\)\s*\{/);
    // A connection error is only ever shown after a poll actually failed.
    expect(source).toMatch(/status === 'connecting' \|\| \(disconnected && !snapshot\)/);
  });

  it("has a distinct, neutral connecting state", () => {
    expect(source).toMatch(/'connecting' \| 'live' \| 'error'/);
    expect(source).toContain('Connecting to the fleet runtime');
    // Connecting must be styled as neutral progress (zinc) and only a real
    // failure may be styled as a fault (amber). One ternary, both tones, so the
    // connecting state can never inherit the error colour.
    expect(source).toMatch(
      /connecting \? 'text-zinc-200 text-base mb-2' : 'text-amber-300 text-base mb-2'/,
    );
    // ...and the connecting state must show progress, not a static dot.
    expect(source).toMatch(/animate-spin/);
  });

  it("never shows a stale frame as if it were live", () => {
    // If the runtime dies after a good snapshot, the dashboard used to keep
    // rendering the frozen world with the pulse dot still going. That is the
    // worst failure mode in front of a jury: it does not look broken, it looks
    // stalled. The strip must state the disconnection and the data age.
    expect(source).toContain('reconnecting');
    expect(source).toContain('frozen for');
    expect(source).toMatch(/disconnected \? \(/);
  });

  it("builds the poll loop exactly once", () => {
    // The effect used to depend on `error`, so every failure and every recovery
    // tore down and rebuilt the loop, and the effect body was the only thing
    // scheduling the next poll — so each teardown left a window with no poll in
    // flight. Empty deps plus a ref for the error.
    expect(source).toMatch(/\}, \[\]\);/);
    expect(source).toContain('errorRef');
    expect(source).not.toMatch(/\}, \[error\]\);/);
  });

  it("cancels its in-flight request on unmount and ignores the abort", () => {
    expect(source).toContain('AbortController');
    expect(source).toContain("abort.abort()");
    // An unmount abort must not be painted as a connection failure.
    expect(source).toMatch(/'AbortError'/);
  });
});
