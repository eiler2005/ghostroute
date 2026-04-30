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
  const haystack = lower([row.client, row.label, row.id, row.ip, row.device_id, row.raw?.client, row.raw?.ip].filter(Boolean).join(" "));
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
  const ip = text(row.raw?.egress_ip || row.raw?.exit_ip || row.raw?.visible_ip || row.raw?.public_ip || row.egress_ip || row.exit_ip || row.visible_ip, "");
  if (ip) return ip;
  if (route === "VPS") return "VPS egress IP";
  if (route === "Direct") return "Home WAN IP";
  return "unknown";
}

function protocolFor(row: Record<string, any>) {
  const protocol = text(row.protocol || row.raw?.protocol || row.raw?.proto, "");
  if (protocol) return protocol;
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

export function buildRouteEvidence(model: ConsoleModel, index: number) {
  const flow = model.flows[Math.max(0, Math.min(index, Math.max(model.flows.length - 1, 0)))] || null;
  if (!flow) return null;
  const route = text(flow.route || routeFromBytes(flow), "Unknown");
  const destination = text(flow.destination || flow.family || flow.domain || flow.app, "unknown destination");
  const client = text(flow.client || flow.label || flow.channel, "unknown client");
  const device = model.devices.find((row) => clientMatches(row, client));
  const channel = inferAccessChannel(flow, device);
  const dnsMatches = model.dnsQueries.filter((row) => suffixMatch(destination, row.domain || row.qname || row.query)).slice(0, 6);
  const catalogMatches = model.catalog.filter((row) => suffixMatch(destination, row.domain || row.domain_or_cidr || row.value)).slice(0, 6);
  const decision = model.routeDecisions.find((row) => suffixMatch(destination, row.destination) && (!client || clientMatches(row, client)));
  const outbound = text(decision?.outbound || outboundFor(route, flow), "unknown");
  const matchedRule = text(decision?.matched_rule || ruleFor(route, catalogMatches[0], flow), "unknown");
  const visibleIp = text(decision?.visible_ip || visibleIpFor(route, flow), "unknown");
  const protocol = protocolFor(flow);
  const bytes = number(flow.bytes || flow.total_bytes || flow.via_vps_bytes || flow.direct_bytes);
  const confidence = text(flow.confidence || decision?.confidence, "unknown");
  const dns = dnsMatches[0];
  const catalog = catalogMatches[0];
  const eventRows = model.events
    .filter((row) => suffixMatch(destination, row.destination || row.summary || "") || clientMatches(row, client))
    .slice(0, 8);
  const timeline = [
    { at: text(dns?.raw?.ts || dns?.collected_at || flow.raw?.ts || flow.collected_at, "latest snapshot"), label: "DNS запрос", detail: text(dns?.domain || destination) },
    { at: text(flow.raw?.ts || flow.collected_at, "latest snapshot"), label: "IP/rule evidence", detail: matchedRule },
    { at: text(decision?.occurred_at || flow.raw?.ts || flow.collected_at, "latest snapshot"), label: "Route decision", detail: `${route} / ${outbound}` },
    { at: text(flow.raw?.last_seen || flow.raw?.timestamp || flow.collected_at, "latest snapshot"), label: "Traffic observed", detail: `${bytes} bytes` },
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
    client,
    clientIp: text(device?.ip || flow.ip || flow.raw?.client_ip || flow.raw?.ip, "unknown"),
    channel,
    destination,
    route,
    outbound,
    matchedRule,
    visibleIp,
    protocol,
    sni: text(flow.raw?.sni || (destination.includes(".") ? destination : ""), "unknown"),
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
      countryAs: text(flow.raw?.country_as || flow.raw?.asn || (route === "VPS" ? "VPS ASN" : route === "Direct" ? "Home ISP ASN" : "unknown")),
      protocol,
      sni: text(flow.raw?.sni || destination, "unknown"),
    },
    operatorView: {
      input: `${channel} / ${client}`,
      clientIp: text(device?.ip || flow.raw?.client_ip || flow.raw?.ip, "unknown"),
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
  return model.flows.map((_, index) => buildRouteEvidence(model, index)).filter(Boolean) as NonNullable<ReturnType<typeof buildRouteEvidence>>[];
}
