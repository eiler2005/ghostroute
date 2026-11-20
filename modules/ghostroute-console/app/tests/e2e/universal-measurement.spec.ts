import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import path from 'node:path';

const fixtureId = 'universal-connection-fixture';
const target = 'connection-fixture.example.invalid';
const database = path.resolve('../data/gui-test/ghostroute.db');

test.beforeAll(() => {
  const db = new Database(database);
  try {
    const source = db.prepare('select * from flow_sessions limit 1').get() as Record<string, any>;
    const at = new Date().toISOString();
    const row: Record<string, any> = {...source, id:fixtureId, first_seen:at,last_seen:at,collected_at:at,event_ts_utc:at,display_ts_utc:at,
      destination:target,destination_ip:'',dns_qname:'',sni:'',bytes:0,connections:1,
      via_vps_bytes:0,direct_bytes:0,unknown_bytes:0,route:'VPS',confidence:'observed',
      evidence_json:JSON.stringify({measurement_kind:'connection_event',destination_kind:'connection_event',byte_confidence:'not_measured',evidence_level:'proxy_connection_event',destination:target})};
    const keys = Object.keys(row);
    db.prepare(`insert or replace into flow_sessions(${keys.join(',')}) values (${keys.map(()=>'?').join(',')})`).run(...keys.map(key=>row[key]));
  } finally {db.close();}
});

test.afterAll(() => {
  const db = new Database(database);
  try {db.prepare('delete from flow_sessions where id=?').run(fixtureId);} finally {db.close();}
});

test('connection evidence shows an unmeasured amount on each browser surface', async ({page}, info) => {
  const mobile = info.project.name !== 'desktop';
  await page.goto(`${mobile ? '/m/traffic' : '/traffic'}?search=${target}${mobile ? '' : '&desktop=1'}`);
  const row = mobile ? page.locator('.mobile-row').filter({hasText:target}) : page.locator('tr').filter({hasText:target});
  await expect(row).toContainText('not measured');
  await expect(row).not.toContainText('0 B');
  if (!mobile) await expect(row).toContainText('Proxy target');
  await page.screenshot({path:info.outputPath('connection-evidence.png'),fullPage:true});
});
