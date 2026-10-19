import { defineConfig, devices } from "@playwright/test"

// Admin console journeys against a real Saorsa backend (see e2e/server.ts). The journey is stateful by
// design (setup → configure → member usage → review), so it runs serially in one worker.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:18790",
    trace: "retain-on-failure",
    locale: "zh-CN",
    serviceWorkers: "block",
  },
  // Installed Google Chrome by default (no browser download); set PLAYWRIGHT_CHANNEL=chromium after
  // `bunx playwright install chromium` to use Playwright's bundled build instead (e.g. in CI).
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], channel: process.env.PLAYWRIGHT_CHANNEL === "chromium" ? undefined : (process.env.PLAYWRIGHT_CHANNEL ?? "chrome") },
    },
  ],
  webServer: {
    command: "bun e2e/server.ts",
    url: "http://127.0.0.1:18790/healthz",
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
  },
})
