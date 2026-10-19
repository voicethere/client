import { describe, expect, it } from "vitest";

import { SuspendWatch } from "./suspend-watch.js";

describe("SuspendWatch", () => {
  it("records a gap where the wall clock ran but the monotonic clock did not", () => {
    let wall = 1_000_000;
    let mono = 5_000;
    const watch = new SuspendWatch(
      () => wall,
      () => mono,
      5000,
    );
    wall += 1000;
    mono += 1000;
    watch.tick();
    expect(watch.suspended).toBe(false);
    wall += 60_000; // asleep for a minute
    mono += 1000;
    watch.tick();
    expect(watch.gaps).toEqual([
      { at: new Date(wall).toISOString(), gap_ms: 59_000 },
    ]);
    expect(watch.suspended).toBe(true);
  });

  it("does not flag a blocked event loop (both clocks advance)", () => {
    let wall = 0;
    let mono = 0;
    const watch = new SuspendWatch(
      () => wall,
      () => mono,
      5000,
    );
    wall += 20_000;
    mono += 20_000;
    watch.tick();
    expect(watch.suspended).toBe(false);
  });
});
