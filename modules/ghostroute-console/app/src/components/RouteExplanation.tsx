import Link from "next/link";
import type { ComponentType, ReactNode } from "react";
import { ArrowLeft, CheckCircle2, CircleDot, Download, Eye, Globe2, Network, Router, Server, Share2, ShieldCheck, User, Waypoints } from "lucide-react";
import { bytes, ChannelBadge, ConfidenceBadge, RawEvidence, RouteBadge } from "@/components/Widgets";

type Evidence = Record<string, any>;

const iconMap: Record<string, ComponentType<{ size?: number }>> = {
  Client: User,
  Router,
  "dnsmasq + ipset": Server,
  "sing-box": Waypoints,
  "reality-out": Network,
  "mixed-out": Network,
  Direct: Router,
  VPS: Server,
  Internet: Globe2,
};

function RouteChain({ evidence, compact = false }: { evidence: Evidence; compact?: boolean }) {
  return (
    <div className={compact ? "route-diagram route-diagram-compact" : "route-diagram"}>
      {evidence.steps.map((step: Record<string, any>, idx: number) => {
        const Icon = iconMap[step.label] || CircleDot;
        return (
          <div className="route-node-wrap" key={`${step.label}-${idx}`}>
            <div className="route-index">{idx + 1}</div>
            <div className="route-node">
              <Icon size={compact ? 18 : 24} />
              <strong>{step.label}</strong>
            </div>
            <small>{step.detail}</small>
            {idx < evidence.steps.length - 1 ? <div className="route-line" /> : null}
          </div>
        );
      })}
    </div>
  );
}

