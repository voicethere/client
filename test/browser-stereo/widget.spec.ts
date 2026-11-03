import { expect, test } from "@playwright/test";

import { startStereoMixServer, type StereoMixServer } from "./server.ts";

let srv: StereoMixServer;
test.beforeAll(async () => {
  srv = await startStereoMixServer();
});
test.afterAll(async () => {
  await srv?.close();
});

test("inline widget fills its mount and draws link, filler and reply bubbles with times in a real browser", async ({
  page,
}) => {
  await page.goto("/widget.html");
  await page.evaluate(
    ([u, s]) =>
      (
        window as unknown as { __mountWidget(u: string, s: string): void }
      ).__mountWidget(u, s),
    [srv.wsUrl, srv.closeBrowserSessionId] as const,
  );

  const root = page.locator(".vt-widget");
  await expect(root).toHaveAttribute("data-voicethere-display", "inline");
  await expect(page.locator(".vt-widget-launcher")).toHaveCount(0);
  const host = await page.locator("#host").boundingBox();
  const panel = await page.locator(".vt-widget-panel").boundingBox();
  expect(Math.abs(panel!.width - host!.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(panel!.height - host!.height)).toBeLessThanOrEqual(1);

  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.locator(".vt-widget-status")).toContainText("Connected", {
    timeout: 30_000,
  });
  await srv.sendToAllClients({
    type: "assistant_content",
    turnId: "t1",
    spoken: false,
    content: {
      kind: "link",
      url: "https://example.com/pricing",
      label: "Pricing",
    },
  });
  await srv.sendToAllClients({
    type: "assistant_filler",
    turnId: "t1",
    text: "One moment",
  });
  await srv.sendToAllClients({
    type: "chat_reply",
    turnId: "t1",
    text: "Here is the pricing page",
  });

  // The harness host also streams mock speech events; the turn id picks out this test's messages.
  const bubbles = page.locator('.vt-widget-msg[data-voicethere-turn="t1"]');
  await expect(bubbles).toHaveCount(3, { timeout: 20_000 });
  await expect(bubbles.nth(0)).toHaveAttribute("data-voicethere-kind", "link");
  await expect(bubbles.nth(1)).toHaveAttribute(
    "data-voicethere-kind",
    "filler",
  );
  await expect(bubbles.nth(2)).toHaveAttribute("data-voicethere-kind", "reply");
  await expect(bubbles.nth(0).locator("a")).toHaveAttribute(
    "href",
    "https://example.com/pricing",
  );

  const times = bubbles.locator("time");
  await expect(times).toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    const t = times.nth(i);
    await expect(t).toBeVisible();
    expect(await t.innerText()).toMatch(/\d/);
    expect(Number.isNaN(Date.parse((await t.getAttribute("datetime"))!))).toBe(
      false,
    );
  }
  // The link bubble did not move when the reply arrived.
  await expect(bubbles.nth(0)).toHaveAttribute("data-voicethere-kind", "link");

  await page.evaluate(() =>
    (
      window as unknown as { __widget: { updateConfig(p: unknown): void } }
    ).__widget.updateConfig({
      theme: { chat: { timestamps: { show: false } } },
    }),
  );
  await expect(times.first()).toBeHidden();
  // Leave the room so the next test can join it.
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.locator(".vt-widget-status")).toContainText("Disconnected");
});

test("Mute disables the outbound mic track in a real browser", async ({
  page,
}) => {
  await page.goto("/widget.html");
  await page.evaluate(
    ([u, s]) =>
      (
        window as unknown as { __mountWidget(u: string, s: string): void }
      ).__mountWidget(u, s),
    [srv.wsUrl, srv.closeBrowserSessionId] as const,
  );
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.locator(".vt-widget-status")).toContainText("Connected", {
    timeout: 30_000,
  });
  const micEnabled = () =>
    page.evaluate(() => {
      const stream = (
        window as unknown as {
          __session: { getMicStream(): MediaStream | null };
        }
      ).__session.getMicStream();
      return stream!.getAudioTracks().map((t) => t.enabled);
    });
  expect(await micEnabled()).toEqual([true]);
  await page.getByRole("button", { name: "Mute" }).click();
  expect(await micEnabled()).toEqual([false]);
  await expect(page.getByRole("button", { name: "Unmute" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "Unmute" }).click();
  expect(await micEnabled()).toEqual([true]);
  // Leave the room so the next test can join it.
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.locator(".vt-widget-status")).toContainText("Disconnected");
});
