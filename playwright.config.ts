import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/browser-stereo",
  testMatch: /.*\.spec\.ts/,
  timeout: 120_000,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5299",
    headless: true,
    browserName: "chromium",
    launchOptions: {
      args: ["--autoplay-policy=no-user-gesture-required", "--disable-features=WebRtcHideLocalIpsWithMdns"],
    },
  },
  webServer: {
    command: "npx vite --config test/browser-stereo/vite.config.ts",
    url: "http://127.0.0.1:5299/page.html",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
