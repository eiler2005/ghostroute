import { NextRequest, NextResponse } from "next/server";
import { buildConsoleModel } from "@/lib/server/selectors";
import { llmSafePayload, redactedMarkdown, redactJson } from "@/lib/server/redaction";

export async function GET(request: NextRequest) {
  const model = buildConsoleModel();
  const format = request.nextUrl.searchParams.get("format") || "json";
  const payload = llmSafePayload(model);

  if (format === "markdown") {
    return new NextResponse(redactedMarkdown("GhostRoute Console LLM-safe Export", payload), {
      headers: { "content-type": "text/markdown; charset=utf-8" },
    });
  }

  return NextResponse.json(redactJson(payload));
}
