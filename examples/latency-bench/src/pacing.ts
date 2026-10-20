/**
 * One writer on the mic track, paced at real time.
 *
 * The Node WebRTC runtime sends every frame as soon as `writeSample` is called, so whatever
 * is written is what goes on the wire. This pump is the only writer: it sends silence while
 * idle and the clip frames while a turn plays. Frame n is due at `anchor + n x 20 ms`. After a
 * stall of more than 100 ms it re-anchors instead of sending a burst to catch up.
 */

export const FRAME_MS = 20;
/** 20 ms of 48 kHz stereo s16le. */
export const FRAME_BYTES = 3840;
/** Priming frame the runtime needs before RTP flows: 5 ms of 48 kHz stereo. */
export const KICK_BYTES = 960;
export const KICK_MS = 5;
export const REANCHOR_BEHIND_MS = 5 * FRAME_MS;

export type PumpTrack = {
  writeSample(data: Uint8Array, durationMs: number): Promise<void>;
};

export type PumpClock = {
  /** Monotonic ms. */
  now(): number;
  sleep(ms: number): Promise<void>;
};

export const realClock: PumpClock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * What to do after frame number `sent` was written: sleep `waitMs`, or re-anchor when the
 * schedule is more than {@link REANCHOR_BEHIND_MS} behind.
 */
export function nextFrameWait(input: {
  anchorMs: number;
  sent: number;
  nowMs: number;
}): { reanchor: boolean; waitMs: number } {
  const waitMs = input.anchorMs + input.sent * FRAME_MS - input.nowMs;
  if (waitMs < -REANCHOR_BEHIND_MS) return { reanchor: true, waitMs: 0 };
  return { reanchor: false, waitMs: Math.max(0, waitMs) };
}

type PendingClip = {
  frames: Uint8Array[];
  next: number;
  resolve: (speechEndAtMs: number) => void;
  reject: (error: Error) => void;
};

export class PacedMicPump {
  private readonly silence = new Uint8Array(FRAME_BYTES);
  private pending: PendingClip | null = null;
  private stopped = false;
  private loop: Promise<void> | null = null;
  /** Number of times the schedule was re-anchored after a stall. */
  reanchors = 0;
  /** Write error that ended the loop, if any. */
  failure: Error | null = null;

  constructor(
    private readonly track: PumpTrack,
    private readonly clock: PumpClock = realClock,
  ) {}

  start(): void {
    if (this.loop) return;
    this.loop = this.run();
  }

  /** Asks the loop to end after the frame being written. */
  requestStop(): void {
    this.stopped = true;
  }

  /** Resolves when the loop has ended. */
  async finished(): Promise<void> {
    await this.loop;
  }

  async stop(): Promise<void> {
    this.requestStop();
    await this.finished();
  }

  /**
   * Plays `frames` (each {@link FRAME_BYTES} long) and resolves with the clock reading taken
   * right after the last frame was written: the end of the caller's speech.
   */
  play(frames: Uint8Array[]): Promise<number> {
    if (this.pending) throw new Error("a clip is already playing");
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<number>((resolve, reject) => {
      this.pending = { frames, next: 0, resolve, reject };
    });
  }

  private async run(): Promise<void> {
    try {
      await this.track.writeSample(new Uint8Array(KICK_BYTES), KICK_MS);
      let anchor = this.clock.now();
      let sent = 0;
      while (!this.stopped) {
        const clip = this.pending;
        const frame = clip ? clip.frames[clip.next] : undefined;
        await this.track.writeSample(frame ?? this.silence, FRAME_MS);
        if (clip && frame) {
          clip.next += 1;
          if (clip.next >= clip.frames.length) {
            this.pending = null;
            clip.resolve(this.clock.now());
          }
        }
        sent += 1;
        const step = nextFrameWait({
          anchorMs: anchor,
          sent,
          nowMs: this.clock.now(),
        });
        if (step.reanchor) {
          anchor = this.clock.now();
          sent = 0;
          this.reanchors += 1;
        } else if (step.waitMs > 0) {
          await this.clock.sleep(step.waitMs);
        }
      }
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      this.pending?.reject(this.failure);
      this.pending = null;
    }
  }
}
