/**
 * Notices that the machine was asleep during a run. A laptop that sleeps in the middle of a
 * turn produces a huge "latency" that says nothing about the service.
 *
 * Once a second it compares the wall clock (keeps running while asleep) with the monotonic
 * clock (stops while asleep on macOS and Linux). A blocked event loop moves both clocks
 * alike, so only a real suspend shows up as a difference of more than `gapThresholdMs`.
 */

/** `at` is an ISO timestamp (the nwr summariser prints it); `gap_ms` the time asleep. */
export type SuspendGap = { at: string; gap_ms: number };

export class SuspendWatch {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastWall: number;
  private lastMono: number;
  readonly gaps: SuspendGap[] = [];

  constructor(
    private readonly wall: () => number = Date.now,
    private readonly mono: () => number = () => performance.now(),
    private readonly gapThresholdMs = 5000,
  ) {
    this.lastWall = wall();
    this.lastMono = mono();
  }

  /** One tick. Public so tests can drive it with fake clocks. */
  tick(): void {
    const wall = this.wall();
    const mono = this.mono();
    const gap = wall - this.lastWall - (mono - this.lastMono);
    if (gap > this.gapThresholdMs) {
      this.gaps.push({
        at: new Date(wall).toISOString(),
        gap_ms: Math.round(gap),
      });
    }
    this.lastWall = wall;
    this.lastMono = mono;
  }

  start(intervalMs = 1000): void {
    if (this.timer) return;
    this.lastWall = this.wall();
    this.lastMono = this.mono();
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get suspended(): boolean {
    return this.gaps.length > 0;
  }
}
