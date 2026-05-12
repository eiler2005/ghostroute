#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";
import Database from "better-sqlite3";
import { ensureConsoleSchema } from "./lib/normalize.mjs";

const appDir = path.resolve(import.meta.dirname, "..");
const moduleDir = path.resolve(appDir, "..");
const dataDir = path.resolve(process.env.GHOSTROUTE_CONSOLE_DATA_DIR || path.resolve(moduleDir, "data"));
const dbFile = path.join(dataDir, "ghostroute.db");

function usage() {
  console.error("Usage: npm run import:iptoasn -- --file <ip2asn-v4-u32.tsv.gz|tsv> [--refresh-cache]");
}

function parseArgs(argv) {
  const result = { file: "", refreshCache: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--file") result.file = argv[++i] || "";
    else if (arg === "--refresh-cache") result.refreshCache = true;
    else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown import-iptoasn argument: ${arg}`);
    }
  }
  if (!result.file) throw new Error("--file is required");
  return result;
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function ipv4ToU32(value) {
  const parts = String(value || "").trim().split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    result = result * 256 + octet;
  }
  return result >>> 0;
}

function rangeValueToU32(value) {
  const text = String(value || "").trim();
  if (/^\d+$/.test(text)) return number(text);
  return ipv4ToU32(text);
}

function isIpv4Literal(value) {
  return ipv4ToU32(value) !== null;
}

function inputStream(file) {
  const stream = fs.createReadStream(file);
  return file.endsWith(".gz") ? stream.pipe(zlib.createGunzip()) : stream;
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function providerHints(row) {
  const provider = String(row?.provider || row?.asn_org || "").trim();
  if (!provider) {
    return {
      categoryHint: "unknown.ip_provider",
      trafficLaneHint: "unknown_review",
      dnsCategoryHint: "unknown_ip_only",
      decisionHint: "ask_user",
    };
  }
  const normalized = provider.toLowerCase();
  let family = "network_provider";
  let trafficLaneHint = "shared_infra";
  if (/telegram/.test(normalized)) {
    family = "messaging_platform";
    trafficLaneHint = "client_observed";
  } else if (/facebook|meta|instagram/.test(normalized)) {
    family = "social_platform";
    trafficLaneHint = "client_observed";
  } else if (/zoom/.test(normalized)) {
    family = "meeting_platform";
    trafficLaneHint = "client_observed";
  } else if (/tradingview/.test(normalized)) {
    family = "finance_platform";
    trafficLaneHint = "client_observed";
  } else if (/googlevideo|youtube/.test(normalized)) {
    family = "video_platform";
    trafficLaneHint = "client_observed";
  } else if (/cloudflare|fastly|akamai|gcore|leaseweb|hetzner|amazon|aws|google-cloud|microsoft|github/.test(normalized)) {
    family = "cdn_cloud_hosting";
  } else if (/google/.test(normalized)) {
    family = "google_infra";
  } else if (/apple/.test(normalized)) {
    family = "apple_infra";
  } else if (/teletech|tepucom|master-as|solarspace|vodafone|rim2000/.test(normalized)) {
    family = "network_provider";
  }
  return {
    categoryHint: `ip_asn.${family}.${slug(provider) || "provider"}`,
    trafficLaneHint,
    dnsCategoryHint: family,
    decisionHint: "monitor",
  };
}

async function importIpToAsn(db, file) {
  const now = new Date().toISOString();
  const insert = db.prepare(`
    insert into ip_prefix_catalog(prefix_cidr, range_start, range_end, range_start_u32, range_end_u32,
      asn, asn_org, provider, country, registry, source, updated_at_utc)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'iptoasn', ?)
    on conflict(prefix_cidr) do update set
      range_start = excluded.range_start,
      range_end = excluded.range_end,
      range_start_u32 = excluded.range_start_u32,
      range_end_u32 = excluded.range_end_u32,
      asn = excluded.asn,
      asn_org = excluded.asn_org,
      provider = excluded.provider,
      country = excluded.country,
      source = excluded.source,
      updated_at_utc = excluded.updated_at_utc
  `);
  const batch = db.transaction((rows) => {
    for (const row of rows) insert.run(...row);
  });
  const rl = readline.createInterface({ input: inputStream(file), crlfDelay: Infinity });
  let rows = [];
  let imported = 0;
  let skipped = 0;
  for await (const line of rl) {
    const trimmed = String(line || "").trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [rangeStart, rangeEnd, asNumber, countryCode, ...descriptionParts] = trimmed.split(/\t/);
    const startU32 = rangeValueToU32(rangeStart);
    const endU32 = rangeValueToU32(rangeEnd);
    if (!Number.isFinite(startU32) || !Number.isFinite(endU32) || endU32 < startU32) {
      skipped += 1;
      continue;
    }
    const asn = asNumber ? `AS${String(asNumber).replace(/^AS/i, "")}` : "";
    const description = descriptionParts.join(" ").trim();
    const key = `${rangeStart}-${rangeEnd}`;
    rows.push([key, rangeStart, rangeEnd, startU32, endU32, asn, description, description, countryCode || "", now]);
    if (rows.length >= 5000) {
      batch(rows);
      imported += rows.length;
      rows = [];
    }
  }
  if (rows.length) {
    batch(rows);
    imported += rows.length;
  }
  return { imported, skipped };
}

function refreshObservedIpCache(db) {
  const now = new Date().toISOString();
  const lookup = db.prepare(`
    select prefix_cidr, asn, asn_org, provider, country, registry, source
      from ip_prefix_catalog
     where range_start_u32 <= ?
       and range_end_u32 >= ?
     order by (range_end_u32 - range_start_u32) asc
     limit 1
  `);
  const upsert = db.prepare(`
    insert into ip_enrichment_cache(ip, prefix_cidr, asn, asn_org, provider, country, registry,
      category_hint, traffic_lane_hint, dns_category_hint, decision_hint, source, confidence, lookup_status,
      raw_json, first_seen_utc, last_seen_utc, updated_at_utc, expires_at_utc)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'estimated', ?, ?, ?, ?, ?, '')
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
  const destinations = new Set();
  for (const table of ["client_destination_by_lane", "client_destination_traffic_5min", "client_destination_traffic_hourly", "client_destination_traffic_daily", "client_destination_traffic_weekly", "client_destination_traffic_monthly"]) {
    const exists = db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(table);
    if (!exists) continue;
    for (const row of db.prepare(`select distinct lower(destination_key) as destination_key from ${table} where coalesce(destination_key, '') != ''`).all()) {
      if (isIpv4Literal(row.destination_key)) destinations.add(row.destination_key);
    }
  }
  let matched = 0;
  let missed = 0;
  const write = db.transaction((items) => {
    for (const ip of items) {
      const u32 = ipv4ToU32(ip);
      const row = lookup.get(u32, u32);
      if (row) {
        const hints = providerHints(row);
        matched += 1;
        upsert.run(ip, row.prefix_cidr, row.asn, row.asn_org, row.provider, row.country, row.registry,
          hints.categoryHint, hints.trafficLaneHint, hints.dnsCategoryHint, hints.decisionHint,
          row.source || "iptoasn", "hit", JSON.stringify({ ...row, hints }), now, now, now);
      } else {
        missed += 1;
        upsert.run(ip, "", "", "", "", "", "", "unknown.ip_provider", "unknown_review", "unknown_ip_only", "ask_user", "iptoasn", "miss", "{}", now, now, now);
      }
    }
  });
  write(Array.from(destinations));
  return { observedIps: destinations.size, matched, missed };
}

try {
  const args = parseArgs(process.argv.slice(2));
  const file = path.resolve(args.file);
  if (!fs.existsSync(file)) throw new Error(`file does not exist: ${file}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(dbFile);
  db.pragma("busy_timeout = 10000");
  ensureConsoleSchema(db);
  const imported = await importIpToAsn(db, file);
  const cache = args.refreshCache ? refreshObservedIpCache(db) : { observedIps: 0, matched: 0, missed: 0 };
  db.close();
  console.log(JSON.stringify({ status: "ok", file, data_dir: dataDir, ...imported, cache }, null, 2));
} catch (error) {
  usage();
  console.error(`import-iptoasn failed: ${error.message}`);
  process.exitCode = 1;
}
