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
const startup = readFileSync("src/components/dashboard/StartupScreen.tsx", "utf8");

describe("dashboard connection states", () => {
  it("does not show an error card for a null snapshot", () => {
    // With nothing to draw yet the page shows the start-up screen, never an
    // error card: a slow first answer is a cold start, not an outage. A cached
    // last frame is drawn instead when there is one, labelled as such.
    expect(source).toMatch(/if \(!snapshot\) \{\s*return \(/);
    expect(source).toContain('<StartupScreen waitedS={waitedS} failed={disconnected}');
    expect(source).not.toContain("'Fleet runtime not connected.'");
    expect(source).toContain('showing last known frame');
  });

  it("presents a slow or failed first answer as start-up, with progress", () => {
    expect(source).toMatch(/'connecting' \| 'live' \| 'error'/);
    expect(startup).toContain('Connecting to the fleet');
    expect(startup).toContain('Waking up the fleet server');
    // Only a wait far past a normal cold start is called a problem, and even
    // then it is amber, not red, and offers a retry while polling continues.
    expect(startup).toMatch(/const stalled = waitedS >= GIVE_UP_AFTER_S/);
    expect(startup).toContain('Retry now');
    expect(startup).toMatch(/animate-spin/);
    // Local setup instructions are for developers, behind a disclosure.
    expect(startup).toMatch(/<details[\s\S]*npm run fleet/);
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
    // flight. The loop's only dependency is the stable accept callback.
    expect(source).toMatch(/\}, \[accept\]\);/);
    expect(source).not.toMatch(/\}, \[error\]\);/);
  });

  it("cancels its in-flight request on unmount and ignores the abort", () => {
    expect(source).toContain('AbortController');
    expect(source).toContain("abort.abort()");
    // An unmount abort must not be painted as a connection failure.
    expect(source).toMatch(/'AbortError'/);
  });
});
