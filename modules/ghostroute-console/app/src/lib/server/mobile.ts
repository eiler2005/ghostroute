import { headers } from "next/headers";

export async function isMobileRequest() {
  const requestHeaders = await headers();
  const userAgent = requestHeaders.get("user-agent") || "";
  const mobileHint = requestHeaders.get("sec-ch-ua-mobile") || "";
  return mobileHint === "?1" || /iphone|ipad|android|mobile/i.test(userAgent);
}

export function boundedPageSize(
  rawValue: string | undefined,
  defaults: { desktop: number; mobile: number; min: number; desktopMax: number; mobileMax: number },
  mobile: boolean,
) {
  const fallback = mobile ? defaults.mobile : defaults.desktop;
  const max = mobile ? defaults.mobileMax : defaults.desktopMax;
  const parsed = Number.parseInt(rawValue || String(fallback), 10) || fallback;
  return Math.min(max, Math.max(defaults.min, parsed));
}
