import { test, expect } from '@playwright/test';

for (const period of ['today', 'week', 'month']) {
  for (const trafficClass of ['all', 'client']) {
    test(`Budget shares ${period}/${trafficClass} accounting with Dashboard and Clients`, async ({ request, page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop', 'shared server accounting contract');
      const query = `period=${period}&trafficClass=${trafficClass}`;
      const budget = await (await request.get(`/api/budget?${query}`)).json();
      const dashboard = await (await request.get(`/api/dashboard?${query}`)).json();
      const clients = await (await request.get(`/api/clients?${query}&pageSize=50`)).json();
      expect(budget.usage.observed_bytes).toBe(dashboard.totals.observedBytes);
      expect(budget.usage.vps_bytes).toBe(dashboard.totals.viaVpsBytes);
      expect(budget.usage.direct_bytes).toBe(dashboard.totals.directBytes);
      const report = await (await request.get(`/api/reports/llm-safe?${query}`)).json();
      expect(report.summary.totals.observedBytes).toBe(dashboard.totals.observedBytes);
      expect(report.flows.length).toBeLessThanOrEqual(40);
      expect(report.clients.length).toBeLessThanOrEqual(30);
      const amounts = (rows: any[]) => rows.map(row => [row.client_key || row.id || row.device_key, row.total_bytes, row.via_vps_bytes, row.direct_bytes]);
      expect(amounts(budget.clients)).toEqual(amounts(clients.clients));
      await page.goto(`/budget?${query}`);
      await expect(page.getByRole('heading', { name: 'Device usage' })).toBeVisible();
    });
  }
}
