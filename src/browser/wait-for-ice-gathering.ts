/**
 * Wait until ICE gathering completes so localDescription includes relay candidates.
 * Matches {@link @node-webrtc-rust/signaling} auto-negotiate and VoiceAgentSessionHost.
 */
export function waitForIceGatheringComplete(
  pc: RTCPeerConnection,
  timeoutMs = 30_000,
): Promise<void> {
  if (pc.iceGatheringState === "complete") {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      reject(new Error(`ICE gathering timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const onChange = () => {
      if (pc.iceGatheringState !== "complete") return;
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    };

    pc.addEventListener("icegatheringstatechange", onChange);
  });
}
