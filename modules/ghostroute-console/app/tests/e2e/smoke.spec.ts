import { expect, test } from "@playwright/test";

const pages = ["/", "/traffic", "/dns", "/clients", "/health", "/catalog", "/budget", "/live", "/reports", "/settings"];
const mobileRedirects: Record<string, string> = {
  "/": "/m",
  "/traffic": "/m/traffic",
  "/dns": "/m/dns",
  "/clients": "/m/clients",
  "/health": "/m/health",
  "/live": "/m/live",
  "/catalog": "/m/catalog",
};

for (const path of pages) {
  test(`renders ${path}`, async ({ page, isMobile }) => {
    await page.goto(path);
    if (isMobile && mobileRedirects[path]) await expect(page).toHaveURL(new RegExp(`${mobileRedirects[path]}(?:\\?|$)`));
    await expect(page.getByText("GhostRoute").first()).toBeVisible();
    await expect(page.getByText("Loading console state")).toHaveCount(0);
    await expect(page.locator("body")).not.toHaveText("");
  });
}

test("filters are visible and stable", async ({ page, isMobile }) => {
  await page.goto(isMobile ? "/traffic?desktop=1" : "/traffic");
  await expect(page.locator("select[name='period']")).toBeVisible();
  await expect(page.locator("select[name='route']")).toBeVisible();
  await expect(page.locator("select[name='confidence']")).toBeVisible();
  await expect(page.locator("select[name='trafficClass']")).toBeVisible();
  await expect(page.locator("input[name='search']")).toBeVisible();
});

