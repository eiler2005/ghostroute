import { notFound } from "next/navigation";
import { ConsoleShell } from "@/components/ConsoleShell";
import { RouteExplanation } from "@/components/RouteExplanation";
import { buildRouteEvidenceSet } from "@/lib/server/evidence";
import { buildPagedEvidenceContext, getTrafficRowById, listTrafficRows } from "@/lib/server/selectors";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";

export default async function RouteDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: SearchParams;
}) {
  const filters = await filtersFromSearchParams(searchParams);
  const { id } = await params;
  const decodedId = decodeURIComponent(id);
  const index = Number.parseInt(decodedId, 10);
  const fallbackPage = Number.isFinite(index) ? listTrafficRows({ page: 1, pageSize: Math.max(index + 1, 25), filters }) : null;
  const row = getTrafficRowById(decodedId, filters) || fallbackPage?.rows[index];
  if (!row) notFound();
  const neighbors = listTrafficRows({ page: 1, pageSize: 24, filters }).rows.filter((item: Record<string, any>) => item.id !== row.id);
  const model = buildPagedEvidenceContext(filters, [row, ...neighbors]);
  const evidenceSet = buildRouteEvidenceSet(model, { limit: 25, fallbackToDiagnostics: true });
  const evidence = evidenceSet.evidences.find((item: Record<string, any>) => item.id === row.id) || evidenceSet.evidences[0];
  if (!evidence) notFound();
  return (
    <ConsoleShell active="/traffic" model={model} filters={filters}>
      <RouteExplanation evidence={evidence} all={evidenceSet.evidences} />
    </ConsoleShell>
  );
}
