export function routeSplitLabel(vps, direct, unknown, format) {
  const a = Number(vps || 0), b = Number(direct || 0), c = Number(unknown || 0);
  if (c > 0 && a === 0 && b === 0) return `Route not observed · ${format(c)} unattributed`;
  return `VPS ${format(a)} · Direct ${format(b)} · Unknown ${format(c)}`;
}
