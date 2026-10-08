import {defineConfig, devices} from "@playwright/test";

/**
 * The live demo, tested the way it ships.
 *
 * Runs against the static export Pages publishes — `out/`, built with `PAGES_BASE_PATH=/TrueSend`,
 * which CI does first — served the way GitHub Pages serves it (`e2e/serve.mjs`), with mainnet
 * replaced by a recording of it (`e2e/mainnet.ts`). Nothing here reaches the network.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    baseURL: "http://127.0.0.1:4173/TrueSend/",
    trace: "retain-on-failure",
  },
  projects: [{name: "chromium", use: {...devices["Desktop Chrome"]}}],
  webServer: {
    command: "node e2e/serve.mjs out 4173 /TrueSend",
    url: "http://127.0.0.1:4173/TrueSend/",
    reuseExistingServer: !process.env.CI,
  },
});
