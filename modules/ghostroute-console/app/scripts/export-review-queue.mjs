#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { bucketStartUtc, mskWindowBounds } from "../src/lib/time/window.mjs";

const appDir = path.resolve(import.meta.dirname, "..");
const moduleDir = path.resolve(appDir, "..");
const dataDir = path.resolve(process.env.GHOSTROUTE_CONSOLE_DATA_DIR || path.resolve(moduleDir, "data"));
const dbFile = path.join(dataDir, "ghostroute.db");

function usage() {
  console.error("Usage: npm run export:review-queue -- [--window today|week|month] [--limit 100] [--out <dir>]");
}

function parseArgs(argv) {
  const result = { window: "today", limit: 100, outDir: path.join(dataDir, "review") };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--window") result.window = argv[++i] || result.window;
    else if (arg === "--limit") result.limit = Math.max(1, Number(argv[++i] || result.limit));
    else if (arg === "--out") result.outDir = path.resolve(argv[++i] || result.outDir);
    else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown export-review-queue argument: ${arg}`);
    }
  }
  if (!["today", "week", "month"].includes(result.window)) throw new Error("--window must be today, week, or month");
  return result;
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoMinusHours(iso, hours) {
  return new Date(Date.parse(iso) - hours * 3600000).toISOString();
}

function isoPlusMs(iso, ms) {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function maxIso(...values) {
  return values.filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a))[0] || "";
}

function aggregateSegments(window, now) {
  const bounds = mskWindowBounds(window, now);
  const todayStart = mskWindowBounds("today", now).startUtc;
  const weekStart = mskWindowBounds("week", now).startUtc;
  const freshHours = Math.max(1, Number(process.env.GHOSTROUTE_PREPARED_FINE_HOURS || 2));
  const freshStart = maxIso(todayStart, bucketStartUtc(isoMinusHours(now.toISOString(), freshHours), "hour"));
  const endExclusive = isoPlusMs(bounds.endUtc, 1);
  const segments = [];
  if (window === "month" && Date.parse(bounds.startUtc) < Date.parse(weekStart)) {
    segments.push({ granularity: "week", start: bounds.startUtc, end: weekStart });
  }
  const dailyStart = window === "month" ? maxIso(bounds.startUtc, weekStart) : bounds.startUtc;
  if (window !== "today" && Date.parse(dailyStart) < Date.parse(todayStart)) {
    segments.push({ granularity: "day", start: dailyStart, end: todayStart });
  }
  const hourlyStart = maxIso(bounds.startUtc, todayStart);
  if (Date.parse(hourlyStart) < Date.parse(freshStart)) {
    segments.push({ granularity: "hour", start: hourlyStart, end: freshStart });
  }
  if (Date.parse(freshStart) < Date.parse(endExclusive)) {
    segments.push({ granularity: "5min", start: freshStart, end: endExclusive });
  }
  return segments;
}

function addUnique(list, value, limit = 8) {
  const text = String(value || "").trim();
  if (text && !list.includes(text) && list.length < limit) list.push(text);
}

function reviewReason(row) {
  if (row.traffic_lane === "unknown_review") return "unknown_review_lane";
  if (String(row.category || "").startsWith("unknown.")) return "unknown_category";
  if (row.decision_hint === "ask_user") return "ask_user_hint";
  if (row.enrichment_status === "missing") return "missing_enrichment";
  return "weak_classification";
}

function destinationReviewRows(db, segments, limit) {
  const grouped = new Map();
  let totalBytes = 0;
  let reviewBytes = 0;
  for (const segment of segments) {
    const total = db.prepare(`
      select coalesce(sum(bytes), 0) as bytes
        from client_destination_by_lane
       where bucket_granularity = ?
         and bucket_start_utc >= ?
         and bucket_start_utc < ?
    `).get(segment.granularity, segment.start, segment.end);
    totalBytes += number(total?.bytes);
    const rows = db.prepare(`
      select destination_key, max(destination_label) as destination_label,
             traffic_lane, dns_category, decision_hint,
             max(category) as category,
             max(provider) as provider,
             max(enrichment_status) as enrichment_status,
             sum(bytes) as bytes,
             sum(unknown_bytes) as unknown_bytes,
             sum(flows) as flows,
             count(distinct client_key) as clients,
             max(client_label) as sample_client,
             max(route) as sample_route,
             max(last_seen_utc) as last_seen_utc
        from client_destination_by_lane
       where bucket_granularity = ?
         and bucket_start_utc >= ?
         and bucket_start_utc < ?
         and (
              traffic_lane = 'unknown_review'
              or category like 'unknown.%'
              or decision_hint = 'ask_user'
              or enrichment_status = 'missing'
         )
       group by destination_key, traffic_lane, dns_category, decision_hint
    `).all(segment.granularity, segment.start, segment.end);
    for (const row of rows) {
      reviewBytes += number(row.bytes);
      const key = [row.destination_key, row.traffic_lane, row.dns_category, row.decision_hint].join("|");
      const current = grouped.get(key) || {
        destination_key: row.destination_key,
        destination_label: row.destination_label || row.destination_key,
        traffic_lane: row.traffic_lane,
        dns_category: row.dns_category,
        decision_hint: row.decision_hint,
        category: row.category || "unknown",
        provider: row.provider || "",
        enrichment_status: row.enrichment_status || "missing",
        review_reason: reviewReason(row),
        bytes: 0,
        unknown_bytes: 0,
        flows: 0,
        clients: 0,
        sample_clients: [],
        sample_routes: [],
        last_seen_utc: "",
      };
      current.bytes += number(row.bytes);
      current.unknown_bytes += number(row.unknown_bytes);
      current.flows += number(row.flows);
      current.clients += number(row.clients);
      addUnique(current.sample_clients, row.sample_client);
      addUnique(current.sample_routes, row.sample_route);
      if (String(row.last_seen_utc || "") > String(current.last_seen_utc || "")) current.last_seen_utc = row.last_seen_utc;
      grouped.set(key, current);
    }
  }
  const rows = Array.from(grouped.values()).sort((a, b) => b.bytes - a.bytes).slice(0, limit);
  for (const row of rows) row.percent_total = totalBytes > 0 ? Number(((row.bytes * 100) / totalBytes).toFixed(2)) : 0;
  return { rows, totalBytes, reviewBytes };
}

function routeDefectRows(db, segments, limit) {
  const grouped = new Map();
  let totalBytes = 0;
  let unknownBytes = 0;
  for (const segment of segments) {
    const total = db.prepare(`
      select coalesce(sum(bytes), 0) as bytes, coalesce(sum(unknown_bytes), 0) as unknown_bytes
        from client_route_evidence_defects
       where bucket_granularity = ?
         and bucket_start_utc >= ?
         and bucket_start_utc < ?
    `).get(segment.granularity, segment.start, segment.end);
    totalBytes += number(total?.bytes);
    unknownBytes += number(total?.unknown_bytes);
    const rows = db.prepare(`
      select destination_key, max(destination_label) as destination_label,
             traffic_lane, dns_category, max(category) as category, max(provider) as provider,
             route_evidence, route, intended_route, route_verification, route_status, matched_ipset,
             sum(bytes) as bytes, sum(unknown_bytes) as unknown_bytes, sum(flows) as flows,
             count(distinct client_key) as clients,
             max(client_label) as sample_client,
             max(last_seen_utc) as last_seen_utc
        from client_route_evidence_defects
       where bucket_granularity = ?
         and bucket_start_utc >= ?
         and bucket_start_utc < ?
         and route_evidence != 'proven'
       group by destination_key, traffic_lane, dns_category, route_evidence, route, intended_route, route_verification, route_status, matched_ipset
    `).all(segment.granularity, segment.start, segment.end);
    for (const row of rows) {
      const key = [row.destination_key, row.traffic_lane, row.dns_category, row.route_evidence, row.route, row.intended_route, row.route_verification, row.matched_ipset].join("|");
      const current = grouped.get(key) || {
        destination_key: row.destination_key,
        destination_label: row.destination_label || row.destination_key,
        traffic_lane: row.traffic_lane,
        dns_category: row.dns_category,
        category: row.category || "unknown",
        provider: row.provider || "",
        route_evidence: row.route_evidence,
        route: row.route,
        intended_route: row.intended_route,
        route_verification: row.route_verification,
        route_status: row.route_status,
        matched_ipset: row.matched_ipset,
        bytes: 0,
        unknown_bytes: 0,
        flows: 0,
        clients: 0,
        sample_clients: [],
        last_seen_utc: "",
      };
      current.bytes += number(row.bytes);
      current.unknown_bytes += number(row.unknown_bytes);
      current.flows += number(row.flows);
      current.clients += number(row.clients);
      addUnique(current.sample_clients, row.sample_client);
      if (String(row.last_seen_utc || "") > String(current.last_seen_utc || "")) current.last_seen_utc = row.last_seen_utc;
      grouped.set(key, current);
    }
  }
  const rows = Array.from(grouped.values()).sort((a, b) => b.unknown_bytes - a.unknown_bytes || b.bytes - a.bytes).slice(0, limit);
  return { rows, totalBytes, unknownBytes };
}

function formatMb(bytes) {
  return `${(number(bytes) / 1024 / 1024).toFixed(1)} MB`;
}

function markdown(report) {
  const lines = [
    "# GhostRoute Destination Review Queue",
    "",
    `Generated: ${report.generated_at_utc}`,
    `Window: ${report.window}`,
    "",
    "Use this local-only file to classify destinations into deterministic rules. Do not infer blocking actions from one row; prefer stable provider/domain patterns.",
    "",
    `Content review: ${formatMb(report.summary.content_review_bytes)} / ${formatMb(report.summary.content_total_bytes)} (${report.summary.content_review_percent}%)`,
    `Route evidence unknown: ${formatMb(report.summary.route_unknown_bytes)} / ${formatMb(report.summary.route_total_bytes)} (${report.summary.route_unknown_percent}%)`,
    "",
    "## Unknown Or Weak Content Classification",
    "",
    "| Destination | Current lane | Category | Provider | Traffic | Clients | Reason |",
    "| --- | --- | --- | --- | ---: | ---: | --- |",
  ];
  for (const row of report.destination_review) {
    lines.push(`| ${row.destination_key} | ${row.traffic_lane}/${row.dns_category} | ${row.category} | ${row.provider || ""} | ${formatMb(row.bytes)} | ${row.clients} | ${row.review_reason} |`);
  }
  lines.push("", "## Route Evidence Defects", "", "| Destination | Lane | Evidence | Route -> intended | Unknown traffic | Clients |", "| --- | --- | --- | --- | ---: | ---: |");
  for (const row of report.route_evidence_review) {
    lines.push(`| ${row.destination_key} | ${row.traffic_lane}/${row.dns_category} | ${row.route_evidence} | ${row.route} -> ${row.intended_route} | ${formatMb(row.unknown_bytes)} | ${row.clients} |`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 10000");
  const now = new Date();
  const segments = aggregateSegments(args.window, now);
  const destination = destinationReviewRows(db, segments, args.limit);
  const route = routeDefectRows(db, segments, args.limit);
  const report = {
    schema_version: 1,
    generated_at_utc: now.toISOString(),
    window: args.window,
    segments,
    summary: {
      content_total_bytes: destination.totalBytes,
      content_review_bytes: destination.reviewBytes,
      content_review_percent: destination.totalBytes > 0 ? Number(((destination.reviewBytes * 100) / destination.totalBytes).toFixed(2)) : 0,
      route_total_bytes: route.totalBytes,
      route_unknown_bytes: route.unknownBytes,
      route_unknown_percent: route.totalBytes > 0 ? Number(((route.unknownBytes * 100) / route.totalBytes).toFixed(2)) : 0,
    },
    destination_review: destination.rows,
    route_evidence_review: route.rows,
  };
  fs.mkdirSync(args.outDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const jsonFile = path.join(args.outDir, `traffic-review-${args.window}-${stamp}.json`);
  const mdFile = path.join(args.outDir, `traffic-review-${args.window}-${stamp}.md`);
  const latestJson = path.join(args.outDir, `traffic-review-${args.window}-latest.json`);
  const latestMd = path.join(args.outDir, `traffic-review-${args.window}-latest.md`);
  fs.writeFileSync(jsonFile, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(mdFile, markdown(report));
  fs.copyFileSync(jsonFile, latestJson);
  fs.copyFileSync(mdFile, latestMd);
  db.close();
  console.log(JSON.stringify({
    status: "ok",
    window: args.window,
    destination_review_rows: report.destination_review.length,
    route_evidence_rows: report.route_evidence_review.length,
    content_review_percent: report.summary.content_review_percent,
    route_unknown_percent: report.summary.route_unknown_percent,
    json: jsonFile,
    markdown: mdFile,
  }, null, 2));
} catch (error) {
  console.error(`export-review-queue failed: ${error.message}`);
  process.exit(1);
}
