import { defineConfig, devices } from "@playwright/test";
import os from "node:os";
import path from "node:path";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:3001",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "npm run server",
    url: "http://127.0.0.1:3001/health",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: {
      PORT: "3001",
      LOG_DIR: path.join(os.tmpdir(), "tank-arena-playwright-logs"),
    },
  },
});