test("dashboard shows traffic analytics in English", async ({ page, isMobile }) => {
  await page.goto(isMobile ? "/?desktop=1" : "/");
  await expect(page.getByRole("heading", { name: "Traffic today" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Top clients" }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Top destinations" }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "VPS traffic this month" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "LTE reserve (mobile internet)" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Traffic usage" })).toBeVisible();
  await expect(page.locator(".chart-legend .legend-vps").first()).toContainText("Via VPS");
  await expect(page.locator(".chart-legend .legend-forecast").first()).toContainText("VPS forecast");
  await expect(page.locator("body")).not.toContainText("Трафик");
});

test("flow workbench exposes inline detail and gated evidence", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop-only flow detail workbench; mobile uses the compact /m surface");
  await page.goto("/traffic");
  if (await page.getByText("No traffic rows").isVisible().catch(() => false)) {
    await expect(page.getByText("No traffic rows")).toBeVisible();
    return;
  }
  await expect(page.locator(".traffic-workbench")).toBeVisible();
  await expect(page.locator(".flow-detail-panel")).toBeVisible();
  await expect(page.locator(".flow-detail-panel")).toContainText("Why this route?");
  await expect(page.locator(".flow-detail-panel")).toContainText("Site / Operator view");
  const secondRow = page.locator(".route-table-card tbody tr").nth(1);
  const secondHref = await secondRow.locator("a").first().getAttribute("href");
  const selectedFlow = secondHref ? new URL(secondHref, "http://localhost").searchParams.get("flow") : "";
  await secondRow.locator(".col-route a").click();
  await expect(page).toHaveURL(/flow=/);
  const encodedFlow = selectedFlow ? encodeURIComponent(selectedFlow).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "";
  if (encodedFlow) await expect(page).toHaveURL(new RegExp(`flow=${encodedFlow}`));
  await expect(page.locator(".route-table-card tbody tr.selected")).toHaveCount(1);
  await expect(page.locator(".route-table-card tbody tr.selected a").first()).toHaveAttribute("href", new RegExp(`flow=${encodedFlow}`));
  await page.locator(".flow-detail-panel .evidence-details summary").first().click({ force: true });
  await expect(page.locator(".flow-detail-panel .codebox").first()).toBeVisible();
});

test("shared route detail resolves exact flow session ids", async ({ page }) => {
  await page.goto(`/traffic/${encodeURIComponent("test-seed:flow:0001")}`);
  await expect(page.getByText("Why this route?")).toBeVisible();
  await expect(page.getByText("Route for")).toBeVisible();
});

test("traffic explorer hides technical evidence noise by default", async ({ page, isMobile }) => {
  await page.goto(isMobile ? "/traffic?desktop=1" : "/traffic");
  if (await page.getByText("No traffic rows").isVisible().catch(() => false)) {
    await expect(page.getByText("No traffic rows")).toBeVisible();
    return;
  }
  await expect(page.getByRole("heading", { name: "Flow Explorer" }).first()).toBeVisible();
  await expect(page.getByText("Read-only analysis of prepared flows")).toBeVisible();
  await expect(page.getByText("flows by volume with policy, route and risk context")).toBeVisible();
  await expect(page.locator(".traffic-stream-meta").nth(1)).toContainText("hidden system/no-byte evidence");
  const firstRow = page.locator(".route-table-card tbody tr").first();
  if (await firstRow.count()) {
    await expect(firstRow).toBeVisible();
    await expect(firstRow).not.toContainText("Unknown");
    await expect(firstRow).not.toContainText("0 B");
  } else {
    await expect(page.getByText("No traffic rows")).toBeVisible();
  }
  await page.goto(isMobile ? "/traffic?diagnostics=1&desktop=1" : "/traffic?diagnostics=1");
  if (await page.getByText("No traffic rows").isVisible().catch(() => false)) {
    await expect(page.getByText("No traffic rows")).toBeVisible();
  } else {
    await expect(page.getByText("Diagnostics mode: technical DNS and route events are visible.")).toBeVisible();
  }
});

test("traffic classes and live cadence are explicit", async ({ page, isMobile }) => {
  await page.goto(isMobile ? "/?desktop=1" : "/");
  await expect(page.getByRole("heading", { name: "Service/background traffic" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Needs attribution" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Client traffic snapshot rows" })).toBeVisible();
  const clientRowsY = await page.getByRole("heading", { name: "Client traffic snapshot rows" }).boundingBox();
  const serviceY = await page.getByRole("heading", { name: "Service/background traffic" }).boundingBox();
  expect(clientRowsY?.y || 0).toBeLessThan(serviceY?.y || Number.POSITIVE_INFINITY);
  await page.goto(isMobile ? "/traffic?trafficClass=unclassified&desktop=1" : "/traffic?trafficClass=unclassified");
  if (await page.getByText("No traffic rows").isVisible().catch(() => false)) {
    await expect(page.getByText("No traffic rows")).toBeVisible();
  } else {
    await expect(page.getByText("Needs attribution flows by volume")).toBeVisible();
  }
  await page.goto(isMobile ? "/live?desktop=1" : "/live");
  await expect(page.getByText("Auto-refresh around 10 minutes")).toBeVisible();
  if (!isMobile) await expect(page.getByText("Service/background live events")).toBeVisible();
});

test("flow layout and row selection stay stable on desktop", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop-only flow layout smoke");
  await page.setViewportSize({ width: 2048, height: 900 });
  await page.goto("/traffic");
  if (await page.getByText("No traffic rows").isVisible().catch(() => false)) return;

  const meta = page.locator(".traffic-stream-meta").nth(1);
  const header = page.locator(".flow-events-table thead").first();
  await expect(meta).toBeVisible();
  await expect(header).toBeVisible();
  const metaBox = await meta.boundingBox();
  const headerBox = await header.boundingBox();
  expect((headerBox?.y || 0)).toBeGreaterThan((metaBox?.y || 0) + (metaBox?.height || 0) - 1);

  const kpiBox = await page.locator(".flow-kpi-wide").boundingBox();
  const labelBoxes = await page.locator(".flow-kpi-wide .flow-vps-breakdown small").evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    })
  );
  for (const box of labelBoxes) {
    expect(box.left).toBeGreaterThanOrEqual((kpiBox?.x || 0) - 1);
    expect(box.right).toBeLessThanOrEqual((kpiBox?.x || 0) + (kpiBox?.width || 0) + 1);
  }
});

test("live filters keep event pagination scoped", async ({ page, isMobile }) => {
  await page.goto(isMobile ? "/live?client=__no_such_client__&desktop=1" : "/live?client=__no_such_client__");
  await expect(page.getByRole("heading", { name: "Live event stream" })).toBeVisible();
  await expect(page.locator(".live-primary .dense-top-pager .pagination")).toContainText("Showing 0-0 of 0");
  await expect(page.locator(".live-primary-footer .pagination")).toContainText("Showing 0-0 of 0");
  if (!isMobile) await expect(page.locator(".service-events-card .pagination")).toContainText("Showing 0-0 of 0");
  await page.waitForTimeout(1200);
  await expect(page.locator(".live-primary .dense-top-pager .pagination")).toContainText("Showing 0-0 of 0");
  await expect(page.locator(".live-primary-footer .pagination")).toContainText("Showing 0-0 of 0");
});

