/**
 * Cloud mode demo — expects JOIN credentials in env (from platform POST /api/v1/sessions).
 *
 *   export CLOUD_SESSION_JSON='{"session_id":"…","join_token":"…",…}'
 *   npm run demo:cloud
 */
import { connectVoiceSession } from "../src/index.js";

const raw = process.env.CLOUD_SESSION_JSON;
if (!raw) {
  console.error("Set CLOUD_SESSION_JSON from platform POST /api/v1/sessions");
  process.exit(1);
}

const body = JSON.parse(raw) as {
  session_id: string;
  join_token: string;
  signaling_url: string;
  room_id: string;
};

const client = await connectVoiceSession({
  mode: "cloud",
  credentials: {
    sessionId: body.session_id,
    joinToken: body.join_token,
    signalingUrl: body.signaling_url,
    roomId: body.room_id,
  },
});

console.log("connected", { peerId: client.peerId, roomId: client.roomId });
client.on("peer-joined", (peerId) => console.log("peer-joined", peerId));

setTimeout(() => {
  client.disconnect();
  process.exit(0);
}, 3000);
