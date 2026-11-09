export type AudioPlaybackState = "idle" | "playing" | "blocked";

export type AudioPlayOutcome = "playing" | "blocked" | "aborted";

/** One play() attempt. Only a rejection named AbortError is "aborted". */
async function playOnce(el: HTMLAudioElement): Promise<AudioPlayOutcome> {
  try {
    await el.play();
    return "playing";
  } catch (err) {
    const name = (err as { name?: unknown } | null)?.name;
    return name === "AbortError" ? "aborted" : "blocked";
  }
}

/**
 * Start playback and report the outcome. An AbortError means a new load
 * interrupted play() (the page replaced `srcObject`), not that the browser
 * blocked autoplay, so it is retried once on the new source. At most one retry.
 */
export async function playAudioElement(
  el: HTMLAudioElement,
): Promise<AudioPlayOutcome> {
  const first = await playOnce(el);
  if (first !== "aborted") return first;
  await Promise.resolve();
  const second = await playOnce(el);
  return second === "playing"
    ? "playing"
    : second === "aborted"
      ? "aborted"
      : "blocked";
}

/**
 * Attempt to start playback on an audio element (e.g. after user gesture or ontrack).
 * Returns false on failure without throwing. A play() that stays interrupted
 * after the single retry is not a browser block, but still returns false.
 */
export async function unlockAudioPlayback(
  el: HTMLAudioElement,
): Promise<boolean> {
  return (await playAudioElement(el)) === "playing";
}

/**
 * Create a hidden autoplay audio element for inbound agent TTS when the caller
 * does not supply one. Returns null when no DOM is available (Node runtime).
 */
export function createHiddenAudioElement(): HTMLAudioElement | null {
  if (typeof document === "undefined") return null;
  const el = document.createElement("audio");
  el.autoplay = true;
  el.setAttribute("playsinline", "");
  el.style.display = "none";
  document.body.append(el);
  return el;
}
