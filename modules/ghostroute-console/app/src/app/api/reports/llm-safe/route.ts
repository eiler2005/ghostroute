import { NextRequest, NextResponse } from "next/server";
import { buildReportModel } from "@/lib/server/selectors/reports";
import { filtersFromSearchParams } from "@/lib/server/page";
import { llmSafePayload, redactedMarkdown, redactJson } from "@/lib/server/redaction";

export const dynamic = "force-dynamic";
export const revalidate = 300;

export async function GET(request: NextRequest) {
  const filters = await filtersFromSearchParams(Promise.resolve(Object.fromEntries(request.nextUrl.searchParams)));
  const model = buildReportModel(filters);
  const format = request.nextUrl.searchParams.get("format") || "json";
  const payload = llmSafePayload(model);

  if (format === "markdown") {
    return new NextResponse(redactedMarkdown("GhostRoute Console LLM-safe Export", payload), {
      headers: { "content-type": "text/markdown; charset=utf-8" },
    });
  }

  return NextResponse.json(redactJson(payload));
}
