/** Browser shim so @node-webrtc-rust/signaling can use native WebSocket. */
const BrowserWebSocket = globalThis.WebSocket;

export default BrowserWebSocket;
export { BrowserWebSocket as WebSocket };
