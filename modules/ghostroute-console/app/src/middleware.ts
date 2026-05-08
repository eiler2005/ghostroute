import { NextRequest, NextResponse } from "next/server";

const mobileRoutes: Record<string, string> = {
  "/": "/m",
  "/traffic": "/m/traffic",
  "/dns": "/m/dns",
  "/clients": "/m/clients",
  "/live": "/m/live",
  "/catalog": "/m/catalog",
};

function isMobile(request: NextRequest) {
  const hint = request.headers.get("sec-ch-ua-mobile") || "";
  const userAgent = request.headers.get("user-agent") || "";
  return hint === "?1" || /iphone|ipad|android|mobile/i.test(userAgent);
}

function isBypassed(pathname: string) {
  return (
    pathname.startsWith("/api") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/m") ||
    pathname.startsWith("/traffic/") ||
    /\.[a-z0-9]+$/i.test(pathname)
  );
}

export function middleware(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  if (!isMobile(request) || searchParams.get("desktop") === "1" || isBypassed(pathname)) {
    return NextResponse.next();
  }
  const target = mobileRoutes[pathname];
  if (!target) return NextResponse.next();
  return NextResponse.redirect(mobileRedirectUrl(request, target));
}

function firstHeaderValue(value: string | null) {
  return value?.split(",")[0]?.trim() || "";
}

function mobileRedirectUrl(request: NextRequest, target: string) {
  const forwardedHost = firstHeaderValue(request.headers.get("x-forwarded-host"));
  const forwardedProto = firstHeaderValue(request.headers.get("x-forwarded-proto"));
  const forwardedPort = firstHeaderValue(request.headers.get("x-forwarded-port"));
  const host = forwardedHost || request.headers.get("host") || request.nextUrl.host;
  const protocol = (forwardedProto || request.nextUrl.protocol.replace(":", "") || "https").replace(/:$/, "");
  const hasPort = host.includes(":");
  const defaultPort = (protocol === "https" && forwardedPort === "443") || (protocol === "http" && forwardedPort === "80");
  const authority = forwardedPort && !hasPort && !defaultPort ? `${host}:${forwardedPort}` : host;
  const url = new URL(`${protocol}://${authority}`);
  url.pathname = target;
  url.search = request.nextUrl.search;
  return url;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
