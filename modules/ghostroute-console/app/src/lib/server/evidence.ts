import type { ConsoleModel } from "./types";

function lower(value: unknown) {
  return String(value || "").toLowerCase();
}

function text(value: unknown, fallback = "unknown") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function number(value: unknown) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function routeFromBytes(row: Record<string, any>) {
  const vps = number(row.via_vps_bytes || row.reality_bytes || row.vps_connections);
  const direct = number(row.direct_bytes || row.wan_bytes || row.direct_connections);
  if (vps > 0 && direct > 0) return "Mixed";
  if (vps > 0) return "VPS";
  if (direct > 0) return "Direct";
  return text(row.route, "Unknown");
}

function suffixMatch(domain: string, candidate: string) {
  const a = lower(domain).replace(/^\*\./, "");
  const b = lower(candidate).replace(/^\*\./, "");
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`) || a.includes(b) || b.includes(a);
}

function clientMatches(row: Record<string, any>, client: string) {
  const haystack = lower([row.client, row.label, row.id, row.ip, row.client_ip, row.device_id, row.raw?.client, row.raw?.ip, row.raw?.client_ip].filter(Boolean).join(" "));
  return client ? haystack.includes(lower(client)) || lower(client).includes(haystack) : false;
}

export function inferAccessChannel(row: Record<string, any>, device?: Record<string, any>) {
  const explicit = text(row.channel || device?.channel, "");
  if (explicit && explicit !== "Unknown") return explicit;
  const raw = lower(JSON.stringify({ row, device }));
  const client = lower(row.client || row.label || device?.label || device?.id || "");
  if (/\b\/\s*c1\b|\bc1_|channel-c|shadowrocket|naive/.test(`${raw} ${client}`)) return "Channel C";
  if (/\b\/\s*b\b|iphone-b|channel-b|xhttp|xray|selected-client/.test(`${raw} ${client}`)) return "Channel B";
  if (raw.includes("channel-c") || raw.includes("shadowrocket") || raw.includes("naive")) return "Channel C";
  if (raw.includes("channel-b") || raw.includes("xhttp") || raw.includes("selected-client") || raw.includes("xray")) return "Channel B";
  if (raw.includes("home_reality") || raw.includes("home-reality") || raw.includes("reality-in")) return "Channel A";
  if (raw.includes("br0") || raw.includes("lan") || raw.includes("wi-fi") || raw.includes("wifi") || raw.includes("192.168.")) return "Home Wi-Fi/LAN";
  if (/^(lan-host|iphone|ipad|macbook|apple tv|unknown device)/.test(client)) return "Home Wi-Fi/LAN";
  return "Unknown";
}

function outboundFor(route: string, row: Record<string, any>) {
  const raw = lower(JSON.stringify(row));
  if (route === "Direct") return "direct-out";
  if (raw.includes("reality-out") || raw.includes("stealth-vps") || route === "VPS") return "reality-out";
  if (raw.includes("direct-out")) return "direct-out";
  if (route === "Mixed") return "mixed-out";
  return "unknown";
}

function visibleIpFor(route: string, row: Record<string, any>) {
  const ip = text(row.egress_ip || row.visible_ip || row.raw?.egress_ip || row.raw?.exit_ip || row.raw?.visible_ip || row.raw?.public_ip || row.exit_ip, "");
  if (ip) return ip;
  return "not observed";
}

function protocolFor(row: Record<string, any>) {
  const protocol = text(row.protocol || row.raw?.protocol || row.raw?.proto, "");
  if (protocol) return protocol;
  if (String(row.destination_port || row.raw?.destination_port || "") === "443") return "TCP / TLS";
  const raw = lower(JSON.stringify(row));
  if (raw.includes("tls") || raw.includes(":443")) return "TCP / TLS";
  if (raw.includes("udp")) return "UDP";
  return "unknown";
}

function ruleFor(route: string, catalogMatch?: Record<string, any>, row?: Record<string, any>) {
  if (catalogMatch) return text(catalogMatch.type || catalogMatch.source || catalogMatch.domain, "catalog match");
  const raw = lower(JSON.stringify(row || {}));
  if (raw.includes("domains-no-vpn")) return "domains-no-vpn";
  if (raw.includes("allowed_direct")) return "ALLOWED_DIRECT_DOMAINS";
  if (route === "Direct") return "no managed match";
  if (route === "VPS") return "STEALTH_DOMAINS";
  return "unknown";
}

function confidenceReason(confidence: string) {
  if (confidence === "exact") return "Основано на явных counters/report evidence.";
  if (confidence === "estimated") return "Выведено из агрегатов или неполных log summaries.";
  if (confidence === "dns-interest") return "Есть DNS-interest, но это не полное доказательство трафика.";
  if (confidence === "mixed") return "Есть несколько источников с разной точностью.";
  return "Источник не дал достаточно доказательств.";
}

function routeRank(route: string) {
  if (route === "VPS" || route === "Direct") return 3;
  if (route === "Mixed") return 2;
  if (route === "dns-interest") return 1;
  return 0;
}

function confidenceRank(confidence: string) {
  if (confidence === "exact") return 4;
  if (confidence === "dns-interest") return 3;
  if (confidence === "mixed") return 2;
  if (confidence === "estimated") return 1;
  return 0;
}

function hasPreciseNetworkEvidence(row: Record<string, any>) {
  return Boolean(row.event_id || row.source_log || row.destination_ip || row.destination_port || row.dns_answer_ip || row.sni || row.outbound || row.matched_rule || row.visible_ip || row.egress_ip);
}

function sourceRank(row: Record<string, any>) {
  if (row._source === "route_decision" && row.source_log === "sing-box.log") return 80;
  if (row._source === "route_decision") return 70;
  if (row._source === "event") return 55;
  if (hasPreciseNetworkEvidence(row)) return 45;
  return 10;
}

function timestampMs(row: Record<string, any>) {
  const ts = text(row.occurred_at || row.event_ts || row.raw?.ts || row.collected_at, "");
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : 0;
}

function evidenceKey(row: Record<string, any>) {
  return [
    text(row.event_id, ""),
    text(row.client || row.client_ip, ""),
    text(row.destination || row.destination_ip || row.dns_qname, ""),
    text(row.destination_port, ""),
    text(row.route, ""),
    text(row.outbound, ""),
    text(row.matched_rule, ""),
  ].join("|");
}

function decisionToFlow(row: Record<string, any>) {
  const evidence = row.evidence || {};
  return {
    ...evidence,
    ...row,
    _source: "route_decision",
    client: text(row.client || row.client_ip || evidence.client || evidence.client_ip, ""),
    client_ip: text(row.client_ip || evidence.client_ip, ""),
    channel: text(row.channel || evidence.channel, "Unknown"),
    destination: text(row.destination || row.destination_ip || evidence.destination || evidence.destination_ip || row.dns_qname, "unknown destination"),
    destination_ip: text(row.destination_ip || evidence.destination_ip, ""),
    destination_port: text(row.destination_port || evidence.destination_port, ""),
    route: text(row.route || evidence.route || evidence.route_decision, "Unknown"),
    outbound: text(row.outbound || evidence.sing_box_outbound, ""),
    matched_rule: text(row.matched_rule || evidence.matched_rule, ""),
    rule_set: text(row.rule_set || evidence.rule_set, ""),
    visible_ip: text(row.visible_ip || evidence.visible_ip || evidence.egress_ip, ""),
    egress_ip: text(row.visible_ip || evidence.visible_ip || evidence.egress_ip, ""),
    egress_asn: text(row.egress_asn || evidence.egress_asn || evidence.asn, ""),
    egress_country: text(row.egress_country || evidence.egress_country || evidence.country, ""),
    dns_qname: text(row.dns_qname || evidence.dns_qname, ""),
    dns_answer_ip: text(row.dns_answer_ip || evidence.dns_answer_ip, ""),
    sni: text(row.sni || evidence.sni, ""),
    protocol: text(evidence.protocol || evidence.proto, ""),
    event_ts: text(row.occurred_at || evidence.ts, ""),
    ts_confidence: "exact",
    bytes: number(evidence.bytes || evidence.total_bytes),
    connections: number(evidence.connections || 1),
    raw: evidence,
  };
}

function eventToFlow(row: Record<string, any>) {
  const evidence = row.evidence || {};
  return {
    ...evidence,
    ...row,
    _source: "event",
    client: text(row.client || row.client_ip || evidence.client || evidence.client_ip, ""),
    client_ip: text(row.client_ip || evidence.client_ip, ""),
    destination: text(row.destination || row.destination_ip || row.dns_qname || evidence.destination || evidence.dns_qname, "unknown destination"),
    event_ts: text(row.occurred_at || evidence.ts, ""),
    raw: evidence,
  };
}

function flowToEvidenceInput(row: Record<string, any>) {
  return { ...row, _source: row._source || "flow" };
}

function buildEvidenceInputs(model: ConsoleModel) {
  const rows = [
    ...model.routeDecisions.map(decisionToFlow),
    ...model.events
      .filter((row) => ["dns.query", "dns.answer", "flow.observed", "route.decision"].includes(text(row.event_type, "")))
      .map(eventToFlow),
    ...model.flows.map(flowToEvidenceInput),
  ];
  const seen = new Set<string>();
  return rows
    .filter((row) => text(row.destination || row.destination_ip || row.dns_qname, "") !== "")
    .sort((a, b) => {
      const scoreA = sourceRank(a) + confidenceRank(text(a.confidence)) * 10 + routeRank(text(a.route || routeFromBytes(a)));
      const scoreB = sourceRank(b) + confidenceRank(text(b.confidence)) * 10 + routeRank(text(b.route || routeFromBytes(b)));
      if (scoreA !== scoreB) return scoreB - scoreA;
      return timestampMs(b) - timestampMs(a);
    })
    .filter((row) => {
      const key = evidenceKey(row);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function egressIdentity(model: ConsoleModel) {
  const identity = model.snapshots.health?.payload?.egress_identity || {};
  return {
    ip: text(identity.ip, ""),
    asn: text(identity.asn, ""),
    country: text(identity.country, ""),
    confidence: text(identity.confidence, "unknown"),
  };
}

function formatEventTime(value: unknown) {
  const source = text(value, "");
  if (!source) return "latest snapshot";
  const parsed = new Date(source);
  if (Number.isNaN(parsed.getTime())) return source;
  return parsed.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function buildRouteEvidence(model: ConsoleModel, index: number) {
  const inputs = buildEvidenceInputs(model);
  const flow = inputs[Math.max(0, Math.min(index, Math.max(inputs.length - 1, 0)))] || null;
  if (!flow) return null;
  const route = text(flow.route || routeFromBytes(flow), "Unknown");
  const rawDestination = text(flow.destination || flow.destination_ip || flow.dns_qname || flow.family || flow.domain || flow.app, "unknown destination");
  const dnsByAnswer = model.dnsQueries.find((row) => lower(row.answer_ip) === lower(rawDestination) || lower(row.raw?.dns_answer_ip) === lower(rawDestination));
  const destination = text(flow.dns_qname || dnsByAnswer?.domain || dnsByAnswer?.qname || rawDestination, "unknown destination");
  const client = text(flow.client || flow.label || dnsByAnswer?.client || flow.channel, "unknown client");
  const device = model.devices.find((row) => clientMatches(row, client));
  const channel = inferAccessChannel(flow, device);
  const dnsMatches = model.dnsQueries.filter((row) => suffixMatch(destination, row.domain || row.qname || row.query)).slice(0, 6);
  const catalogMatches = model.catalog.filter((row) => suffixMatch(destination, row.domain || row.domain_or_cidr || row.value)).slice(0, 6);
  const decision =
    flow._source === "route_decision"
      ? flow
      : model.routeDecisions.find((row) => suffixMatch(destination, row.destination) && (!client || clientMatches(row, client)));
  const outbound = text(decision?.outbound || flow.outbound || flow.raw?.sing_box_outbound || outboundFor(route, flow), "unknown");
  const matchedRule = text(decision?.matched_rule || flow.matched_rule || flow.raw?.matched_rule || ruleFor(route, catalogMatches[0], flow), "unknown");
  const healthEgress = egressIdentity(model);
  const visibleIp = text(
    decision?.visible_ip || flow.visible_ip || flow.egress_ip || flow.raw?.egress_ip || (route === "VPS" ? healthEgress.ip : "") || visibleIpFor(route, flow),
    "not observed"
  );
  const protocol = protocolFor(flow);
  const bytes = number(flow.bytes || flow.total_bytes || flow.via_vps_bytes || flow.direct_bytes);
  const confidence = text(flow.confidence || decision?.confidence, "unknown");
  const dns = dnsMatches[0];
  const catalog = catalogMatches[0];
  const eventRows = model.events
    .filter((row) => suffixMatch(destination, row.destination || row.summary || "") || clientMatches(row, client))
    .slice(0, 8);
  const eventTime = text(flow.event_ts || flow.occurred_at || flow.raw?.ts || flow.collected_at || decision?.occurred_at, "");
  const timeline = [
    { at: formatEventTime(dns?.event_ts || dns?.raw?.ts || dns?.collected_at || eventTime), label: "DNS запрос", detail: `${text(dns?.domain || flow.dns_qname || destination)}${dns?.answer_ip || flow.dns_answer_ip ? ` -> ${dns?.answer_ip || flow.dns_answer_ip}` : ""}` },
    { at: formatEventTime(eventTime), label: "IP/rule evidence", detail: `${matchedRule}${flow.rule_set ? ` / ${flow.rule_set}` : ""}` },
    { at: formatEventTime(decision?.occurred_at || eventTime), label: "Route decision", detail: `${route} / ${outbound}` },
    { at: formatEventTime(flow.raw?.last_seen || flow.raw?.timestamp || eventTime), label: "Traffic observed", detail: `${bytes} bytes` },
    ...eventRows.slice(0, 4).map((row) => ({ at: text(row.occurred_at), label: text(row.event_type), detail: text(row.summary || row.destination) })),
  ];

  const direct = route === "Direct";
  const mixed = route === "Mixed";
  const steps = [
    { label: "Client", detail: "Запрос от устройства" },
    { label: "Router", detail: channel === "Home Wi-Fi/LAN" ? "Пакеты вошли из домашней сети" : `Вход через ${channel}` },
    { label: "dnsmasq + ipset", detail: dns ? `${dns.domain || destination} -> ${dns.qtype || "A"}` : "DNS evidence не найден" },
    { label: "sing-box", detail: `Правило: ${matchedRule}` },
    { label: direct ? "Direct" : mixed ? "mixed-out" : "reality-out", detail: direct ? "Локальный/home WAN выход" : mixed ? "Смешанный выход" : "Reality/VPS outbound" },
    ...(direct ? [] : [{ label: "VPS", detail: `Видимый IP: ${visibleIp}` }]),
    { label: "Internet", detail: "Доставка до сайта" },
  ];

  return {
    id: String(index),
    flow,
    eventTime,
    eventTimeLabel: formatEventTime(eventTime),
    sourceKind: text(flow._source, "flow"),
    client,
    clientIp: text(flow.client_ip || decision?.client_ip || device?.ip || flow.ip || flow.raw?.client_ip || flow.raw?.ip, "not observed"),
    channel,
    destination,
    destinationIp: text(flow.destination_ip || decision?.destination_ip || flow.raw?.destination_ip, "not observed"),
    destinationPort: text(flow.destination_port || decision?.destination_port || flow.raw?.destination_port, "not observed"),
    route,
    outbound,
    matchedRule,
    visibleIp,
    protocol,
    sni: text(flow.sni || decision?.sni || flow.raw?.sni || (destination.includes(".") ? destination : ""), "not observed"),
    bytes,
    connections: number(flow.connections || flow.total_connections),
    confidence,
    confidenceReason: confidenceReason(confidence),
    dnsMatches,
    catalogMatches,
    decision,
    steps,
    timeline,
    siteView: {
      destination,
      visitorIp: visibleIp,
      countryAs: text(
        [
          flow.egress_country || decision?.egress_country || (visibleIp === healthEgress.ip ? healthEgress.country : ""),
          flow.egress_asn || decision?.egress_asn || flow.raw?.asn || (visibleIp === healthEgress.ip ? healthEgress.asn : ""),
        ].filter(Boolean).join(" / "),
        "not observed"
      ),
      protocol,
      sni: text(flow.sni || decision?.sni || flow.raw?.sni || destination, "not observed"),
    },
    operatorView: {
      input: `${channel} / ${client}`,
      clientIp: text(flow.client_ip || decision?.client_ip || device?.ip || flow.raw?.client_ip || flow.raw?.ip, "not observed"),
      output: outbound,
      route: route === "VPS" ? "Через VPS" : route === "Direct" ? "Direct/Home WAN" : route,
      rule: matchedRule,
      decision: route === "VPS" ? "Route via reality-out" : route === "Direct" ? "Direct allowed" : "Derived from counters",
      confidence,
    },
    ipLogic:
      route === "VPS"
        ? "Внешние сайты видят VPS egress IP, потому что route decision выбрал reality-out. Домашний/мобильный оператор видит вход к домашнему маршруту или VPS tunnel, но не финальный managed destination."
        : route === "Direct"
          ? "Сайт видит home/direct IP, потому что destination не попал в managed rule-set или был явно разрешён как direct."
          : "Route decision смешанный или неполный: Console показывает только уровень уверенности, который подтверждён source evidence.",
    rawRefs: {
      flow,
      dns: dnsMatches,
      catalog: catalogMatches,
      decision,
      events: eventRows,
    },
  };
}

export function buildRouteEvidences(model: ConsoleModel) {
  return buildEvidenceInputs(model).map((_, index) => buildRouteEvidence(model, index)).filter(Boolean) as NonNullable<ReturnType<typeof buildRouteEvidence>>[];
}
