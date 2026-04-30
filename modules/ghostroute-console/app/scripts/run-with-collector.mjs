#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";

const appDir = path.resolve(new URL("..", import.meta.url).pathname);
const dayIntervalSeconds = Math.max(60, Number(process.env.GHOSTROUTE_COLLECT_DAY_INTERVAL_SECONDS || process.env.GHOSTROUTE_COLLECT_INTERVAL_SECONDS || 1800));
const nightIntervalSeconds = Math.max(60, Number(process.env.GHOSTROUTE_COLLECT_NIGHT_INTERVAL_SECONDS || 10800));
const collectTimeoutMs = Math.max(30000, Number(process.env.GHOSTROUTE_COLLECT_TIMEOUT_SECONDS || 180) * 1000);
const liveTimeoutMs = Math.max(10000, Number(process.env.GHOSTROUTE_LIVE_TIMEOUT_SECONDS || 30) * 1000);
const collectorMode = process.env.GHOSTROUTE_COLLECTOR_MODE || "disabled";
const liveMode = process.env.GHOSTROUTE_LIVE_MODE || "disabled";
const liveCollectorMode = process.env.GHOSTROUTE_LIVE_COLLECTOR_MODE || collectorMode;
const liveIntervalSeconds = Math.max(2, Number(process.env.GHOSTROUTE_LIVE_POLL_SECONDS || 15));

let shuttingDown = false;
let collecting = false;
let collectingLive = false;
let timer = null;
let liveTimer = null;

function moscowHour() {
  return Number(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    hour12: false,
  }).format(new Date()));
}

function collectIntervalSeconds() {
  const hour = moscowHour();
  return hour >= 7 && hour <= 23 ? dayIntervalSeconds : nightIntervalSeconds;
}

function spawnScript(script, timeoutMs, onExit) {
  const child = spawn("node", [path.join(appDir, script)], {
    cwd: appDir,
    env: process.env,
    stdio: "inherit",
  });
  const timeout = setTimeout(() => {
    console.log(`[collector] ${script} timed out after ${Math.round(timeoutMs / 1000)}s`);
    child.kill("SIGTERM");
  }, timeoutMs);
  child.on("exit", (code) => {
    clearTimeout(timeout);
    onExit(code);
  });
}

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
    spawnScript("scripts/collect-once.mjs", collectTimeoutMs, (code) => {
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
    spawnScript("scripts/collect-live-once.mjs", liveTimeoutMs, (code) => {
      if (code !== 0) console.log(`[live-collector] ${reason} finished with code ${code}`);
      resolve();
    });
  });
  collectingLive = false;
}

function scheduleCollect() {
  if (shuttingDown || collectorMode === "disabled") return;
  const delay = collectIntervalSeconds();
  timer = setTimeout(async () => {
    await collectOnce("periodic");
    scheduleCollect();
  }, delay * 1000);
  console.log(`[collector] next full collect in ${delay}s`);
}

function scheduleLiveCollect() {
  if (shuttingDown || liveMode === "disabled" || liveCollectorMode === "disabled") return;
  liveTimer = setTimeout(async () => {
    await collectLiveOnce("poll");
    scheduleLiveCollect();
  }, liveIntervalSeconds * 1000);
}

if (collectorMode === "disabled") {
  console.log("[collector] disabled; serving synced factual snapshots only");
} else {
  setTimeout(() => {
    void collectOnce("startup");
  }, 2500);
  scheduleCollect();
}

if (liveMode === "disabled" || liveCollectorMode === "disabled") {
  console.log("[live-collector] disabled; SSE uses stored snapshot/events");
} else {
  setTimeout(() => {
    void collectLiveOnce("startup");
  }, 1500);
  scheduleLiveCollect();
}

function stop(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (timer) clearTimeout(timer);
  if (liveTimer) clearTimeout(liveTimer);
  server.kill(signal);
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => stop(signal));
}

server.on("exit", (code) => {
  if (timer) clearTimeout(timer);
  if (liveTimer) clearTimeout(liveTimer);
  process.exit(code || 0);
});
