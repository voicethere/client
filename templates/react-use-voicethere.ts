/**
 * React hook starter — copy into your dashboard app.
 *
 * Requires `@voicethere/client@^0.3.0` and a deployed project.
 */
import { useCallback, useRef, useState } from "react";

import {
  connectBrowserSession,
  createDebugConsole,
  startSession,
  type BrowserSessionMode,
} from "@voicethere/client/browser";

export function useVoiceThereSession(
  projectId: string,
  mode: BrowserSessionMode = "chat",
) {
  const [status, setStatus] = useState("idle");
  const sessionRef = useRef<Awaited<
    ReturnType<typeof connectBrowserSession>
  > | null>(null);
  const debug = useRef(createDebugConsole()).current;

  const connect = useCallback(async () => {
    setStatus("provisioning");
    const provision = await startSession({
      apiBase: window.location.origin,
      projectId,
      onStatus: (s) => setStatus(s.status),
      debug,
    });
    if (!provision.ok) {
      setStatus(provision.message);
      return;
    }
    sessionRef.current = await connectBrowserSession({
      mode,
      credentials: provision.credentials,
      onDebugEvent: debug,
      onConnectionStatus: (connectionStatus) => {
        setStatus(
          connectionStatus.ready ? "connected" : `webrtc:${connectionStatus.phase}`,
        );
      },
    });
    await sessionRef.current.waitForConnected();
    setStatus("connected");
  }, [debug, mode, projectId]);

  const disconnect = useCallback(() => {
    sessionRef.current?.disconnect();
    sessionRef.current = null;
    setStatus("idle");
  }, []);

  return { status, connect, disconnect, debug };
}
