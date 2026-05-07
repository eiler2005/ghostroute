"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const warmupRoutes = ["/traffic", "/dns", "/clients", "/live"];
const warmupApis = [
  "/api/flows?pageSize=25",
  "/api/dns?pageSize=50",
  "/api/clients?pageSize=10",
  "/api/live?pageSize=50",
];

export function ConsoleWarmup() {
  const router = useRouter();

  useEffect(() => {
    const warm = () => {
      for (const route of warmupRoutes) {
        router.prefetch(route);
      }
      for (const href of warmupApis) {
        fetch(href, { credentials: "same-origin" }).catch(() => undefined);
      }
    };
    const idle = typeof window.requestIdleCallback === "function"
      ? window.requestIdleCallback(warm, { timeout: 2500 })
      : window.setTimeout(warm, 600);
    return () => {
      if (typeof idle === "number") window.clearTimeout(idle);
      else if (typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(idle);
    };
  }, [router]);

  return null;
}
