import {test,expect} from '@playwright/test';

test('dashboard total, chart and complete paginated client list reconcile',async({page,isMobile})=>{
 const response=await page.request.get('/api/dashboard?period=today&trafficClass=all&fresh=1');
 expect(response.ok()).toBeTruthy();
 const dashboard=await response.json();
 let sum=0,pageNumber=1,totalPages=1;
 do {
   const result=await page.request.get(`/api/clients?period=today&trafficClass=all&pageSize=100&page=${pageNumber}&fresh=1`);
   expect(result.ok()).toBeTruthy();
   const payload=await result.json();totalPages=payload.totalPages;
   sum+=payload.clients.reduce((n:number,row:any)=>n+Number(row.total_bytes ?? row.bytes ?? 0),0);
   pageNumber++;
 }while(pageNumber<=totalPages);
 expect(dashboard.totals.observedBytes).toBe(sum);
 expect(dashboard.dashboard_analytics.trafficToday.totalBytes).toBe(sum);
 expect(dashboard.dashboard_analytics.trafficReconciliation.clientEvidenceBytes).toBe(sum);
 expect(dashboard.dashboard_analytics.channelTraffic.reduce((n:number,row:any)=>n+row.bytes,0)).toBe(sum);
 await page.goto(isMobile?'/?desktop=1':'/');
 const chart=page.locator('svg[aria-label="Traffic today chart"]');
 await expect(chart).toBeVisible();
 const line=(await chart.locator('.line-total').getAttribute('d'))!;
 const area=(await chart.locator('.area-total').getAttribute('d'))!;
 const lastLineX=Number([...line.matchAll(/[ML] ([\d.]+) [\d.-]+/g)].at(-1)![1]);
 const baselineX=Number(area.slice(line.length).match(/L ([\d.]+)/)![1]);
 expect(baselineX).toBe(lastLineX);
 await page.screenshot({path:test.info().outputPath('dashboard-client-volume.png'),fullPage:true});
});
