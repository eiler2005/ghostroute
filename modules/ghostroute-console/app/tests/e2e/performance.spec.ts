import { expect, test } from "@playwright/test";

const PAGE_BUDGET_MS = 2500;
const API_BUDGET_MS = 1500;

const pages = [
  { path: "/", nav: "Dashboard", markers: ["Observed traffic"] },
  { path: "/traffic", nav: "Flow Explorer", markers: ["Flow Explorer", "Нет traffic rows"] },
  { path: "/dns", nav: "DNS Query Log", markers: ["DNS Query Log", "Нет DNS query rows"] },
  { path: "/clients", nav: "Clients", markers: ["Device Inventory"] },
  { path: "/health", nav: "Health Center", markers: ["Health Center"] },
  { path: "/catalog", nav: "Catalog", markers: ["Diff preview"] },
  { path: "/budget", nav: "Budget", markers: ["Потребление по устройствам"] },
  { path: "/live", nav: "Live", markers: ["Client activity summary"] },
  { path: "/reports", nav: "Reports", markers: ["Privacy / Redaction Mode"] },
  { path: "/settings", nav: "Settings", markers: ["Settings"] },
];

const apiPaths = [
  "/api/dashboard",
  "/api/flows?pageSize=25",
  "/api/dns?pageSize=25",
  "/api/alarms?pageSize=25",
  "/api/clients?pageSize=25",
  "/api/health",
  "/api/catalog",
  "/api/live",
  "/api/budget",
  "/api/reports/llm-safe?format=json",
  "/api/notifications",
  "/api/audit",
];

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  for (const item of pages) {
    await page.goto(item.path);
    await Promise.any(item.markers.map((marker) => page.getByText(marker).first().waitFor({ state: "visible", timeout: 10_000 }))).catch(() => undefined);
  }
  await page.close();
});

for (const item of pages) {
  test(`page performance ${item.path}`, async ({ page }) => {
    const started = performance.now();
    await page.goto(item.path);
    await Promise.any(item.markers.map((marker) => page.getByText(marker).first().waitFor({ state: "visible", timeout: 5_000 })));
    const elapsed = performance.now() - started;
    expect(elapsed, `${item.path} rendered in ${Math.round(elapsed)}ms`).toBeLessThan(PAGE_BUDGET_MS);
  });
}

test("rapid sidebar navigation stays responsive", async ({ page }) => {
  await page.goto("/");
  for (const item of pages.slice(1)) {
    const started = performance.now();
    const label = item.nav;
    await page.locator(".sidebar").getByRole("link", { name: new RegExp(label, "i") }).click();
    await Promise.any(item.markers.map((marker) => page.getByText(marker).first().waitFor({ state: "visible", timeout: 5_000 })));
    const elapsed = performance.now() - started;
    expect(elapsed, `${item.path} navigation rendered in ${Math.round(elapsed)}ms`).toBeLessThan(item.path === "/live" ? 3000 : PAGE_BUDGET_MS);
  }
});

for (const path of apiPaths) {
  test(`api performance ${path}`, async ({ request }) => {
    const started = performance.now();
    const response = await request.get(path);
    const elapsed = performance.now() - started;
    expect(response.ok(), path).toBeTruthy();
    expect(elapsed, `${path} responded in ${Math.round(elapsed)}ms`).toBeLessThan(API_BUDGET_MS);
  });
}
