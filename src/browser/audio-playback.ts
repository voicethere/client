export type AudioPlaybackState = "idle" | "playing" | "blocked";

/**
 * Attempt to start playback on an audio element (e.g. after user gesture or ontrack).
 * Returns false on failure without throwing.
 */
export async function unlockAudioPlayback(
  el: HTMLAudioElement,
): Promise<boolean> {
  try {
    await el.play();
    return true;
  } catch {
    return false;
  }
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