test("dense console tables keep pagination controls visible", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop-only dense table smoke");
  await page.setViewportSize({ width: 2048, height: 760 });
  for (const path of ["/live", "/dns"]) {
    await page.goto(path);
    await expect(page.locator(".dense-top-pager .pagination").first()).toBeVisible();
    await expect(page.locator(".pagination").first()).toBeVisible();
  }

  await page.goto("/traffic");
  if (!(await page.getByText("No traffic rows").isVisible().catch(() => false))) {
    await expect(page.locator(".traffic-stream-card .dense-top-pager .pagination")).toBeVisible();
    await expect(page.locator(".traffic-stream-card .live-card-footer .pagination")).toBeVisible();
  }
});

test("clients separate inventory from selected-window traffic", async ({ page, isMobile }) => {
  await page.goto(isMobile ? "/clients?desktop=1" : "/clients");
  await expect(page.getByRole("heading", { name: "Device Inventory" })).toBeVisible();
  await expect(page.getByText("traffic for selected window")).toBeVisible();
  const headers = page.locator(".clients-table").first().locator("th");
  await expect(headers.nth(0)).toHaveText("Device");
  await expect(headers.nth(1)).toHaveText("Channel");
  await expect(headers.nth(2)).toHaveText("Window traffic");
  await expect(page.locator(".clients-table th").filter({ hasText: "Window traffic" }).first()).toBeAttached();
  await expect(page.locator(".clients-table-scroll").first()).toBeVisible();
});

test("clients row selection updates the detail panel", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop-only client detail panel");
  await page.goto("/clients");
  const secondRow = page.locator(".clients-card tbody tr").nth(1);
  if ((await secondRow.count()) === 0) return;
  const deviceName = (await secondRow.locator("td").first().innerText()).trim();
  const secondHref = await secondRow.locator("a").first().getAttribute("href");
  const selectedClient = secondHref ? new URL(secondHref, "http://localhost").searchParams.get("client") : "";
  await secondRow.locator("td").nth(2).locator("a").click();
  await expect(page).toHaveURL(/client=/);
  const encodedClient = selectedClient ? encodeURIComponent(selectedClient).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "";
  if (encodedClient) await expect(page).toHaveURL(new RegExp(`client=${encodedClient}`));
  await expect(page.locator(".clients-card tbody tr.selected")).toHaveCount(1);
  await expect(page.locator(".side-panel")).toContainText(deviceName);
});

test("live summary shows milliseconds and aggregated DNS interest", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop-only live summary panels");
  await page.goto("/live");
  const firstTime = page.locator(".client-activity-table tbody tr .live-col-time").first();
  if (await firstTime.count()) await expect(firstTime).toHaveText(/\d{2}:\d{2}:\d{2}\.\d{3}/);

  const dnsSection = page.locator(".grid.three section").filter({ has: page.getByRole("heading", { name: "DNS interest" }) });
  const domains = (await dnsSection.locator(".detail-row span").allTextContents()).map((value) => value.trim()).filter(Boolean);
  expect(new Set(domains).size).toBe(domains.length);
});

