import { expect, test } from "@playwright/test";

const pages = ["/", "/traffic", "/clients", "/health", "/catalog", "/budget", "/live", "/reports", "/settings"];

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
  await expect(page.locator("input[name='search']")).toBeVisible();
});

test("route explanation exposes gated evidence", async ({ page }) => {
  await page.goto("/traffic");
  await expect(page.getByText("Почему маршрут именно такой?")).toBeVisible();
  await expect(page.getByText("Что видит сайт")).toBeVisible();
  await expect(page.getByText("Хронология событий")).toBeVisible();
  await page.locator(".evidence-details summary").first().click({ force: true });
  await expect(page.locator(".codebox").first()).toBeVisible();
});

test("mobile keeps controls and content reachable", async ({ page, isMobile }) => {
  test.skip(!isMobile, "mobile-only overflow smoke");
  await page.goto("/clients");
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.locator("input[name='search']")).toBeVisible();
  await expect(page.getByText("Устройства")).toBeVisible();
});

test("api smoke endpoints respond", async ({ request }) => {
  for (const path of ["/api/dashboard", "/api/flows", "/api/clients", "/api/health", "/api/catalog", "/api/live", "/api/budget", "/api/reports/llm-safe?format=json"]) {
    const response = await request.get(path);
    expect(response.ok(), path).toBeTruthy();
    const body = await response.json();
    expect(body).toBeTruthy();
  }
});
