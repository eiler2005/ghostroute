import { defineConfig, devices } from "@playwright/test";

const serverCommand =
  process.env.GHOSTROUTE_CONSOLE_E2E_SERVER_MODE === "start"
    ? "npm run start -- --hostname 127.0.0.1 --port 3217"
    : "npm run dev -- --hostname 127.0.0.1 --port 3217";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:3217",
    trace: "retain-on-failure",
  },
  webServer: {
    command: serverCommand,
    url: "http://127.0.0.1:3217/api/health",
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
});
