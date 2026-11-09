// Uses an already installed Playwright. No npm/runtime changes to Console.
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtempSync, readFileSync, rmSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const {chromium} = require(process.env.GUARD_PLAYWRIGHT || path.join(repo, 'modules/ghostroute-console/app/node_modules/playwright'));
const root = mkdtempSync(path.join(tmpdir(), 'guard-browser-test-'));
const report = process.env.GUARD_REPORT_DIR;
if (report) mkdirSync(report, {recursive: true});
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=fixture.example.org', '-addext', 'subjectAltName=DNS:fixture.example.org', '-keyout', path.join(root, 'key.pem'), '-out', path.join(root, 'cert.pem')], {stdio:'ignore'});
const fixture = spawn('python3', ['-B', path.join(path.dirname(fileURLToPath(import.meta.url)), 'browser_fixture.py'), root], {stdio:['ignore','pipe','inherit']});
let browser, dashboardBrowser;
try {
  const settings = await new Promise((resolve, reject) => {
    let buffer = '';
    fixture.stdout.on('data', data => {buffer += data; if (buffer.includes('\n')) resolve(JSON.parse(buffer.split('\n')[0]));});
    fixture.once('exit', () => reject(new Error('Fixture exited before startup')));
  });
  const control = async action => (await fetch(`http://127.0.0.1:${settings.control}/${action}`)).json();
  const chrome = process.env.GUARD_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launchPersistentContext(path.join(root,'browser'), {
    executablePath: chrome, headless:true, chromiumSandbox:true,
    args:[...settings.arguments, '--ignore-certificate-errors', `--log-net-log=${path.join(root,'netlog.json')}`]
  });
  const page = await browser.newPage();
  const mustFail = async url => {
    let failed = false;
    try { await page.goto(url, {timeout:5000, waitUntil:'domcontentloaded'}); } catch (_) {failed = true;}
    assert(failed, 'Expected a closed network path');
  };
  await mustFail('https://fixture.example.org/locked');
  assert.equal((await control('status')).origin, 0);
  await control('activate');
  await page.goto('https://fixture.example.org/', {timeout:10000});
  assert.equal(await page.locator('h1').textContent(), 'Protected fixture');
  const candidates = await page.evaluate(async ({udp, tcp}) => {
    const pc = new RTCPeerConnection({iceServers:[{urls:`stun:127.0.0.1:${udp}`}, {urls:`turn:127.0.0.1:${tcp}?transport=tcp`, username:'fixture', credential:'fixture'}]});
    const values = [];
    pc.onicecandidate = event => {if(event.candidate) values.push(event.candidate.candidate);};
    pc.createDataChannel('fixture');
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise(resolve => setTimeout(resolve, 2500));
    pc.close();
    return values;
  }, {udp:settings.udp, tcp:settings.tripwire});
  assert.equal((await control('status')).udp, 0, 'WebRTC sent non-proxied UDP');
  assert.equal(candidates.length, 0, 'WebRTC exposed an ICE candidate outside the HTTP proxy');
  await mustFail('https://blocked.example.org/');
  await mustFail(`http://127.0.0.1:${settings.tripwire}/implicit-bypass`);
  await mustFail(`http://[::1]:${settings.tripwire6}/ipv6-bypass`);
  assert.equal((await control('status')).direct, 0);
  await control('upstream-down');
  await mustFail('https://fixture.example.org/upstream-down');
  await control('gate-down');
  await mustFail('https://fixture.example.org/gate-down');
  assert.equal((await control('status')).direct, 0);
  await browser.close(); browser = null;
  const netlog = JSON.parse(readFileSync(path.join(root,'netlog.json')));
  const names = Object.fromEntries(Object.entries(netlog.constants.logEventTypes).map(([name,id]) => [id,name]));
  const dns = netlog.events.filter(event => /DNS_TRANSACTION|DNS_TASK/.test(names[event.type] || ''));
  assert.equal(dns.length, 0, 'Protected browser performed a DNS transaction');
  dashboardBrowser = await chromium.launch({executablePath:chrome, headless:true, chromiumSandbox:true});
  const dashboard = await dashboardBrowser.newPage();
  await dashboard.goto(settings.dashboard);
  await dashboard.getByText('Чувствительные сайты.', {exact:false}).first().waitFor();
  assert.equal(await dashboard.locator('#state').textContent(), 'ЗАКРЫТО');
  assert.equal(await dashboard.locator('#browse').isDisabled(), true);
  assert.equal(await dashboard.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(16, 26, 37)');
  if (report) await dashboard.screenshot({path:path.join(report,'desktop.png'), fullPage:true});
  await dashboard.setViewportSize({width:390,height:844});
  assert(await dashboard.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  if (report) await dashboard.screenshot({path:path.join(report,'mobile.png'), fullPage:true});
  console.log('PASS: real Chrome proxy-only HTTPS; lock/upstream/gate failure; IPv4/IPv6 bypass; WebRTC; no DNS transactions; dashboard desktop/mobile.');
} finally {
  if (browser) await browser.close();
  if (dashboardBrowser) await dashboardBrowser.close();
  fixture.kill('SIGTERM');
  rmSync(root, {recursive:true, force:true});
}