test("mobile keeps controls and content reachable", async ({ page, isMobile }) => {
  test.skip(!isMobile, "mobile-only overflow smoke");
  await page.goto("/m/clients");
  await expect(page.locator(".mobile-shell")).toBeVisible();
  await expect(page.locator("input[name='search']")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Clients" })).toBeVisible();
});

test("mobile serves compact heavy console pages", async ({ page, isMobile }) => {
  test.skip(!isMobile, "mobile-only compact SSR smoke");

  await page.goto("/traffic");
  await expect(page).toHaveURL(/\/m\/traffic/);
  await expect(page.getByRole("heading", { name: "Flow Explorer" }).first()).toBeVisible();
  await expect(page.locator(".flow-detail-panel")).toHaveCount(0);
  expect(await page.locator(".mobile-list .mobile-row").count()).toBeLessThanOrEqual(25);

  await page.goto("/dns");
  await expect(page).toHaveURL(/\/m\/dns/);
  await expect(page.getByRole("heading", { name: "DNS Query Log" })).toBeVisible();
  await expect(page.locator(".dns-insights")).toHaveCount(0);
  expect(await page.locator(".mobile-list .mobile-row").count()).toBeLessThanOrEqual(25);

  await page.goto("/clients");
  await expect(page).toHaveURL(/\/m\/clients/);
  await expect(page.getByRole("heading", { name: "Clients" })).toBeVisible();
  await expect(page.locator(".clients-layout > .side-panel")).toHaveCount(0);
  await expect(page.locator(".mobile-list .mobile-row").first()).toBeVisible();

  await page.goto("/live");
  await expect(page).toHaveURL(/\/m\/live/);
  await expect(page.getByRole("heading", { name: "Live event stream" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Client activity summary" })).toBeVisible();
  await expect(page.locator(".service-events-card")).toHaveCount(0);
  await expect(page.locator(".live-secondary-grid")).toHaveCount(0);

  await page.goto("/health");
  await expect(page).toHaveURL(/\/m\/health/);
  await expect(page.getByRole("heading", { level: 1, name: "Health Center" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Health Center" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Alarm Center" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Deploy Gate" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Leak-check evidence" })).toBeVisible();
  await expect(page.locator(".mobile-status-card").first()).toBeVisible();
  await expect(page.locator(".health-layout > .side-panel")).toHaveCount(0);

  await page.goto("/catalog");
  await expect(page).toHaveURL(/\/m\/catalog/);
  await expect(page.getByRole("heading", { name: "Catalog" })).toBeVisible();
  await expect(page.locator(".side-panel")).toHaveCount(0);
  await expect(page.getByText("Desktop version").first()).toBeVisible();
});

test("mobile redirect preserves bypass and safe routes", async ({ page, request, isMobile }) => {
  test.skip(!isMobile, "mobile-only redirect smoke");

  await page.goto("/traffic");
  await expect(page).toHaveURL(/\/m\/traffic/);

  const forwardedRedirect = await request.get("/traffic", {
    headers: {
      host: "127.0.0.1:3000",
      "sec-ch-ua-mobile": "?1",
      "user-agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      "x-forwarded-host": "console.example.invalid:2087",
      "x-forwarded-port": "2087",
      "x-forwarded-proto": "https",
    },
    maxRedirects: 0,
  });
  expect(forwardedRedirect.status()).toBe(307);
  expect(forwardedRedirect.headers().location).toBe("https://console.example.invalid:2087/m/traffic");

  await page.goto("/traffic?desktop=1");
  await expect(page).toHaveURL(/\/traffic\?desktop=1/);
  await expect(page.locator(".mobile-shell")).toHaveCount(0);

  const flowDetail = await request.get(`/traffic/${encodeURIComponent("test-seed:flow:0001")}`, {
    headers: {
      "sec-ch-ua-mobile": "?1",
      "user-agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    },
  });
  expect(flowDetail.url()).toContain("/traffic/test-seed%3Aflow%3A0001");

  await page.goto("/api/health");
  await expect(page).toHaveURL(/\/api\/health/);
  await expect(page.locator("body")).toContainText("ok");

  await page.goto("/m/live");
  await expect(page).toHaveURL(/\/m\/live/);

  await page.goto("/health");
  await expect(page).toHaveURL(/\/m\/health/);
});

test("api smoke endpoints respond", async ({ request }) => {
  for (const path of ["/api/dashboard", "/api/flows", "/api/dns", "/api/alarms", "/api/clients", "/api/health", "/api/catalog", "/api/live", "/api/budget", "/api/settings", "/api/reports/llm-safe?format=json", "/api/notifications", "/api/notifications/settings", "/api/audit"]) {
    const response = await request.get(path);
    expect(response.ok(), path).toBeTruthy();
    const body = await response.json();
    expect(body).toBeTruthy();
  }
});

test("alarm state actions are exposed when alarms exist", async ({ request }) => {
  const response = await request.get("/api/alarms?pageSize=1");
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  if (!body.alarms?.length) return;
  const id = encodeURIComponent(body.alarms[0].id);
  for (const path of [`/api/alarms/${id}/ack`, `/api/alarms/${id}/snooze`, `/api/alarms/${id}/open`]) {
    const action = await request.post(path, { data: { minutes: 60 } });
    expect(action.ok(), path).toBeTruthy();
    const actionBody = await action.json();
    expect(actionBody).toHaveProperty("ok");
  }
});

test("controlled actions require confirmation and write auditable responses", async ({ request }) => {
  const review = await request.post("/api/actions/catalog/review", {
    data: { domain: "example.invalid", decision: "approve", reason: "playwright smoke" },
  });
  expect(review.ok()).toBeTruthy();
  const dryRun = await request.post("/api/actions/catalog/dry-run");
  expect(dryRun.ok()).toBeTruthy();
  const apply = await request.post("/api/actions/catalog/apply", { data: { confirmation: "wrong" } });
  expect(apply.ok()).toBeTruthy();
  const applyBody = await apply.json();
  expect(applyBody.status).toBe("confirmation_required");
  const settings = await request.post("/api/notifications/settings", { data: { stale_minutes: 30 } });
  expect(settings.ok()).toBeTruthy();
});
