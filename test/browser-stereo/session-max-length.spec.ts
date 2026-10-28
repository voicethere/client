import { expect, test } from "@playwright/test";

import { startStereoMixServer, type StereoMixServer } from "./server.ts";

type Win = {
  __connect(wsUrl: string, sessionId: string, preferStereoPlayback: boolean | undefined, peerId: string): Promise<void>;
  __sessionErrors: Array<{ code: string; message: string; recoverable?: boolean }>;
  __reconnects: number;
  __connectionState(): string;
};

const REASON = "Demo time is up.";

let srv: StereoMixServer;
test.beforeAll(async () => {
  srv = await startStereoMixServer();
});
test.afterAll(async () => {
  await srv?.close();
});

test("browser client reports terminal SESSION_MAX_LENGTH with the close reason and does not reconnect", async ({
  page,
}) => {
  const peerId = "client-close-browser";
  await page.goto("/page.html");
  await page.evaluate(
    ([u, s, id]) => (window as unknown as Win).__connect(u, s, undefined, id),
    [srv.wsUrl, srv.closeBrowserSessionId, peerId] as const,
  );

  await srv.sendTimeLimitCloseAndTeardown(peerId, srv.closeBrowserSessionId, REASON);

  await expect
    .poll(() => page.evaluate(() => (window as unknown as Win).__sessionErrors.map((e) => e.code)), {
      timeout: 10_000,
    })
    .toEqual(["SESSION_MAX_LENGTH"]);

  // No reconnect within 10 s, and still exactly one terminal error.
  await page.waitForTimeout(10_000);
  const result = await page.evaluate(() => {
    const w = window as unknown as Win;
    return { errors: w.__sessionErrors, reconnects: w.__reconnects, state: w.__connectionState() };
  });
  expect(result.errors).toEqual([{ code: "SESSION_MAX_LENGTH", message: REASON, recoverable: false }]);
  expect(result.reconnects).toBe(0);
  expect(result.state).toBe("closed");
});

test("client Node runtime reports terminal SESSION_MAX_LENGTH with the close reason and does not reconnect", async () => {
  const observer = await srv.connectCloseNodeClient();

  await srv.sendTimeLimitCloseAndTeardown(observer.peerId, observer.sessionId, REASON);

  const deadline = Date.now() + 10_000;
  while (observer.errors.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 10_000));

  expect(observer.errors).toEqual([{ code: "SESSION_MAX_LENGTH", message: REASON, recoverable: false }]);
  expect(observer.reconnects()).toBe(0);
  expect(observer.state()).toBe("closed");
});
