import { buildConsoleModel } from "@/lib/server/selectors";

export const dynamic = "force-dynamic";

function eventPayload() {
  const model = buildConsoleModel();
  const compact = ({ raw, evidence, evidence_json, ...row }: Record<string, any>) => row;
  return {
    generated_at: new Date().toISOString(),
    freshness_minutes: model.freshnessMinutes,
    freshness_status: model.freshnessStatus,
    events: model.events.slice(0, 8).map(compact),
    route_decisions: model.routeDecisions.slice(0, 8).map(compact),
    alerts: model.alerts.slice(0, 5).map(compact),
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
      timer = setInterval(send, 5000);
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
