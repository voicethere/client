import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The Chromium harness runs under Playwright (npm run test:browser).
    exclude: [...configDefaults.exclude, "test/browser-stereo/**"],
  },
});
