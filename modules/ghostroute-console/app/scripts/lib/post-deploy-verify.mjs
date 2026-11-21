export const optionalPostDeployErrorTypes = new Set(["health"]);

export function assertFreshSourceSnapshot(row, nowMs = Date.now(), maxAgeMs = 3600000) {
  const observedMs = Date.parse(row?.collected_at || "");
  if (!Number.isFinite(observedMs) || nowMs - observedMs > maxAgeMs || observedMs - nowMs > 300000) {
    throw new Error(`missing, stale or future source snapshot: ${row?.type || "unknown"}`);
  }
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function splitCollectorRunErrors(latestRun, errorRows = []) {
  if (number(latestRun?.error_count) <= 0) {
    return { allErrors: [], hardErrors: [], optionalErrors: [] };
  }

  const allErrors = errorRows.length
    ? errorRows.map((row) => ({
        type: String(row.type || "unknown"),
        message: String(row.message || ""),
      }))
    : [{ type: "unknown", message: "collector error count without detail row" }];

  const optionalErrors = allErrors.filter((row) => optionalPostDeployErrorTypes.has(row.type));
  const hardErrors = allErrors.filter((row) => !optionalPostDeployErrorTypes.has(row.type));
  return { allErrors, hardErrors, optionalErrors };
}
