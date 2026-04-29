#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";

const appDir = path.resolve(new URL("..", import.meta.url).pathname);
const intervalSeconds = Math.max(30, Number(process.env.GHOSTROUTE_COLLECT_INTERVAL_SECONDS || 300));
const collectorMode = process.env.GHOSTROUTE_COLLECTOR_MODE || "disabled";

let shuttingDown = false;
let collecting = false;

const server = spawn("node", ["server.js"], {
  cwd: appDir,
  env: process.env,
  stdio: "inherit",
});

async function collectOnce(reason) {
  if (collecting || shuttingDown) return;
  collecting = true;
  const started = new Date().toISOString();
  console.log(`[collector] ${reason} started at ${started}`);
  await new Promise((resolve) => {
    const child = spawn("node", [path.join(appDir, "scripts/collect-once.mjs")], {
      cwd: appDir,
      env: process.env,
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      console.log(`[collector] ${reason} finished with code ${code}`);
      resolve();
    });
  });
  collecting = false;
}

const timer = setInterval(() => {
  void collectOnce("periodic");
}, intervalSeconds * 1000);

if (collectorMode === "disabled") {
  clearInterval(timer);
  console.log("[collector] disabled; serving synced factual snapshots only");
} else {
  setTimeout(() => {
    void collectOnce("startup");
  }, 2500);
}

function stop(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(timer);
  server.kill(signal);
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => stop(signal));
}

server.on("exit", (code) => {
  clearInterval(timer);
  process.exit(code || 0);
});
