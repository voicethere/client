import { expect, test } from "@playwright/test";

import { startStereoMixServer, type StereoMixServer } from "./server.ts";

type Page = import("@playwright/test").Page;
type Win = {
  __connect(wsUrl: string, sessionId: string, mode: string, peerId: string): Promise<void>;
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

for (const [i, mode] of (["default", "munged"] as const).entries()) {
  test(`stereo listener: ${mode}`, async ({ page }) => {
    const peerId = `client-browser-${i + 1}`;
    await page.goto("/page.html");
    await page.evaluate(
      ([u, s, m, p]) => (window as unknown as Win).__connect(u, s, m, p),
      [srv.wsUrl, srv.listenerSessionId, mode, peerId] as const,
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
    expect(n.left + n.right).toBeGreaterThan(0.001);
    await page.evaluate(() => (window as unknown as Win).__close());
  });
}
