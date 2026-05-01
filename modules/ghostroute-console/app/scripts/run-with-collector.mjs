#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";

const appDir = path.resolve(new URL("..", import.meta.url).pathname);
const dayIntervalSeconds = Math.max(60, Number(process.env.GHOSTROUTE_COLLECT_DAY_INTERVAL_SECONDS || process.env.GHOSTROUTE_COLLECT_INTERVAL_SECONDS || 1800));
const nightIntervalSeconds = Math.max(60, Number(process.env.GHOSTROUTE_COLLECT_NIGHT_INTERVAL_SECONDS || 10800));
const collectTimeoutMs = Math.max(30000, Number(process.env.GHOSTROUTE_COLLECT_TIMEOUT_SECONDS || 180) * 1000);
const lightIntervalSeconds = Math.max(60, Number(process.env.GHOSTROUTE_LIGHT_COLLECT_INTERVAL_SECONDS || 300));
const lightTimeoutMs = Math.max(30000, Number(process.env.GHOSTROUTE_LIGHT_COLLECT_TIMEOUT_SECONDS || 45) * 1000);
const liveTimeoutMs = Math.max(10000, Number(process.env.GHOSTROUTE_LIVE_TIMEOUT_SECONDS || 30) * 1000);
const collectorMode = process.env.GHOSTROUTE_COLLECTOR_MODE || "disabled";
const lightCollectorMode = process.env.GHOSTROUTE_LIGHT_COLLECTOR_MODE || collectorMode;
const liveMode = process.env.GHOSTROUTE_LIVE_MODE || "disabled";
const liveCollectorMode = process.env.GHOSTROUTE_LIVE_COLLECTOR_MODE || collectorMode;
const liveIntervalSeconds = Math.max(2, Number(process.env.GHOSTROUTE_LIVE_POLL_SECONDS || 15));

let shuttingDown = false;
let collecting = false;
let collectingLight = false;
let collectingLive = false;
let timer = null;
let lightTimer = null;
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

async function collectLightOnce(reason) {
  if (collectingLight || shuttingDown) return;
  collectingLight = true;
  await new Promise((resolve) => {
    spawnScript("scripts/collect-light-once.mjs", lightTimeoutMs, (code) => {
      if (code !== 0) console.log(`[light-collector] ${reason} finished with code ${code}`);
      resolve();
    });
  });
  collectingLight = false;
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

function scheduleLightCollect() {
  if (shuttingDown || lightCollectorMode === "disabled") return;
  lightTimer = setTimeout(async () => {
    await collectLightOnce("periodic");
    scheduleLightCollect();
  }, lightIntervalSeconds * 1000);
  console.log(`[light-collector] next light collect in ${lightIntervalSeconds}s`);
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

if (lightCollectorMode === "disabled") {
  console.log("[light-collector] disabled; Dashboard uses stored summary/full snapshots");
} else {
  setTimeout(() => {
    void collectLightOnce("startup");
  }, 1800);
  scheduleLightCollect();
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
  if (lightTimer) clearTimeout(lightTimer);
  if (liveTimer) clearTimeout(liveTimer);
  server.kill(signal);
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => stop(signal));
}

server.on("exit", (code) => {
  if (timer) clearTimeout(timer);
  if (lightTimer) clearTimeout(lightTimer);
  if (liveTimer) clearTimeout(liveTimer);
  process.exit(code || 0);
});
