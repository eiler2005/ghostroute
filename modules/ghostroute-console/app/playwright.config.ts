import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

const standaloneDataDir = process.env.GHOSTROUTE_CONSOLE_DATA_DIR
  ? `GHOSTROUTE_CONSOLE_DATA_DIR=${JSON.stringify(resolve(process.cwd(), process.env.GHOSTROUTE_CONSOLE_DATA_DIR))} `
  : "";
const serverCommand =
  process.env.GHOSTROUTE_CONSOLE_E2E_SERVER_MODE === "start"
    ? `${standaloneDataDir}HOSTNAME=127.0.0.1 PORT=3217 node .next/standalone/server.js`
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
