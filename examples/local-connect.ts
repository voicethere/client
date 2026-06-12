/**
 * Local mode demo — connect to runner plain signaling.
 *
 *   npm run demo:local
 */
import { connectVoiceSession } from "../src/index.js";

const signalingUrl = process.env.SIGNALING_URL ?? "ws://127.0.0.1:8080/ws";
const sessionId = process.env.SESSION_ID ?? "local-dev";

const client = await connectVoiceSession({
  mode: "local",
  signalingUrl,
  sessionId,
});

console.log("connected", { peerId: client.peerId, roomId: client.roomId });
client.on("peer-joined", (peerId) => console.log("peer-joined", peerId));

setTimeout(() => {
  client.disconnect();
  process.exit(0);
}, 3000);
