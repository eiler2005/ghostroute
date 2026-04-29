import type { ConsoleFilters } from "./types";

export type SearchParams = Promise<Record<string, string | string[] | undefined>> | undefined;

function scalar(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export async function filtersFromSearchParams(searchParams: SearchParams): Promise<ConsoleFilters> {
  const params = searchParams ? await searchParams : {};
  return {
    period: scalar(params.period) || "today",
    route: scalar(params.route) || "all",
    client: scalar(params.client) || "all",
    confidence: scalar(params.confidence) || "all",
    search: scalar(params.search) || "",
  };
}
