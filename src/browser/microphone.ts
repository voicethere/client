/**
 * Browser microphone acquisition with silent synthetic fallback when GUM is denied
 * or unavailable. Used by voice sessions to keep an outbound audio track live.
 */

export type AudioInputState = "live" | "denied" | "unavailable" | "synthetic";

export type AudioInputDevice = {
  deviceId: string;
  label: string;
};

export type AcquireAudioInputOptions = {
  getUserMedia?: (
    constraints: MediaStreamConstraints,
  ) => Promise<MediaStream>;
  deviceId?: string | null;
};

export type AcquireAudioInputResult = {
  stream: MediaStream;
  state: AudioInputState;
  deviceId: string | null;
  /** Stops tracks and closes synthetic AudioContext resources when applicable. */
  dispose: () => void;
};

function buildAudioConstraints(
  deviceId?: string | null,
): boolean | MediaTrackConstraints {
  if (deviceId) {
    return { deviceId: { ideal: deviceId } };
  }
  return true;
}

function classifyGumError(error: unknown): "denied" | "unavailable" {
  if (error instanceof DOMException) {
    if (
      error.name === "NotAllowedError" ||
      error.name === "PermissionDeniedError"
    ) {
      return "denied";
    }
    if (
      error.name === "NotFoundError" ||
      error.name === "DevicesNotFoundError" ||
      error.name === "OverconstrainedError"
    ) {
      return "unavailable";
    }
  }
  if (error instanceof Error) {
    if (/not allowed|permission/i.test(error.message)) {
      return "denied";
    }
  }
  return "unavailable";
}

function readStreamDeviceId(stream: MediaStream): string | null {
  const track = stream.getAudioTracks()[0];
  if (!track) return null;
  const settings = track.getSettings?.();
  const id = settings?.deviceId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** Stop every track on a stream (no-op for null). */
export function stopMicStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => {
    try {
      track.stop();
    } catch {
      /* ignore */
    }
  });
}

/**
 * Silent outbound mic substitute — keeps WebRTC outbound audio negotiation alive
 * when real microphone access is denied or unavailable.
 */
export function createSyntheticMicStream(): {
  stream: MediaStream;
  dispose: () => void;
} {
  type WebAudioContextCtor = typeof AudioContext;
  const AudioCtx =
    typeof globalThis.AudioContext !== "undefined"
      ? globalThis.AudioContext
      : (globalThis as { webkitAudioContext?: WebAudioContextCtor })
          .webkitAudioContext;

  if (!AudioCtx) {
    let readyState: MediaStreamTrackState = "live";
    const track = {
      kind: "audio",
      get readyState() {
        return readyState;
      },
      stop: () => {
        readyState = "ended";
      },
      getSettings: () => ({}),
    } as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    } as MediaStream;
    return {
      stream,
      dispose: () => track.stop(),
    };
  }

  const ctx = new AudioCtx();
  const dest = ctx.createMediaStreamDestination();
  const gain = ctx.createGain();
  gain.gain.value = 0;
  const osc = ctx.createOscillator();
  osc.connect(gain);
  gain.connect(dest);
  osc.start();
  const stream = dest.stream;
  return {
    stream,
    dispose: () => {
      try {
        osc.stop();
      } catch {
        /* ignore */
      }
      stopMicStream(stream);
      void ctx.close().catch(() => undefined);
    },
  };
}

function syntheticAcquireResult(
  state: Extract<AudioInputState, "denied" | "unavailable" | "synthetic">,
): AcquireAudioInputResult {
  const { stream, dispose } = createSyntheticMicStream();
  return {
    stream,
    state,
    deviceId: null,
    dispose,
  };
}

/**
 * Acquire microphone audio, falling back to a silent synthetic stream on deny or error.
 * Never throws solely because GUM failed — callers always receive a usable stream.
 */
export async function acquireAudioInput(
  options: AcquireAudioInputOptions = {},
): Promise<AcquireAudioInputResult> {
  const getUserMedia = options.getUserMedia;
  if (!getUserMedia) {
    return syntheticAcquireResult("unavailable");
  }

  try {
    const stream = await getUserMedia({
      audio: buildAudioConstraints(options.deviceId),
      video: false,
    });
    const deviceId = readStreamDeviceId(stream);
    return {
      stream,
      state: "live",
      deviceId,
      dispose: () => stopMicStream(stream),
    };
  } catch (error: unknown) {
    const failure = classifyGumError(error);
    return syntheticAcquireResult(failure);
  }
}

/** List audio input devices (empty when `mediaDevices` is unavailable). */
export async function listAudioInputDevices(): Promise<AudioInputDevice[]> {
  if (!navigator?.mediaDevices?.enumerateDevices) {
    return [];
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === "audioinput")
    .map((device) => ({
      deviceId: device.deviceId,
      label:
        device.label.trim().length > 0
          ? device.label
          : `Microphone ${device.deviceId.slice(0, 8) || "default"}`,
    }));
}

export function getStreamDeviceId(stream: MediaStream | null): string | null {
  if (!stream) return null;
  return readStreamDeviceId(stream);
}
