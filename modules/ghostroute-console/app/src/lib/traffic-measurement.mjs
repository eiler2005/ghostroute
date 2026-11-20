// Measurement quality is independent of identity, route proof and coverage.
export function trafficMeasurement(row = {}) {
  let raw = row.raw || {};
  if (!Object.keys(raw).length && row.evidence_json) {
    try { raw = JSON.parse(row.evidence_json); } catch { raw = {}; }
  }
  if (!raw || typeof raw !== 'object') raw = {};
  const kind = row.measurement_kind || raw.measurement_kind
    || (raw.evidence_level === 'proxy_connection_event' ? 'connection_event'
      : raw.destination_kind === 'unattributed_counter' ? 'counter_delta' : 'flow_sample');
  const byteConfidence = row.byte_confidence || raw.byte_confidence || row.confidence || raw.confidence || 'unknown';
  const bytesMeasured = kind !== 'connection_event' && byteConfidence !== 'not_measured';
  return {
    kind,
    bytesMeasured,
    byteConfidence,
    label: kind === 'counter_delta' ? 'Counter observations'
      : kind === 'connection_event' ? 'Connection event · bytes not measured'
        : kind === 'completed_stream' ? 'Completed stream' : 'Flow observations',
  };
}
