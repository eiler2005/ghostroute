import { expect, test } from "@playwright/test";

const pages = ["/", "/traffic", "/dns", "/intelligence", "/clients", "/health", "/catalog", "/budget", "/live", "/reports", "/settings"];
const mobileRedirects: Record<string, string> = {
  "/": "/m",
  "/traffic": "/m/traffic",
  "/dns": "/m/dns",
  "/clients": "/m/clients",
  "/health": "/m/health",
  "/live": "/m/live",
  "/catalog": "/m/catalog",
  "/settings": "/m/settings",
};

function parseByteText(value: string) {
  const match = value.replace(/,/g, "").match(/([0-9]+(?:\.[0-9]+)?)\s*(B|KB|MB|GB|TB)/i);
  if (!match) return 0;
  const units: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return Number(match[1]) * (units[match[2].toUpperCase()] || 1);
}

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

test("today-only pages ignore stale month period filters", async ({ page, isMobile }) => {
  const cases = isMobile
    ? [
        { path: "/m/traffic?period=month", heading: "Flow Explorer", rows: ".mobile-list .mobile-row" },
        { path: "/m/dns?period=month", heading: "DNS Query Log", rows: ".mobile-list .mobile-row" },
        { path: "/m/live?period=month", heading: "Live event stream", rows: ".mobile-list .mobile-row" },
      ]
    : [
        { path: "/traffic?period=month", heading: "Flow Explorer", rows: ".flow-events-table tbody tr" },
        { path: "/dns?period=month", heading: "DNS Query Log", rows: ".dns-events-table tbody tr" },
        { path: "/live?period=month", heading: "Live event stream", rows: ".client-activity-table tbody tr" },
      ];

  for (const item of cases) {
    await page.goto(item.path);
    await expect(page.getByRole("heading", { name: item.heading }).first()).toBeVisible();
    await expect(page.locator(item.rows).first()).toBeVisible();
    await expect(page.locator("a[href*='period=month']")).toHaveCount(0);
    if (!isMobile) await expect(page.locator("select[name='period']")).toHaveValue("today");
  }
});

