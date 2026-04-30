#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";

const appDir = path.resolve(new URL("..", import.meta.url).pathname);
const intervalSeconds = Math.max(30, Number(process.env.GHOSTROUTE_COLLECT_INTERVAL_SECONDS || 300));
const collectorMode = process.env.GHOSTROUTE_COLLECTOR_MODE || "disabled";
const liveMode = process.env.GHOSTROUTE_LIVE_MODE || "disabled";
const liveCollectorMode = process.env.GHOSTROUTE_LIVE_COLLECTOR_MODE || collectorMode;
const liveIntervalSeconds = Math.max(2, Number(process.env.GHOSTROUTE_LIVE_POLL_SECONDS || 2));

let shuttingDown = false;
let collecting = false;
let collectingLive = false;

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

async function collectLiveOnce(reason) {
  if (collectingLive || shuttingDown) return;
  collectingLive = true;
  await new Promise((resolve) => {
    const child = spawn("node", [path.join(appDir, "scripts/collect-live-once.mjs")], {
      cwd: appDir,
      env: process.env,
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      if (code !== 0) console.log(`[live-collector] ${reason} finished with code ${code}`);
      resolve();
    });
  });
  collectingLive = false;
}

const timer = setInterval(() => {
  void collectOnce("periodic");
}, intervalSeconds * 1000);
const liveTimer = setInterval(() => {
  void collectLiveOnce("poll");
}, liveIntervalSeconds * 1000);

if (collectorMode === "disabled") {
  clearInterval(timer);
  console.log("[collector] disabled; serving synced factual snapshots only");
} else {
  setTimeout(() => {
    void collectOnce("startup");
  }, 2500);
}

if (liveMode === "disabled" || liveCollectorMode === "disabled") {
  clearInterval(liveTimer);
  console.log("[live-collector] disabled; SSE uses stored snapshot/events");
} else {
  setTimeout(() => {
    void collectLiveOnce("startup");
  }, 1500);
}

function stop(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(timer);
  clearInterval(liveTimer);
  server.kill(signal);
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => stop(signal));
}

server.on("exit", (code) => {
  clearInterval(timer);
  clearInterval(liveTimer);
  process.exit(code || 0);
});
