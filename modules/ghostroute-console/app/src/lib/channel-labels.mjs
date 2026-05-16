export function normalizeChannelLabel(channels = []) {
  const clean = Array.from(new Set((channels || [])
    .flatMap((value) => String(value || "").split(/\s+\+\s+/))
    .map((value) => value.trim())
    .filter((value) => value && value !== "Unknown")));
  if (clean.length === 0) return "Unknown";
  const rank = (value) => {
    if (value.includes("A/Home")) return 0;
    if (value.includes("Channel B")) return 1;
    if (value.includes("Channel C")) return 2;
    if (value.includes("Home Wi-Fi")) return 3;
    return 4;
  };
  return clean.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).join(" + ");
}
