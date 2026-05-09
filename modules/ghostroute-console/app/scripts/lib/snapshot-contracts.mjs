import { z } from "zod";

const confidence = z.enum(["exact", "estimated", "dns-interest", "unknown", "mixed"]);

const source = z.object({
  command: z.string().min(1),
}).passthrough();

const common = z.object({
  schema_version: z.union([z.string(), z.number()]),
  generated_at: z.string().min(1),
  source,
  confidence: confidence.optional(),
}).passthrough();

const schemas = {
  traffic: common.extend({
    totals: z.record(z.string(), z.unknown()).optional(),
    devices: z.array(z.unknown()).optional(),
    app_flows: z.array(z.unknown()).optional(),
    destinations: z.array(z.unknown()).optional(),
  }).refine((payload) => payload.totals || payload.devices || payload.app_flows || payload.destinations, {
    message: "traffic snapshot must include totals, devices, app_flows or destinations",
  }),
  traffic_summary: common.extend({
    totals: z.record(z.string(), z.unknown()),
  }),
  health: common.extend({
    checks: z.array(z.unknown()).optional(),
  }),
  leaks: common.extend({
    leaks: z.unknown().optional(),
  }),
  domains: common.extend({
    auto: z.array(z.unknown()).optional(),
    candidates: z.array(z.unknown()).optional(),
  }),
  dns: common.extend({
    queries: z.array(z.unknown()),
  }),
  live: common.extend({
    events: z.array(z.unknown()).optional(),
    route_events: z.array(z.unknown()).optional(),
    cursor: z.record(z.string(), z.unknown()).optional(),
  }),
  deploy_gate: common.extend({
    checks: z.array(z.unknown()).optional(),
    status: z.string().optional(),
  }),
};

function issuePath(issue) {
  return issue.path.length ? issue.path.join(".") : "<root>";
}

export function validateSnapshotPayload(type, payload) {
  const schema = schemas[type];
  if (!schema) {
    throw new Error(`unsupported snapshot type: ${type}`);
  }
  const result = schema.safeParse(payload);
  if (result.success) return result.data;
  const detail = result.error.issues
    .slice(0, 5)
    .map((issue) => `${issuePath(issue)}: ${issue.message}`)
    .join("; ");
  throw new Error(`invalid ${type} snapshot contract: ${detail}`);
}

export function withSnapshotContractDefaults(type, payload, defaults = {}) {
  if (type !== "deploy_gate" || payload?.source) return payload;
  return {
    ...payload,
    source: {
      command: payload?.command || defaults.command || "deploy_gate",
      mode: payload?.mode || defaults.mode || "",
      deploy_gate: Boolean(payload?.deploy_gate),
    },
  };
}

export function snapshotContractVersion(type) {
  return schemas[type] ? 1 : 0;
}
