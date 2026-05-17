#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ensureConsoleSchema } from "./lib/normalize.mjs";

const appDir = path.resolve(import.meta.dirname, "..");
const moduleDir = path.resolve(appDir, "..");
const dataDir = path.resolve(process.env.GHOSTROUTE_CONSOLE_DATA_DIR || path.resolve(moduleDir, "data"));
const dbFile = path.join(dataDir, "ghostroute.db");

function usage() {
  console.error("Usage: npm run import:rdap-review -- --file <rdap-enrichment.json> [--dry-run]");
}

function parseArgs(argv) {
  const result = { file: "", dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--file") result.file = path.resolve(argv[++i] || "");
    else if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown import-rdap-review argument: ${arg}`);
    }
  }
  if (!result.file) throw new Error("--file is required");
  return result;
}

function text(value, fallback = "") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function slug(value) {
  return text(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function providerName(row) {
  const names = Array.isArray(row.entity_names) ? row.entity_names : [];
  return text(names[0] || row.name || row.handle || row.classification?.family || "RDAP provider");
}

function familyHints(row) {
  const family = text(row.classification?.family || "unknown_provider");
  const provider = providerName(row);
  const providerSlug = slug(provider) || family;
  const shared = (category, dnsCategory = "cdn_cloud_hosting") => ({
    provider,
    categoryHint: `ip_rdap.${category}.${providerSlug}`,
    trafficLaneHint: "shared_infra",
    dnsCategoryHint: dnsCategory,
    decisionHint: "monitor",
  });

  if (["cloudflare", "aws_cloudfront", "akamai", "fastly", "microsoft_azure", "hosting_provider"].includes(family)) {
    return shared("cdn_cloud_hosting");
  }
  if (family === "google_infra") return shared("google_infra", "google_infra");
  if (family === "apple") return shared("apple_infra", "apple_infra");
  if (family === "meta") {
    return {
      provider,
      categoryHint: `ip_rdap.social_platform.${providerSlug}`,
      trafficLaneHint: "client_observed",
      dnsCategoryHint: "social_platform",
      decisionHint: "monitor",
    };
  }
  if (family === "telegram") {
    return {
      provider,
      categoryHint: `ip_rdap.messaging_platform.${providerSlug}`,
      trafficLaneHint: "client_observed",
      dnsCategoryHint: "messaging_platform",
      decisionHint: "monitor",
    };
  }
  if (family === "ru_or_local_provider") {
    return {
      provider,
      categoryHint: `ip_rdap.network_provider.${providerSlug}`,
      trafficLaneHint: "unknown_review",
      dnsCategoryHint: "unknown_ip_only",
      decisionHint: "ask_user",
    };
  }
  return {
    provider,
    categoryHint: "unknown.ip_provider",
    trafficLaneHint: "unknown_review",
    dnsCategoryHint: "unknown_ip_only",
    decisionHint: "ask_user",
  };
}

function normalizeRows(payload) {
  const rows = Array.isArray(payload?.results) ? payload.results : [];
  return rows
    .filter((row) => /^(\d{1,3}\.){3}\d{1,3}$/.test(text(row.ip)))
    .map((row) => {
      const hints = familyHints(row);
      const now = text(payload.generated_at_utc || new Date().toISOString());
      const raw = {
        source: payload.source || "rdap_review",
        review_generated_at_utc: payload.review_generated_at_utc || "",
        classification: row.classification || {},
        start_address: row.start_address || "",
        end_address: row.end_address || "",
        cidr0: row.cidr0 || [],
        name: row.name || "",
        handle: row.handle || "",
        country: row.country || "",
        entity_names: row.entity_names || [],
      };
      return {
        ip: text(row.ip),
        prefixCidr: Array.isArray(row.cidr0) && row.cidr0.length === 1
          ? `${row.cidr0[0].v4prefix}/${row.cidr0[0].length}`
          : "",
        asn: "",
        asnOrg: hints.provider,
        provider: hints.provider,
        country: text(row.country),
        registry: text(row.rdap_port43 || ""),
        categoryHint: hints.categoryHint,
        trafficLaneHint: hints.trafficLaneHint,
        dnsCategoryHint: hints.dnsCategoryHint,
        decisionHint: hints.decisionHint,
        source: "rdap_review",
        confidence: "estimated",
        lookupStatus: "hit",
        rawJson: JSON.stringify(raw),
        firstSeenUtc: now,
        lastSeenUtc: now,
        updatedAtUtc: now,
      };
    });
}

function importRows(db, rows) {
  const upsert = db.prepare(`
    insert into ip_enrichment_cache(ip, prefix_cidr, asn, asn_org, provider, country, registry,
      category_hint, traffic_lane_hint, dns_category_hint, decision_hint, source, confidence, lookup_status,
      raw_json, first_seen_utc, last_seen_utc, updated_at_utc, expires_at_utc)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')
    on conflict(ip) do update set
      prefix_cidr = excluded.prefix_cidr,
      asn = excluded.asn,
      asn_org = excluded.asn_org,
      provider = excluded.provider,
      country = excluded.country,
      registry = excluded.registry,
      category_hint = excluded.category_hint,
      traffic_lane_hint = excluded.traffic_lane_hint,
      dns_category_hint = excluded.dns_category_hint,
      decision_hint = excluded.decision_hint,
      source = excluded.source,
      confidence = excluded.confidence,
      lookup_status = excluded.lookup_status,
      raw_json = excluded.raw_json,
      last_seen_utc = excluded.last_seen_utc,
      updated_at_utc = excluded.updated_at_utc
  `);
  const write = db.transaction((items) => {
    for (const row of items) {
      upsert.run(row.ip, row.prefixCidr, row.asn, row.asnOrg, row.provider, row.country, row.registry,
        row.categoryHint, row.trafficLaneHint, row.dnsCategoryHint, row.decisionHint, row.source,
        row.confidence, row.lookupStatus, row.rawJson, row.firstSeenUtc, row.lastSeenUtc, row.updatedAtUtc);
    }
  });
  write(rows);
}

function summarize(rows) {
  return rows.reduce((acc, row) => {
    const categoryKey = row.categoryHint.split(".").slice(0, 2).join(".");
    acc.total += 1;
    acc.by_lane[row.trafficLaneHint] = (acc.by_lane[row.trafficLaneHint] || 0) + 1;
    acc.by_category[categoryKey] = (acc.by_category[categoryKey] || 0) + 1;
    acc.by_decision[row.decisionHint] = (acc.by_decision[row.decisionHint] || 0) + 1;
    return acc;
  }, { total: 0, by_lane: {}, by_category: {}, by_decision: {} });
}

const args = parseArgs(process.argv.slice(2));
const payload = JSON.parse(fs.readFileSync(args.file, "utf8"));
const rows = normalizeRows(payload);
const summary = summarize(rows);

if (!args.dryRun) {
  const db = new Database(dbFile);
  ensureConsoleSchema(db);
  importRows(db, rows);
  db.close();
}

console.log(JSON.stringify({ status: "ok", dry_run: args.dryRun, file: args.file, ...summary }, null, 2));
