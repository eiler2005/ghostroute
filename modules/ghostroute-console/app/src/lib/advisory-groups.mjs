// A destination can legitimately have distinct actions or explanations.
// Group only identical advisory summaries; preserve every evidence row.
export function groupAdvisories(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.destination_key, row.proposed_action, row.status || 'pending', Number(row.applied || 0), row.confidence, row.reason_code, row.explanation]);
    const group = groups.get(key);
    if (group) group.evidenceRows.push(row);
    else groups.set(key, { ...row, evidenceRows: [row] });
  }
  return [...groups.values()];
}
