import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  attachAudioVisualizer,
  drawIdleVisualizer,
} from "./audio-visualizer.js";

type MockCtx = CanvasRenderingContext2D & {
  fillRectCalls: number;
};

function createMockCanvas(width = 200, height = 80): {
  canvas: HTMLCanvasElement;
  ctx: MockCtx;
} {
  const ctx = {
    fillRectCalls: 0,
    clearRect: vi.fn(),
    lineWidth: 0,
    strokeStyle: "",
    fillStyle: "",
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fillRect: vi.fn(() => {
      ctx.fillRectCalls += 1;
    }),
  } as unknown as MockCtx;

  const canvas = {
    width,
    height,
    getContext: vi.fn(() => ctx),
  } as unknown as HTMLCanvasElement;

  return { canvas, ctx };
}

function createMockMediaStream(trackReadyState: MediaStreamTrackState): MediaStream {
  const track = {
    kind: "audio",
    readyState: trackReadyState,
    addEventListener: vi.fn(),
  } as unknown as MediaStreamTrack;
  return {
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
}

function installAudioContextMock(): void {
  const analyser = {
    fftSize: 2048,
    smoothingTimeConstant: 0.75,
    frequencyBinCount: 16,
    connect: vi.fn(),
    getByteTimeDomainData: vi.fn((buffer: Uint8Array) => {
      for (let i = 0; i < buffer.length; i++) buffer[i] = 128;
    }),
    getByteFrequencyData: vi.fn((buffer: Uint8Array) => {
      for (let i = 0; i < buffer.length; i++) buffer[i] = 200;
    }),
  };

  const audioCtx = {
    state: "running",
    resume: vi.fn(),
    close: vi.fn(),
    createAnalyser: vi.fn(() => analyser),
    createMediaStreamSource: vi.fn(() => ({ connect: vi.fn() })),
    createMediaElementSource: vi.fn(() => ({ connect: vi.fn() })),
    destination: {},
  };

  vi.stubGlobal(
    "AudioContext",
    vi.fn(() => audioCtx),
  );
}

describe("drawIdleVisualizer", () => {
  it("clears the canvas and strokes a flat midline without bars", () => {
    const { canvas, ctx } = createMockCanvas(120, 60);
    drawIdleVisualizer(ctx, canvas, "#38bdf8");

    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 120, 60);
    expect(ctx.lineWidth).toBe(2);
    expect(ctx.strokeStyle).toBe("#38bdf8");
    expect(ctx.moveTo).toHaveBeenCalledWith(0, 30);
    expect(ctx.lineTo).toHaveBeenCalledWith(120, 30);
    expect(ctx.stroke).toHaveBeenCalled();
    expect(ctx.fillRectCalls).toBe(0);
  });
});

describe("attachAudioVisualizer", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    installAudioContextMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stop() draws idle (clear + midline, no frequency bars)", () => {
    const { canvas, ctx } = createMockCanvas();
    const stream = createMockMediaStream("live");
    const visualizer = attachAudioVisualizer({ canvas, mediaStream: stream });

    ctx.fillRectCalls = 0;
    vi.mocked(ctx.clearRect).mockClear();
    vi.mocked(ctx.stroke).mockClear();

    visualizer.stop();

    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, canvas.width, canvas.height);
    expect(ctx.moveTo).toHaveBeenCalledWith(0, canvas.height / 2);
    expect(ctx.lineTo).toHaveBeenCalledWith(canvas.width, canvas.height / 2);
    expect(ctx.stroke).toHaveBeenCalled();
    expect(ctx.fillRectCalls).toBe(0);
  });

  it("draws idle when the tapped stream has no live audio track", () => {
    const { canvas, ctx } = createMockCanvas();
    const stream = createMockMediaStream("ended");

    attachAudioVisualizer({ canvas, mediaStream: stream });

    expect(ctx.clearRect).toHaveBeenCalled();
    expect(ctx.moveTo).toHaveBeenCalledWith(0, canvas.height / 2);
    expect(ctx.lineTo).toHaveBeenCalledWith(canvas.width, canvas.height / 2);
    expect(ctx.fillRectCalls).toBe(0);
  });
});
