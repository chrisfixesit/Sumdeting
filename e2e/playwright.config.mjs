import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.mjs$/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:8099",
    trace: "retain-on-failure",
    ...devices["Pixel 7"],
  },
  webServer: {
    command: "ACCOUNT_DEV=1 SIGNIN_IP_LIMIT=1000 PORT=8099 node ../server.mjs",
    cwd: ".",
    url: "http://localhost:8099/healthz",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
