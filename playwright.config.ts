import { defineConfig, devices } from "@playwright/test";

/*
 * Browser tests: a real Chrome opens Lindero, logs in with the demo accounts
 * from `db:seed` and clicks through it the way a person would. They catch what
 * the backend and frontend unit tests cannot see — a screen that no longer
 * loads, a button that no longer saves.
 *
 *   npm run test:e2e          run them (headless)
 *   npm run test:e2e:ui       watch them run, step by step
 *
 * Playwright starts its own backend (fresh demo database, port 3100) and a
 * server on 5174 with a BUILD of the frontend, sent with the real site's
 * security headers (e2e/serve-built.mjs), so a dev server on 3000/5173 can keep
 * running meanwhile. The build, not Vite's dev server: the policy that matters
 * is the one the people on the real site get.
 */
const apiPort = Number(process.env.E2E_API_PORT ?? 3100);
const webPort = Number(process.env.E2E_WEB_PORT ?? 5174);
const testSitePort = Number(process.env.E2E_TEST_SITE_PORT ?? 5175);

/** Build the frontend into its own folder, then serve it on `port` like nginx does. */
const builtFrontend = (folder: string, port: number) =>
  `npm exec --workspace @lindero/frontend -- vite build --outDir ../e2e/.build/${folder} --emptyOutDir` +
  ` && node e2e/serve-built.mjs e2e/.build/${folder} ${port} ${apiPort}`;

export default defineConfig({
  testDir: "./e2e",
  // The tests share one database, and some change it, so they run one at a time.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${webPort}`,
    locale: "es-HN",
    timezoneId: "America/Tegucigalpa",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    {
      command: "node e2e/start-backend.mjs",
      url: `http://127.0.0.1:${apiPort}/api/health`,
      env: { E2E_API_PORT: String(apiPort), E2E_WEB_PORT: String(webPort), E2E_TEST_SITE_PORT: String(testSitePort) },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: builtFrontend("web", webPort),
      url: `http://localhost:${webPort}`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    // The same frontend as the test site is built: e2e/test-site.spec.ts.
    {
      command: builtFrontend("test-site", testSitePort),
      url: `http://localhost:${testSitePort}`,
      env: {
        VITE_SITE: "test",
        VITE_TEST_BRANCH: "ccr-9a01639b-hz7sp2",
        VITE_TEST_COMMIT: "abc1234",
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