function EvidenceCard({ title, value, detail, tone }: { title: string; value: ReactNode; detail: ReactNode; tone?: string }) {
  return (
    <div className={tone ? `evidence-card ${tone}` : "evidence-card"}>
      <span>{title}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function notObserved(value: unknown) {
  if (value === undefined || value === null || value === "") return "not observed";
  return String(value);
}

function destinationEvidenceLevel(evidence: Evidence) {
  if (evidence.displayEvidenceKind === "IP/provider") return "provider/IP";
  if (evidence.flow.dns_qname || evidence.dnsMatches[0]?.domain) return "exact DNS";
  if (evidence.siteView.sni && evidence.siteView.sni !== "not observed" && evidence.siteView.sni !== "category aggregate") return "exact SNI";
  if (evidence.destinationIp && evidence.destinationIp !== "not observed") return "exact IP";
  if (evidence.flow.destination || evidence.destination) return "category/counter";
  return "not observed";
}

export function FlowDetailPanel({ evidence }: { evidence: Evidence | null }) {
  if (!evidence) {
    return (
      <aside className="flow-detail-panel">
        <div className="flow-detail-empty">
          <strong>No flow selected</strong>
          <span>Select a table row to inspect read-only evidence.</span>
        </div>
      </aside>
    );
  }

  return (
    <aside className="flow-detail-panel">
      <div className="flow-detail-header">
        <div>
          <span>Flow</span>
          <h2>{evidence.client}</h2>
        </div>
        <Link className="muted-button" href={`/traffic/${encodeURIComponent(evidence.id)}`}>Open</Link>
      </div>

      <div className="flow-route-summary">
        <div>
          <strong>{evidence.client}</strong>
          <small>{evidence.clientIp}</small>
        </div>
        <span>{"->"}</span>
        <div>
          <strong>{evidence.displayDestination || evidence.destination}</strong>
          <small>{evidence.destinationTechnical || evidence.destinationIp}:{evidence.destinationPort}</small>
        </div>
      </div>

      <div className="inline-badges flow-detail-badges">
        <RouteBadge value={evidence.route} />
        <ChannelBadge value={evidence.channel} />
        <ConfidenceBadge value={evidence.confidence} />
      </div>

      <section className="flow-detail-section">
        <h3><ShieldCheck size={16} /> Why this route?</h3>
        <p>{evidence.operatorView.decision}</p>
        <div className="flow-reason-box">
          <strong>{evidence.matchedRule}</strong>
          <span>{evidence.matchedRuleDetail || evidence.confidenceReason}</span>
        </div>
      </section>

      <section className="flow-detail-section">
        <h3><Waypoints size={16} /> Policy / Rule</h3>
        <div className="detail-list compact-detail-list">
          <div className="detail-row"><span>Policy</span><strong>{notObserved(evidence.flow.policy || evidence.flow.rule_set)}</strong></div>
          <div className="detail-row"><span>Rule</span><strong>{notObserved(evidence.matchedRule)}</strong></div>
          <div className="detail-row"><span>Outbound</span><strong>{notObserved(evidence.outbound)}</strong></div>
          <div className="detail-row"><span>DNS</span><strong>{notObserved(evidence.flow.dns_qname || evidence.dnsMatches[0]?.domain)}</strong></div>
        </div>
      </section>

      <section className="flow-detail-section">
        <h3><Globe2 size={16} /> Destination evidence</h3>
        <div className="detail-list compact-detail-list">
          <div className="detail-row"><span>Site / group</span><strong>{notObserved(evidence.siteView.destination || evidence.destination)}</strong></div>
          <div className="detail-row"><span>Domain</span><strong>{notObserved(evidence.domain)}</strong></div>
          <div className="detail-row"><span>DNS</span><strong>{notObserved(evidence.flow.dns_qname || evidence.dnsMatches[0]?.domain)}</strong></div>
          <div className="detail-row"><span>SNI</span><strong>{notObserved(evidence.siteView.sni || evidence.sni)}</strong></div>
          <div className="detail-row"><span>Destination IP</span><strong>{notObserved(evidence.destinationIp)}</strong></div>
          <div className="detail-row"><span>Provider / AS</span><strong>{notObserved(evidence.destinationCountryAs || evidence.siteView.destinationCountryAs)}</strong></div>
          <div className="detail-row"><span>Evidence level</span><strong>{destinationEvidenceLevel(evidence)}</strong></div>
        </div>
      </section>

      <section className="flow-detail-section">
        <h3><Network size={16} /> Flow details</h3>
        <div className="detail-list compact-detail-list">
          <div className="detail-row"><span>Transferred</span><strong>{bytes(evidence.bytes)}</strong></div>
          <div className="detail-row"><span>Connections</span><strong>{evidence.connections || 0}</strong></div>
          <div className="detail-row"><span>Protocol</span><strong>{notObserved(evidence.protocol)}</strong></div>
          <div className="detail-row"><span>SNI</span><strong>{notObserved(evidence.sni)}</strong></div>
          <div className="detail-row"><span>Time</span><strong>{evidence.eventTimeLabel}</strong></div>
          <div className="detail-row"><span>Confidence</span><strong>{evidence.confidence}</strong></div>
        </div>
      </section>

      <section className="flow-detail-section">
        <h3><Globe2 size={16} /> Site / Operator view</h3>
        <div className="detail-list compact-detail-list">
          <div className="detail-row"><span>Site sees</span><strong>{notObserved(evidence.siteView.visitorIp)}</strong></div>
          <div className="detail-row"><span>Country / AS</span><strong>{notObserved(evidence.siteView.countryAs)}</strong></div>
          <div className="detail-row"><span>Ingress</span><strong>{notObserved(evidence.operatorView.input)}</strong></div>
          <div className="detail-row"><span>Route</span><strong>{notObserved(evidence.operatorView.route)}</strong></div>
        </div>
      </section>

      <section className="flow-detail-section">
        <RawEvidence value={evidence.rawRefs} />
      </section>
    </aside>
  );
}

export function RouteExplanation({ evidence, all }: { evidence: Evidence; all: Evidence[] }) {
  const directExample = all.find((row) => row.id !== evidence.id && row.route === "Direct");
  return (
    <div className="route-layout route-layout-wide">
      <section className="route-main">
        <div className="route-breadcrumbs">
          <Link href="/traffic"><ArrowLeft size={16} /> Traffic Explorer</Link>
          <span>/</span>
          <Link href={`/clients?search=${encodeURIComponent(evidence.client)}`}>Clients</Link>
          <span>/</span>
          <strong>{evidence.client}</strong>
          <span>/</span>
          <strong>{evidence.destination}</strong>
        </div>

        <div className="toolbar route-titlebar">
          <div>
            <h2>Why this route?</h2>
            <p>Route decision from factual evidence: DNS, catalog, sing-box, counters, and channel lane.</p>
          </div>
          <div className="button-row">
            <Link className="muted-button" href={`/api/routes/${evidence.id}/export?format=markdown`}><Download size={15} /> Export report</Link>
            <Link className="muted-button primary" href={`/traffic/${evidence.id}`}><Share2 size={15} /> Share</Link>
          </div>
        </div>

        <section className="route-card">
          <div className="panel-title">
            <div>
              <h3>Route for {evidence.destination}</h3>
              <div className="inline-badges">
                <ChannelBadge value={evidence.channel} />
                <RouteBadge value={evidence.route} />
                <ConfidenceBadge value={evidence.confidence} />
              </div>
            </div>
          </div>
          <RouteChain evidence={evidence} />
          <div className="result-strip">
            <CheckCircle2 size={18} />
            Result: traffic to <strong>{evidence.destination}</strong> used <RouteBadge value={evidence.route} /> through <strong>{evidence.outbound}</strong>.
            Confidence: <ConfidenceBadge value={evidence.confidence} />.
          </div>
          <div className="evidence-grid evidence-grid-rich">
            <EvidenceCard title="Request source" value={evidence.client} detail={`Client IP: ${evidence.clientIp}`} />
            <EvidenceCard title="Access channel" value={<ChannelBadge value={evidence.channel} />} detail="access/client lane" />
            <EvidenceCard
              title="DNS request"
              value={evidence.dnsMatches[0]?.domain || evidence.flow.dns_qname || evidence.destination}
              detail={`${evidence.dnsMatches[0]?.qtype || "A"} · answer ${evidence.dnsMatches[0]?.answer_ip || evidence.flow.dns_answer_ip || "not observed"}`}
            />
            <EvidenceCard title="IP/rule evidence" value={evidence.matchedRule} detail={evidence.matchedRuleDetail || evidence.flow.rule_set || "derived rule evidence"} />
            <EvidenceCard
              title="Connection (sing-box)"
              value={evidence.destinationIp !== "not observed" ? `${evidence.destinationIp}:${evidence.destinationPort}` : evidence.protocol}
              detail={`${evidence.connections} connections · SNI ${evidence.sni} · ${evidence.outbound}`}
            />
            <EvidenceCard title="Decision" value={<RouteBadge value={evidence.route} />} detail={evidence.operatorView.decision} />
            <EvidenceCard title="Transferred" value={bytes(evidence.bytes)} detail="snapshot/event counters" />
            <EvidenceCard title="Visible egress IP" value={evidence.visibleIpLabel || evidence.visibleIp} detail={evidence.siteView.countryAs} />
            <EvidenceCard title="Event time" value={evidence.eventTimeLabel} detail={evidence.flow.ts_confidence || evidence.sourceKind} />
            <EvidenceCard title="Confidence" value={evidence.confidence} detail={evidence.confidenceReason} tone="evidence-confidence" />
          </div>
        </section>

        {directExample ? (
          <section className="route-example">
            <h3>Another example: why {directExample.destination} used Direct</h3>
            <RouteChain evidence={directExample} compact />
            <div className="result-strip">
              <CheckCircle2 size={18} />
              Result: traffic to <strong>{directExample.destination}</strong> went direct. Reason: <strong>{directExample.matchedRule}</strong>.
            </div>
            <div className="evidence-grid direct-grid">
              <EvidenceCard title="Reason" value={directExample.matchedRule} detail="direct rule/no managed match" />
              <EvidenceCard title="Decision" value={<RouteBadge value={directExample.route} />} detail={directExample.operatorView.decision} />
              <EvidenceCard title="Egress IP" value={directExample.visibleIp} detail="home/direct visibility" />
              <EvidenceCard title="Confidence" value={directExample.confidence} detail={directExample.confidenceReason} tone="evidence-confidence" />
            </div>
          </section>
        ) : null}
      </section>

      <aside className="side-panel route-rail route-rail-tight">
        <section className="card">
          <h3><Globe2 size={18} /> Site view</h3>
          <div className="detail-list">
            <div className="detail-row"><span>Destination</span><strong>{evidence.siteView.destination}</strong></div>
            <div className="detail-row"><span>Visitor IP</span><strong>{evidence.siteView.visitorIp}</strong></div>
            <div className="detail-row"><span>Country / AS</span><strong>{evidence.siteView.countryAs}</strong></div>
            <div className="detail-row"><span>Protocol</span><strong>{evidence.siteView.protocol}</strong></div>
            <div className="detail-row"><span>SNI</span><strong>{evidence.siteView.sni}</strong></div>
          </div>
        </section>
        <section className="card">
          <h3><Eye size={18} /> Operator view</h3>
          <div className="detail-list">
            <div className="detail-row"><span>Ingress</span><strong>{evidence.operatorView.input}</strong></div>
            <div className="detail-row"><span>Client IP</span><strong>{evidence.operatorView.clientIp}</strong></div>
            <div className="detail-row"><span>Output</span><strong>{evidence.operatorView.output}</strong></div>
            <div className="detail-row"><span>Route</span><strong>{evidence.operatorView.route}</strong></div>
            <div className="detail-row"><span>Rule</span><strong>{evidence.operatorView.rule}</strong></div>
            <div className="detail-row"><span>Decision</span><strong>{evidence.operatorView.decision}</strong></div>
            <div className="detail-row"><span>Confidence</span><strong>{evidence.operatorView.confidence}</strong></div>
          </div>
        </section>
        <section className="card info-card">
          <h3><ShieldCheck size={18} /> IP and routing logic</h3>
          <p>{evidence.ipLogic}</p>
          <p><strong>egress IP</strong> is the public exit IP visible to the destination. <strong>ingress</strong> is how the client entered GhostRoute. <strong>candidate</strong> is a catalog hint, not proof of an applied rule.</p>
        </section>
        <section className="card">
          <h3>Event timeline</h3>
          <div className="timeline timeline-vertical">
            {evidence.timeline.map((row: Record<string, any>, idx: number) => (
              <div className="timeline-row" key={`${row.label}-${idx}`}>
                <span>{idx + 1}</span>
                <div>
                  <strong>{row.at}</strong>
                  <small>{row.label}: {row.detail}</small>
                </div>
              </div>
            ))}
          </div>
        </section>
        <section className="card">
          <RawEvidence value={evidence.rawRefs} />
        </section>
      </aside>
    </div>
  );
}
