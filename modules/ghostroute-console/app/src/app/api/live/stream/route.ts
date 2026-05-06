import { buildPagedEvidenceContext, listLiveEvents } from "@/lib/server/selectors";

export const dynamic = "force-dynamic";

function eventPayload() {
  const model = buildPagedEvidenceContext({}, []);
  const events = listLiveEvents({ page: 1, pageSize: 150 });
  return {
    generated_at: new Date().toISOString(),
    freshness_minutes: model.freshnessMinutes,
    freshness_status: model.freshnessStatus,
    events: events.rows,
    total_events: events.total,
    route_decisions: [],
    alerts: model.alerts.slice(0, 5),
  };
}

export async function GET() {
  const encoder = new TextEncoder();
  let closed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream({
    start(controller) {
      const send = () => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: snapshot\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(eventPayload())}\n\n`));
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
