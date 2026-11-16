// Shares describe the displayed evidence set; bar lengths compare with its leader.
export function trafficRankingMetrics(rows, valueOf = row => Number(row.bytes ?? row.total_bytes ?? 0)) {
  const values = rows.map(row => Math.max(0, Number(valueOf(row)) || 0));
  const total = values.reduce((sum, value) => sum + value, 0);
  const max = Math.max(0, ...values);
  return values.map(value => ({
    sharePct: total ? Math.round(100 * value / total) : 0,
    relativePct: max ? 100 * value / max : 0,
  }));
}

export function appByteQuality(row) {
  if (Number(row.residual_bytes || 0) > 0 || row.app_source === 'aggregate_residual') return 'residual';
  if (Number(row.inferred_bytes || 0) > 0) return 'estimated';
  return Number(row.factual_bytes || 0) > 0 ? 'factual' : row.byte_confidence || row.app_confidence || 'unknown';
}
