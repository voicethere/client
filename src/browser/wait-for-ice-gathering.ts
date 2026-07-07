/**
 * Wait until ICE gathering completes so localDescription includes relay candidates.
 * Matches {@link @node-webrtc-rust/signaling} auto-negotiate and VoiceAgentSessionHost.
 *
 * Browser RTCPeerConnection implements EventTarget; Node (@node-webrtc-rust/sdk) uses
 * `onicegatheringstatechange` only — chain any existing handler when falling back.
 */
export function waitForIceGatheringComplete(
  pc: RTCPeerConnection,
  timeoutMs = 30_000,
): Promise<void> {
  if (pc.iceGatheringState === "complete") {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;

    const timer = setTimeout(() => {
      unsubscribe?.();
      reject(new Error(`ICE gathering timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const onChange = () => {
      if (pc.iceGatheringState !== "complete") return;
      clearTimeout(timer);
      unsubscribe?.();
      resolve();
    };

    unsubscribe = subscribeIceGatheringStateChange(pc, onChange);
    onChange();
  });
}

function subscribeIceGatheringStateChange(
  pc: RTCPeerConnection,
  handler: () => void,
): () => void {
  if (typeof pc.addEventListener === "function") {
    pc.addEventListener("icegatheringstatechange", handler);
    return () => pc.removeEventListener("icegatheringstatechange", handler);
  }

  const previous = pc.onicegatheringstatechange;
  const wrapped = (event: Event) => {
    previous?.call(pc, event);
    handler();
  };
  pc.onicegatheringstatechange = wrapped;
  return () => {
    if (pc.onicegatheringstatechange === wrapped) {
      pc.onicegatheringstatechange = previous;
    }
  };
}
