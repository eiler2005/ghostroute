import { test, expect } from "@playwright/test";

test("mobile home ranks the same daily client amounts as Clients", async ({ page, request }, testInfo) => {
  const response = await request.get("/api/clients?period=today&trafficClass=all&pageSize=100");
  expect(response.ok()).toBe(true);
  const { clients } = await response.json();
  await page.goto("/m");
  const card = page.locator(".mobile-card").filter({ has: page.getByRole("heading", { name: "Top clients", exact: true }) });
  await expect(card).toContainText("Today");
  await expect(card.locator(".mobile-row")).toHaveCount(Math.min(5, clients.filter((row: any) => row.total_bytes > 0).length));
  await expect(card.locator(".mobile-row").first()).toBeVisible();
  for (const row of await card.locator(".mobile-row").all()) {
    const href = await row.getAttribute("href");
    const id = new URL(href!, "http://fixture.invalid").searchParams.get("client");
    const client = clients.find((candidate: any) => String(candidate.id) === id);
    expect(client, "mobile client must belong to the daily Clients window").toBeTruthy();
    const total = Number(client.total_bytes || 0);
    const expected = total >= 1024 ** 3 ? `${(total / 1024 ** 3).toFixed(2)} GB`
      : total >= 1024 ** 2 ? `${(total / 1024 ** 2).toFixed(1)} MB`
      : total >= 1024 ? `${(total / 1024).toFixed(1)} KB` : `${total} B`;
    await expect(row.locator("b")).toHaveText(expected);
  }
  await page.screenshot({ path: testInfo.outputPath("mobile-daily-traffic.png"), fullPage: true });
});

test("mobile app evidence declares an amount above measured device traffic", async ({ page }) => {
  await page.goto("/m/apps?client=test-office-tablet");
  await expect(page.getByRole("status").filter({ hasText: "Evidence exceeds measured window traffic" })).toBeVisible();
});

