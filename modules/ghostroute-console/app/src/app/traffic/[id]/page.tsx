import { notFound } from "next/navigation";
import { ConsoleShell } from "@/components/ConsoleShell";
import { RouteExplanation } from "@/components/RouteExplanation";
import { buildRouteEvidence, buildRouteEvidences } from "@/lib/server/evidence";
import { buildConsoleModel } from "@/lib/server/selectors";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";

export default async function RouteDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: SearchParams;
}) {
  const filters = await filtersFromSearchParams(searchParams);
  const model = buildConsoleModel(filters);
  const { id } = await params;
  const index = Number.parseInt(id, 10);
  if (!Number.isFinite(index)) notFound();
  const evidence = buildRouteEvidence(model, index);
  if (!evidence) notFound();
  return (
    <ConsoleShell active="/traffic" model={model} filters={filters}>
      <RouteExplanation evidence={evidence} all={buildRouteEvidences(model)} />
    </ConsoleShell>
  );
}
