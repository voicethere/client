import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The Chromium harness runs under Playwright (npm run test:browser).
    exclude: [...configDefaults.exclude, "test/browser-stereo/**"],
    // Type-level tests (`*.test-d.ts`) run through tsc, not as runtime tests.
    typecheck: {
      enabled: true,
      // tsconfig.test.json also covers examples and the Playwright harness, which do not type-check under it.
      ignoreSourceErrors: true,
      include: ["src/**/*.test-d.ts"],
      tsconfig: "./tsconfig.test.json",
    },
  },
});
