import { BrowserSessionModeType } from "../../src/browser/browser-session.ts";
import {
  createVoiceThereWidget,
  type VoiceThereWidget,
} from "../../src/embed/index.ts";

type W = Window & {
  __widget?: VoiceThereWidget;
  __session?: { getMicStream(): MediaStream | null };
  __mountWidget?: (wsUrl: string, sessionId: string) => void;
};
const w = window as unknown as W;

w.__mountWidget = (wsUrl, sessionId) => {
  w.__widget = createVoiceThereWidget({
    display: "inline",
    mode: BrowserSessionModeType.VoiceAndData,
    mount: document.getElementById("host")!,
    onSession: (session) => {
      w.__session = session;
    },
    startSession: async () => ({
      ok: true,
      jobId: "job",
      buildId: null,
      credentials: {
        session_id: sessionId,
        mode: "voice+data",
        join_token: "",
        signaling_url: wsUrl,
        room_id: sessionId,
        ice_servers: [],
        expires_at: "",
      } as never,
    }),
  });
};
