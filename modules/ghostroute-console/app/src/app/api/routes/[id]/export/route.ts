import { NextRequest, NextResponse } from "next/server";
import { buildRouteEvidence } from "@/lib/server/evidence";
import { buildConsoleModel } from "@/lib/server/selectors";
import { redactJson, redactedMarkdown } from "@/lib/server/redaction";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const evidence = buildRouteEvidence(buildConsoleModel(), Number.parseInt(id, 10));
  if (!evidence) return NextResponse.json({ error: "route evidence not found" }, { status: 404 });
  const payload = redactJson({
    schema_version: 1,
    generated_at: new Date().toISOString(),
    route_evidence: {
      id: evidence.id,
      client: evidence.client,
      client_ip: evidence.clientIp,
      channel: evidence.channel,
      destination: evidence.destination,
      route: evidence.route,
      outbound: evidence.outbound,
      matched_rule: evidence.matchedRule,
      visible_ip: evidence.visibleIp,
      protocol: evidence.protocol,
      sni: evidence.sni,
      bytes: evidence.bytes,
      confidence: evidence.confidence,
      confidence_reason: evidence.confidenceReason,
      site_view: evidence.siteView,
      operator_view: evidence.operatorView,
      timeline: evidence.timeline,
    },
  });
  if (request.nextUrl.searchParams.get("format") === "markdown") {
    return new NextResponse(redactedMarkdown("GhostRoute Route Explanation", payload), {
      headers: { "content-type": "text/markdown; charset=utf-8" },
    });
  }
  return NextResponse.json(payload);
}
