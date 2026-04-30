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
            <h2>Почему маршрут именно такой?</h2>
            <p>Разбираем route decision по factual evidence: DNS, catalog, sing-box, counters и channel lane.</p>
          </div>
          <div className="button-row">
            <Link className="muted-button" href={`/api/routes/${evidence.id}/export?format=markdown`}><Download size={15} /> Экспорт отчёта</Link>
            <Link className="muted-button primary" href={`/traffic/${evidence.id}`}><Share2 size={15} /> Поделиться</Link>
          </div>
        </div>

        <section className="route-card">
          <div className="panel-title">
            <div>
              <h3>Маршрут для {evidence.destination}</h3>
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
            Итог: traffic to <strong>{evidence.destination}</strong> прошёл как <RouteBadge value={evidence.route} /> через <strong>{evidence.outbound}</strong>.
            Уверенность: <ConfidenceBadge value={evidence.confidence} />.
          </div>
          <div className="evidence-grid evidence-grid-rich">
            <EvidenceCard title="От кого запрос" value={evidence.client} detail={`IP: ${evidence.clientIp}`} />
            <EvidenceCard title="Канал входа" value={<ChannelBadge value={evidence.channel} />} detail="access/client lane" />
            <EvidenceCard title="Запрос DNS" value={evidence.dnsMatches[0]?.domain || evidence.destination} detail={`${evidence.dnsMatches[0]?.qtype || "A"} · ${evidence.dnsMatches[0]?.count || 1} seen`} />
            <EvidenceCard title="Совпавшее правило" value={evidence.matchedRule} detail={evidence.catalogMatches[0]?.domain || "derived rule evidence"} />
            <EvidenceCard title="Соединение (sing-box)" value={evidence.protocol} detail={`${evidence.connections} connections · SNI ${evidence.sni}`} />
            <EvidenceCard title="Принятое решение" value={<RouteBadge value={evidence.route} />} detail={evidence.operatorView.decision} />
            <EvidenceCard title="Передано" value={bytes(evidence.bytes)} detail="snapshot/event counters" />
            <EvidenceCard title="Выходной IP (виден сайту)" value={evidence.visibleIp} detail={evidence.siteView.countryAs} />
            <EvidenceCard title="Уверенность" value={evidence.confidence} detail={evidence.confidenceReason} tone="evidence-confidence" />
          </div>
        </section>

        {directExample ? (
          <section className="route-example">
            <h3>Ещё один пример: почему {directExample.destination} ушёл Direct</h3>
            <RouteChain evidence={directExample} compact />
            <div className="result-strip">
              <CheckCircle2 size={18} />
              Итог: traffic to <strong>{directExample.destination}</strong> прошёл напрямую. Причина: <strong>{directExample.matchedRule}</strong>.
            </div>
            <div className="evidence-grid direct-grid">
              <EvidenceCard title="Причина" value={directExample.matchedRule} detail="direct rule/no managed match" />
              <EvidenceCard title="Решение" value={<RouteBadge value={directExample.route} />} detail={directExample.operatorView.decision} />
              <EvidenceCard title="Выходной IP" value={directExample.visibleIp} detail="home/direct visibility" />
              <EvidenceCard title="Уверенность" value={directExample.confidence} detail={directExample.confidenceReason} tone="evidence-confidence" />
            </div>
          </section>
        ) : null}
      </section>

      <aside className="side-panel route-rail route-rail-tight">
        <section className="card">
          <h3><Globe2 size={18} /> Что видит сайт</h3>
          <div className="detail-list">
            <div className="detail-row"><span>Destination</span><strong>{evidence.siteView.destination}</strong></div>
            <div className="detail-row"><span>IP посетителя</span><strong>{evidence.siteView.visitorIp}</strong></div>
            <div className="detail-row"><span>Страна / AS</span><strong>{evidence.siteView.countryAs}</strong></div>
            <div className="detail-row"><span>Протокол</span><strong>{evidence.siteView.protocol}</strong></div>
            <div className="detail-row"><span>SNI</span><strong>{evidence.siteView.sni}</strong></div>
          </div>
        </section>
        <section className="card">
          <h3><Eye size={18} /> Что видит оператор</h3>
          <div className="detail-list">
            <div className="detail-row"><span>Вход</span><strong>{evidence.operatorView.input}</strong></div>
            <div className="detail-row"><span>Client IP</span><strong>{evidence.operatorView.clientIp}</strong></div>
            <div className="detail-row"><span>Выход</span><strong>{evidence.operatorView.output}</strong></div>
            <div className="detail-row"><span>Маршрут</span><strong>{evidence.operatorView.route}</strong></div>
            <div className="detail-row"><span>Правило</span><strong>{evidence.operatorView.rule}</strong></div>
            <div className="detail-row"><span>Решение</span><strong>{evidence.operatorView.decision}</strong></div>
            <div className="detail-row"><span>Уверенность</span><strong>{evidence.operatorView.confidence}</strong></div>
          </div>
        </section>
        <section className="card info-card">
          <h3><ShieldCheck size={18} /> Об IP и логике</h3>
          <p>{evidence.ipLogic}</p>
        </section>
        <section className="card">
          <h3>Хронология событий</h3>
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
