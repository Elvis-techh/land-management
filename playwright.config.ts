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
 * Playwright starts its own backend (fresh demo database, port 3100) and Vite
 * (port 5174), so a dev server on 3000/5173 can keep running meanwhile.
 */
const apiPort = Number(process.env.E2E_API_PORT ?? 3100);
const webPort = Number(process.env.E2E_WEB_PORT ?? 5174);
const testSitePort = Number(process.env.E2E_TEST_SITE_PORT ?? 5175);

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
      command: `npm run dev --workspace @lindero/frontend -- --port ${webPort}`,
      url: `http://localhost:${webPort}`,
      env: { LINDERO_API_URL: `http://127.0.0.1:${apiPort}` },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    // The same frontend as the test site is built: e2e/test-site.spec.ts.
    {
      command: `npm run dev --workspace @lindero/frontend -- --port ${testSitePort}`,
      url: `http://localhost:${testSitePort}`,
      env: { LINDERO_API_URL: `http://127.0.0.1:${apiPort}`, VITE_SITE: "test" },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