test("dashboard shows traffic analytics in English", async ({ page, isMobile }) => {
  await page.goto(isMobile ? "/?desktop=1" : "/");
  await expect(page.getByRole("heading", { name: "Traffic today" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Top clients" }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Top destinations" }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "VPS traffic this month" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "LTE reserve (mobile internet)" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Traffic usage" })).toHaveCount(0);
  await expect(page.locator(".chart-legend .legend-vps").first()).toContainText("Via VPS");
  await expect(page.locator("body")).not.toContainText("Трафик");
});

test("dashboard rankings hide pseudo clients and keep destinations populated", async ({ page, isMobile }) => {
  await page.goto(isMobile ? "/?desktop=1" : "/");
  await expect(page.getByRole("heading", { name: "Top destinations" })).toHaveCount(1);
  const topClients = page.locator(".dashboard-rank-card").filter({ has: page.getByRole("heading", { name: "Top clients" }) });
  const topDestinations = page.locator(".dashboard-rank-card").filter({ has: page.getByRole("heading", { name: "Top destinations" }) });
  await expect(topClients.locator(".dashboard-rank-row").first()).toBeVisible();
  const clientLabels = await topClients.locator(".rank-title strong").allTextContents();
  const clientTotals = await topClients.locator(".rank-meter > strong").allTextContents();
  expect(clientLabels.map((value) => value.trim())).not.toContain("A/Home Reality");
  expect(clientLabels.map((value) => value.trim())).not.toContain("B/XHTTP relay");
  expect(clientLabels.map((value) => value.trim().toLowerCase())).not.toContain("dns-interest");
  expect(clientTotals.map((value) => value.trim())).not.toContain("0 B");
  await expect(topDestinations.locator(".dashboard-rank-row").first()).toBeVisible();
  await expect(topDestinations).not.toContainText(/No destination traffic observed|No concrete/i);
  await expect(topDestinations).not.toContainText(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
  await expect(topDestinations).not.toContainText("Home Reality ingress");
});

test("apps selected device keeps byte traffic separate from DNS evidence", async ({ page, isMobile }) => {
  await page.goto(isMobile ? "/apps?client=test-iphone-heavy&desktop=1" : "/apps?client=test-iphone-heavy");
  const selectedApps = page.locator("section").filter({ has: page.getByRole("heading", { name: "App families for Test/iPhone Heavy" }) });
  await expect(selectedApps).toBeVisible();
  await expect(selectedApps).toContainText(/\bGB\b/);
  await expect(selectedApps).not.toContainText("86.3 KB");
  const latestDns = page.locator("section").filter({ has: page.getByRole("heading", { name: "Latest DNS domains for Test/iPhone Heavy" }) });
  await expect(latestDns).toBeVisible();
  await expect(latestDns.getByText("gs-loc.apple.com")).toBeVisible();
});

test("mobile apps uses the same selected-client attribution as desktop", async ({ page, isMobile }) => {
  test.skip(!isMobile, "mobile-only compact Apps surface");
  await page.goto("/m/apps?client=test-iphone-heavy");
  const selectedApps = page.locator("section").filter({ has: page.getByRole("heading", { name: "App families" }) });
  await expect(selectedApps).toBeVisible();
  await expect(selectedApps).toContainText(/GB/);
  await expect(selectedApps).not.toContainText("No app-family rows");
  const latestDns = page.locator("section").filter({ has: page.getByRole("heading", { name: "Latest DNS domains" }) });
  await expect(latestDns).toContainText("gs-loc.apple.com");
});

test("apps selected-device byte totals stay aligned for all visible app devices", async ({ page, isMobile }) => {
  await page.goto(isMobile ? "/apps?desktop=1" : "/apps");
  const deviceRows = page.locator("section").first().locator("tbody tr");
  const count = Math.min(await deviceRows.count(), 8);
  expect(count).toBeGreaterThan(0);

  for (let index = 0; index < count; index += 1) {
    const row = deviceRows.nth(index);
    const href = await row.locator("a[href^='/apps?']").first().getAttribute("href");
    const deviceBytes = parseByteText(await row.locator("td").nth(2).innerText());
    if (!href || deviceBytes < 1024 * 1024) continue;
    await page.goto(isMobile ? `${href}&desktop=1` : href);
    const summary = await page.locator("section").nth(1).locator(".toolbar .subtle").last().innerText();
    const appBytes = parseByteText(summary);
    expect(appBytes, `${href} app bytes should cover selected device bytes`).toBeGreaterThanOrEqual(deviceBytes * 0.95);
    expect(appBytes, `${href} app bytes should not exceed selected device bytes`).toBeLessThanOrEqual(deviceBytes * 1.08);
  }
});

test("client popular sites expose ranked inferred domains instead of IP-only residual", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop-only selected client site panel");
  await page.goto(isMobile ? "/clients?client=test-iphone-heavy&desktop=1" : "/clients?client=test-iphone-heavy");
  const popular = page.locator("section").filter({ has: page.getByRole("heading", { name: "Most popular sites for Test/iPhone Heavy" }) });
  await expect(popular).toBeVisible();
  const rows = popular.locator(".popular-site-row");
  await expect(rows.nth(9)).toBeVisible();
  await expect(popular).not.toContainText("IP-only destination");
  await expect(popular).not.toContainText("Unattributed traffic not mapped to sites");
  const labels = await rows.locator("strong").evaluateAll((nodes) => nodes.map((node) => node.textContent || ""));
  const domainLabels = labels.filter((value) => /\b[a-z0-9-]+\.[a-z]{2,}\b/i.test(value));
  expect(domainLabels.length).toBeGreaterThanOrEqual(10);
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
  await expect(page.locator(".flow-detail-panel")).toContainText("Destination evidence");
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
  await expect(page.locator(".flow-events-table th.col-destination")).toHaveText("Site / group");
  await expect(page.locator(".flow-events-table thead")).not.toContainText("Port");
  await expect(page.locator(".flow-events-table tbody tr .col-destination .evidence-kind").first()).toBeVisible();
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

test("traffic class controls include personal cloud on desktop and mobile", async ({ page, isMobile }) => {
  await page.goto(isMobile ? "/m/traffic" : "/traffic");
  await expect(page.getByRole("heading", { name: "Flow Explorer" }).first()).toBeVisible();
  await expect(page.locator("select[name='trafficClass']")).toBeVisible();
  await expect(page.locator("select[name='trafficClass']")).toContainText("Personal cloud");
});

test("traffic intelligence is read-only and honors traffic class filters", async ({ page, isMobile }) => {
  await page.goto(isMobile ? "/intelligence?desktop=1&trafficClass=service_background" : "/intelligence?trafficClass=service_background");
  await expect(page.getByRole("heading", { name: "Traffic Intelligence" })).toBeVisible();
  await expect(page.locator("select[name='trafficClass']")).toHaveValue("service_background");
  await expect(page.getByText("Dry-run only")).toBeVisible();
  await expect(page.getByText("Destination intelligence")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Runtime deploy");
});

test("settings exposes sanitized routing policy on desktop and mobile", async ({ page, request, isMobile }) => {
  await page.goto(isMobile ? "/m/settings" : "/settings");
  await expect(page.getByRole("heading", { name: "Routing policy" }).first()).toBeVisible();
  await expect(page.getByText("Test/Home Laptop").first()).toBeVisible();
  await expect(page.getByText("Test/Channel A Full").first()).toBeVisible();
  await expect(page.getByText("Test/Channel B").first()).toBeVisible();
  await expect(page.getByText("Test/Channel C").first()).toBeVisible();
  await expect(page.getByText("ip-0f0a4411").first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText("192.0.2.44");
  await expect(page.locator("body")).not.toContainText("02:00:5e:10:00:44");
  if (isMobile) {
    await expect(page.locator(".mobile-nav a[href='/m/settings']")).toHaveCount(1);
  }

  const response = await request.get("/api/settings");
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.routing_policy.summary.home_full_vps).toBe(2);
  expect(body.routing_policy.summary.channel_a_full_vps).toBe(1);
  expect(body.routing_policy.summary.channel_b_profiles).toBe(1);
  expect(body.routing_policy.summary.channel_c_profiles).toBe(1);
  const serialized = JSON.stringify(body.routing_policy);
  expect(serialized).toContain("ip-0f0a4411");
  expect(serialized).not.toContain("192.0.2.44");
  expect(serialized).not.toContain("02:00:5e:10:00:44");
});

test("traffic pages expose channel context without hiding mobile rows", async ({ page, isMobile }) => {
  await page.goto(isMobile ? "/m/traffic" : "/traffic");
  await expect(page.getByRole("heading", { name: "Flow Explorer" }).first()).toBeVisible();
  if (isMobile) {
    await expect(page.locator(".mobile-list .mobile-row").first()).toBeVisible();
    await expect(page.locator(".flow-detail-panel")).toHaveCount(0);
  } else {
    await expect(page.locator(".flow-events-table thead")).toContainText("Channel");
    await expect(page.locator(".flow-events-table tbody tr").first()).toBeVisible();
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
  test.slow();
  await page.goto("/clients");
  const secondRow = page.locator(".clients-card tbody tr").nth(1);
  if ((await secondRow.count()) === 0) return;
  const deviceName = (await secondRow.locator("td").first().innerText()).trim();
  const secondHref = await secondRow.locator("a").first().getAttribute("href");
  const selectedClient = secondHref ? new URL(secondHref, "http://localhost").searchParams.get("client") : "";
  await secondRow.locator("td").nth(1).click();
  await expect(page).toHaveURL(/client=/);
  if (selectedClient) expect(new URL(page.url()).searchParams.get("client")).toBe(selectedClient);
  await expect(page.locator(".clients-card tbody tr.selected")).toHaveCount(1);
  await expect(page.locator(".side-panel")).toContainText(deviceName);
});

test("clients expose lane drilldown and route evidence", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop-only client lane panel");
  await page.goto("/clients");
  await expect(page.getByRole("heading", { name: "Traffic lanes" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Destinations by lane" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Route evidence" })).toBeVisible();
  await expect(page.locator(".side-panel")).toContainText("Counter allocated");
  await page.getByRole("link", { name: /Service\/system/ }).first().click();
  await expect(page).toHaveURL(/lane=service_system/);
});

test("traffic and live primary destinations hide raw IP labels", async ({ page, isMobile }) => {
  await page.goto(isMobile ? "/traffic?desktop=1" : "/traffic");
  if (!(await page.getByText("No traffic rows").isVisible().catch(() => false))) {
    await expect(page.locator(".flow-events-table tbody tr .col-destination").first()).toBeVisible();
    const labels = await page.locator(".flow-events-table tbody tr .col-destination .destination-cell > span:first-child").allTextContents();
    expect(labels.join("\n")).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
  }
  await page.goto(isMobile ? "/live?desktop=1" : "/live");
  const liveLabels = await page.locator(".client-activity-table tbody tr .live-col-destination").allTextContents();
  expect(liveLabels.join("\n")).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
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
  await expect(page.locator(".cards .card").first()).toBeVisible();
  await expect(page.locator(".health-layout > .side-panel")).toHaveCount(0);
  await expect(page.locator("script[src*='/_next/']")).toHaveCount(0);

  await page.goto("/catalog");
  await expect(page).toHaveURL(/\/m\/catalog/);
  await expect(page.getByRole("heading", { name: "Catalog" })).toBeVisible();
  await expect(page.locator(".side-panel")).toHaveCount(0);
  await expect(page.getByText("Desktop version").first()).toBeVisible();
});

test("mobile health is raw HTML without Next hydration scripts", async ({ request }) => {
  const response = await request.get("/m/health");
  expect(response.ok()).toBeTruthy();
  const body = await response.text();
  expect(response.headers()["content-type"]).toContain("text/html");
  expect(body).toContain("Health Center");
  expect(body).toContain("Alarm Center");
  expect(body).not.toContain("/_next/static/chunks");
  expect(body).not.toContain("self.__next_f");
});

test("mobile redirect preserves bypass and safe routes", async ({ page, request, isMobile }) => {
  test.skip(!isMobile, "mobile-only redirect smoke");
  test.slow();

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
