import { expect, test } from "@playwright/test";

import { startStereoMixServer, type StereoMixServer } from "./server.ts";

type Page = import("@playwright/test").Page;
type Win = {
  __connect(wsUrl: string, sessionId: string, preferStereoPlayback: boolean | undefined, peerId: string): Promise<void>;
  __measure(ms: number): Promise<{ leftRms: number; rightRms: number; channelCount: number }>;
  __close(): Promise<void>;
  __lastAnswerSdp?: string;
};

let srv: StereoMixServer;
test.beforeAll(async () => {
  srv = await startStereoMixServer();
});
test.afterAll(async () => {
  await srv?.close();
});

const db = (x: number): number => 20 * Math.log10(Math.max(x, 1e-9));

function opusFmtp(sdp: string | undefined): string {
  if (!sdp) return "none";
  const pts = [...sdp.matchAll(/^a=rtpmap:(\d+) opus\//gim)].map((m) => m[1]);
  const lines = sdp.split(/\r?\n/).filter((l) => pts.some((pt) => l.startsWith(`a=fmtp:${pt} `)));
  return lines.join(" | ") || "none";
}

function report(mode: string, listener: string, l: number, r: number, ch: number | string, fmtp: string): void {
  console.log(
    `mode=${mode} listener=${listener} leftDb=${db(l).toFixed(1)} rightDb=${db(r).toFixed(1)} ` +
      `diffDb=${(db(l) - db(r)).toFixed(1)} channelCount=${ch} answerFmtp=${fmtp}`,
  );
}

async function measureBrowser(page: Page, ms: number) {
  return page.evaluate((m) => (window as unknown as Win).__measure(m), ms);
}

async function run(
  page: Page,
  mode: string,
  preferStereoPlayback: boolean | undefined,
  peerId: string,
): Promise<{ diffDb: number; fmtp: string }> {
  await page.goto("/page.html");
  await page.evaluate(
    ([u, s, p, id]) => (window as unknown as Win).__connect(u, s, p, id),
    [srv.wsUrl, srv.listenerSessionId, preferStereoPlayback, peerId] as const,
  );
  await srv.configureMix(peerId, "client-node");

  const deadline = Date.now() + 20_000;
  for (;;) {
    const e = await measureBrowser(page, 200);
    if (e.leftRms + e.rightRms > 0.01) break;
    if (Date.now() > deadline) throw new Error("no audio energy in browser listener");
    await page.waitForTimeout(100);
  }
  const [b, n] = await Promise.all([measureBrowser(page, 1000), srv.measureNodeListener(1000)]);
  const sdp = await page.evaluate(() => (window as unknown as Win).__lastAnswerSdp);
  const fmtp = opusFmtp(sdp);
  report(mode, "browser", b.leftRms, b.rightRms, b.channelCount, fmtp);
  report(mode, "node", n.left, n.right, 2, "n/a");
  expect(b.leftRms + b.rightRms).toBeGreaterThan(0.01);
  await page.evaluate(() => (window as unknown as Win).__close());
  return { diffDb: db(b.leftRms) - db(b.rightRms), fmtp };
}

test("browser listener hears a hard-left mix on the left", async ({ page }) => {
  const { diffDb, fmtp } = await run(page, "default", undefined, "client-browser-1");
  expect(fmtp).toContain("stereo=1");
  expect(diffDb).toBeGreaterThanOrEqual(20);
});

test("preferStereoPlayback false: browser decodes mono (guard can fail)", async ({ page }) => {
  const { diffDb } = await run(page, "preferStereoPlayback=false", false, "client-browser-2");
  expect(diffDb).toBeLessThan(5);
});

test("client Node runtime connects and hears the hard-left mix", async () => {
  // Real client Node path: connectBrowserVoiceSession + createNodeWebRtcRuntime (webrtc-rs).
  // A rewritten answer fails here with "new sdp does not match previous answer".
  const listener = await srv.connectClientNodeListener();
  await srv.configureMix("", "client-node", listener.peerId);
  const deadline = Date.now() + 20_000;
  for (;;) {
    const e = await listener.measure(300);
    if (e.left + e.right > 0.01) break;
    if (Date.now() > deadline) throw new Error("no audio energy in client Node runtime listener");
  }
  const m = await listener.measure(1000);
  report("client-node-runtime", "node", m.left, m.right, 2, "n/a");
  expect(db(m.left) - db(m.right)).toBeGreaterThanOrEqual(20);
});
