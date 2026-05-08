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
  const nextUrl = request.nextUrl.clone();
  nextUrl.pathname = target;
  return NextResponse.redirect(nextUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
