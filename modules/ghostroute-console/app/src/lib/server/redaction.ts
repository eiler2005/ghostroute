import crypto from "node:crypto";

function token(prefix: string, value: string) {
  const digest = crypto.createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `${prefix}-${digest}`;
}

export function redactValue(value: string) {
  return value
    .replace(/\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi, (match) => token("mac", match))
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, (match) => token("uuid", match))
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (match) => token("ip", match))
    .replace(/\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\b/gi, (match) => token("ipv6", match))
    .replace(/\b[a-z0-9.-]+\.[a-z]{2,}\b/gi, (match) => token("domain", match))
    .replace(/(vless:\/\/|vmess:\/\/|trojan:\/\/|ss:\/\/|wg:\/\/|https?:\/\/)[^\s)"']+/gi, "<redacted-uri>")
    .replace(/(password|passwd|secret|token|key|uuid)=([^,\s}]+)/gi, "$1=<redacted>")
    .replace(/iPhone\s+[\w-]+|MacBook\s+[\w-]+|Apple TV|Work iPad|lan-host-\d+/gi, (match) => token("device", match));
}

export function redactJson(input: unknown) {
  return JSON.parse(redactValue(JSON.stringify(input, null, 2)));
}

export function redactedMarkdown(title: string, input: unknown) {
  return `# ${title}\n\n\`\`\`json\n${JSON.stringify(redactJson(input), null, 2)}\n\`\`\`\n`;
}

export function llmSafePayload(model: any) {
  const withoutRaw = (rows: Array<Record<string, any>>, limit: number) =>
    rows.slice(0, limit).map(({ raw, raw_json, evidence_json, ...row }) => row);
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    summary: {
      freshness_minutes: model.freshnessMinutes,
      freshness_status: model.freshnessStatus,
      totals: model.totals,
      snapshot_count: Object.values(model.snapshots || {}).filter(Boolean).length,
    },
    health: {
      status_cards: model.statusCards,
      collector_errors: withoutRaw(model.collectorErrors || [], 10),
    },
    flows: withoutRaw(model.flows || [], 40),
    clients: withoutRaw(model.devices || [], 30),
    catalog: withoutRaw(model.catalog || [], 80),
    alerts: withoutRaw(model.alerts || [], 30),
    freshness: {
      latest_snapshots: Object.fromEntries(
        Object.entries(model.snapshots || {}).map(([key, value]: [string, any]) => [
          key,
          value ? { collected_at: value.collectedAt, source: value.source } : null,
        ])
      ),
    },
  };
}
