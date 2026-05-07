import type { NextRequest } from "next/server";
import { buildPagedEvidenceContext, listLiveEvents } from "@/lib/server/selectors";

export const dynamic = "force-dynamic";

function numberParam(value: string | null, fallback: number, max?: number) {
  const parsed = Math.max(1, Number.parseInt(value || String(fallback), 10) || fallback);
  return max ? Math.min(parsed, max) : parsed;
}

function eventPayload(request: NextRequest) {
  const search = request.nextUrl.searchParams;
  const filters = {
    period: search.get("period") || "today",
    route: search.get("route") || "all",
    channel: search.get("channel") || "all",
    confidence: search.get("confidence") || "all",
    trafficClass: search.get("trafficClass") || "client",
    client: search.get("client") || "all",
    search: search.get("search") || "",
  };
  const model = buildPagedEvidenceContext(filters, []);
  const events = listLiveEvents({
    page: numberParam(search.get("page"), 1),
    pageSize: numberParam(search.get("pageSize"), 150, 1000),
    filters,
  });
  return {
    generated_at: new Date().toISOString(),
    freshness_minutes: model.freshnessMinutes,
    freshness_status: model.freshnessStatus,
    events: events.rows,
    total_events: events.total,
    route_decisions: [],
    pagination: { total: events.total, page: events.page, pageSize: events.pageSize, totalPages: events.totalPages },
    alerts: model.alerts.slice(0, 5),
  };
}

export async function GET(request: NextRequest) {
  const encoder = new TextEncoder();
  let closed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream({
    start(controller) {
      const send = () => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: snapshot\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(eventPayload(request))}\n\n`));
      };
      send();
      timer = setInterval(send, Number(process.env.GHOSTROUTE_LIVE_UI_REFRESH_MS || 600000));
    },
    cancel() {
      closed = true;
      if (timer) clearInterval(timer);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
