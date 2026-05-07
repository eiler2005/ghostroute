import { expect, test } from "@playwright/test";

const pages = ["/", "/traffic", "/dns", "/clients", "/health", "/catalog", "/budget", "/live", "/reports", "/settings"];

for (const path of pages) {
  test(`renders ${path}`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByText("GhostRoute Console").first()).toBeVisible();
    await expect(page.locator("body")).not.toHaveText("");
  });
}

test("filters are visible and stable", async ({ page }) => {
  await page.goto("/traffic");
  await expect(page.locator("select[name='period']")).toBeVisible();
  await expect(page.locator("select[name='route']")).toBeVisible();
  await expect(page.locator("select[name='confidence']")).toBeVisible();
  await expect(page.locator("select[name='trafficClass']")).toBeVisible();
  await expect(page.locator("input[name='search']")).toBeVisible();
});

test("route explanation exposes gated evidence", async ({ page }) => {
  await page.goto("/traffic?flow=0");
  if (await page.getByText("Нет traffic rows").isVisible().catch(() => false)) {
    await expect(page.getByText("Нет traffic rows")).toBeVisible();
    return;
  }
  await expect(page.getByText("Почему маршрут именно такой?")).toBeVisible();
  await expect(page.getByText("Что видит сайт")).toBeVisible();
  await expect(page.getByText("Что видит оператор")).toBeVisible();
  await expect(page.getByText("Канал входа")).toBeVisible();
  await expect(page.getByText("Хронология событий")).toBeVisible();
  await page.locator(".evidence-details summary").first().click({ force: true });
  await expect(page.locator(".codebox").first()).toBeVisible();
});

test("traffic explorer hides technical evidence noise by default", async ({ page }) => {
  await page.goto("/traffic");
  if (await page.getByText("Нет traffic rows").isVisible().catch(() => false)) {
    await expect(page.getByText("Нет traffic rows")).toBeVisible();
    return;
  }
  await expect(page.getByText("Flow Explorer")).toBeVisible();
  await expect(page.getByText("Showing traffic rows only")).toBeVisible();
  await expect(page.getByText("system/no-byte evidence hidden")).toBeVisible();
  const firstRow = page.locator(".route-table-card tbody tr").first();
  if (await firstRow.count()) {
    await expect(firstRow).toBeVisible();
    await expect(firstRow).not.toContainText("Unknown");
    await expect(firstRow).not.toContainText("0 B");
  } else {
    await expect(page.getByText("Нет traffic rows")).toBeVisible();
  }
  await page.goto("/traffic?diagnostics=1");
  if (await page.getByText("Нет traffic rows").isVisible().catch(() => false)) {
    await expect(page.getByText("Нет traffic rows")).toBeVisible();
  } else {
    await expect(page.getByText("Diagnostics visible")).toBeVisible();
  }
});

test("traffic classes and live cadence are explicit", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Service/background traffic" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Needs attribution" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Client traffic snapshot rows" })).toBeVisible();
  const clientRowsY = await page.getByRole("heading", { name: "Client traffic snapshot rows" }).boundingBox();
  const serviceY = await page.getByRole("heading", { name: "Service/background traffic" }).boundingBox();
  expect(clientRowsY?.y || 0).toBeLessThan(serviceY?.y || Number.POSITIVE_INFINITY);
  await page.goto("/traffic?trafficClass=unclassified");
  if (await page.getByText("Нет traffic rows").isVisible().catch(() => false)) {
    await expect(page.getByText("Нет traffic rows")).toBeVisible();
  } else {
    await expect(page.getByText("Needs attribution flows by volume")).toBeVisible();
  }
  await page.goto("/live");
  await expect(page.getByText("Автообновление около 10 минут")).toBeVisible();
  await expect(page.getByText("Service/background live events")).toBeVisible();
});

test("live filters keep event pagination scoped", async ({ page }) => {
  await page.goto("/live?client=__no_such_client__");
  await expect(page.getByRole("heading", { name: "Live event stream" })).toBeVisible();
  await expect(page.locator(".live-primary .pagination")).toContainText("Showing 0-0 of 0");
  await expect(page.locator(".service-events-card .pagination")).toContainText("Showing 0-0 of 0");
  await page.waitForTimeout(1200);
  await expect(page.locator(".live-primary .pagination")).toContainText("Showing 0-0 of 0");
});

test("dense console tables keep pagination controls visible", async ({ page }) => {
  await page.setViewportSize({ width: 2048, height: 760 });
  for (const path of ["/live", "/dns"]) {
    await page.goto(path);
    await expect(page.locator(".pagination").first()).toBeVisible();
  }

  await page.goto("/traffic");
  if (!(await page.getByText("Нет traffic rows").isVisible().catch(() => false))) {
    await expect(page.locator(".traffic-stream-card .pagination")).toBeVisible();
  }
});

test("clients separate inventory from selected-window traffic", async ({ page }) => {
  await page.goto("/clients");
  await expect(page.getByText("traffic for selected window")).toBeVisible();
  await expect(page.getByText("Window traffic").first()).toBeVisible();
  await expect(page.getByText("Traffic observed")).toBeVisible();
});

test("mobile keeps controls and content reachable", async ({ page, isMobile }) => {
  test.skip(!isMobile, "mobile-only overflow smoke");
  await page.goto("/clients");
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.locator("input[name='search']")).toBeVisible();
  await expect(page.getByText("Device Inventory")).toBeVisible();
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
