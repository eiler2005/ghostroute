const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const root = path.resolve(__dirname, '../../..');
const {chromium} = require(path.join(root, 'modules/ghostroute-console/app/node_modules/@playwright/test'));
const assets = path.join(root, 'docs/assets/diagrams');
const kinds = ['routing', 'lifecycle', 'recovery'];
let browser;

function assert(ok, message) { if (!ok) throw Error(message); }

(async () => {
  browser = await chromium.launch({channel: 'chrome', headless: true});
  const context = await browser.newContext({viewport: {width: 1400, height: 1000}, deviceScaleFactor: 2});
  const results = {};
  for (const language of ['ru', 'en']) {
  const source = path.join(assets, 'ghostroute-platform-'+language+'.html');
  const names = kinds.map(kind => `ghostroute-${kind}-${language}`);
  const page = await context.newPage();
  await page.goto(pathToFileURL(source).href);
  await page.evaluate(() => document.fonts.ready);
  const geometry = await page.evaluate(() => {
    const errors = [];
    const figures = [];
    const overlaps = (a, b, margin = 0) => a.x < b.x+b.width-margin && a.x+a.width > b.x+margin && a.y < b.y+b.height-margin && a.y+a.height > b.y+margin;
    for (const svg of document.querySelectorAll('svg')) {
      const nodes = [...svg.querySelectorAll('[data-node]')].map(g => ({key: g.dataset.node, group: g, rect: g.querySelector('rect').getBBox()}));
      const edges = [...svg.querySelectorAll('path[data-from]')];
      for (const node of nodes) {
        for (const label of node.group.querySelectorAll('text')) {
          const b = label.getBBox(), r = node.rect;
          if (b.x < r.x+7 || b.x+b.width > r.x+r.width-7 || b.y < r.y+5 || b.y+b.height > r.y+r.height-5) errors.push(`${svg.id}/${node.key}: text overflow: ${label.textContent}`);
        }
      }
      for (const edge of edges) {
        const length = edge.getTotalLength();
        for (let distance = 0; distance <= length; distance += 2) {
          const p = edge.getPointAtLength(distance);
          for (const node of nodes) {
            if ([edge.dataset.from, edge.dataset.to].includes(node.key)) continue;
            const r = node.rect;
            if (p.x > r.x+1 && p.x < r.x+r.width-1 && p.y > r.y+1 && p.y < r.y+r.height-1) errors.push(`${svg.id}: edge crosses ${node.key}`);
          }
        }
      }
      for (const label of svg.querySelectorAll('.edge-label rect')) {
        for (const node of nodes) if (overlaps(label.getBBox(), node.rect, .1)) errors.push(`${svg.id}: edge-label mask overlaps ${node.key}`);
        for (const heading of svg.querySelectorAll('.zone-name')) if (overlaps(label.getBBox(), heading.getBBox())) errors.push(`${svg.id}: edge-label mask covers zone heading`);
      }
      for (const label of svg.querySelectorAll('text')) {
        const r = label.getBBox();
        if (r.x < 0 || r.x+r.width > 1280 || r.y < 0 || r.y+r.height > 720) errors.push(`${svg.id}: canvas overflow: ${label.textContent}`);
      }
      const legend = [...svg.querySelectorAll('text.legend')].map(el => el.getBBox());
      for (let i = 0; i < legend.length; i++) for (let j = i+1; j < legend.length; j++) if (overlaps(legend[i], legend[j])) errors.push(`${svg.id}: legend captions overlap`);
      const assertBudget = nodes.length <= 9 && edges.length <= 12 && svg.querySelectorAll('.node.focal').length <= 2;
      if (!assertBudget) errors.push(`${svg.id}: complexity budget exceeded`);
      figures.push({id: svg.id, nodes: nodes.length, edges: edges.length});
    }
    return {errors: [...new Set(errors)], figures, fonts: getComputedStyle(document.querySelector('svg text')).fontFamily};
  });
  assert(geometry.errors.length === 0, geometry.errors.join('\n'));
  const exportPage = await context.newPage();
  const style = await page.locator('style').textContent();
  for (const name of names) {
    const svg = page.locator('#'+name);
    const markup = await svg.evaluate(el => el.outerHTML);
    await exportPage.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${style}html,body{width:1280px;height:720px;overflow:hidden}svg{width:1280px;height:720px}</style></head><body>${markup}</body></html>`);
    await exportPage.evaluate(() => document.fonts.ready);
    await exportPage.screenshot({path: path.join(assets,name+'.png'), clip: {x: 0, y: 0, width: 1280, height: 720}, omitBackground: true});
  }
  await exportPage.close();
  const phone = await context.newPage({viewport: {width: 390, height: 844}});
  await phone.setViewportSize({width: 390, height: 844});
  await phone.goto(pathToFileURL(source).href);
  const mobile = await phone.evaluate(() => ({
    noPageOverflow: document.documentElement.scrollWidth <= innerWidth,
    localScrollers: [...document.querySelectorAll('.diagram-container')].every(el => el.scrollWidth > el.clientWidth && getComputedStyle(el).overflowX === 'auto'),
    readableCanvas: [...document.querySelectorAll('svg')].every(el => parseFloat(getComputedStyle(el).minWidth) === 1280)
  }));
  assert(mobile.noPageOverflow && mobile.localScrollers && mobile.readableCanvas, 'Mobile canvas scrolling failed');
  await phone.emulateMedia({media: 'print'});
  assert(await phone.locator('svg').first().evaluate(el => getComputedStyle(el).minWidth === '0px'), 'Print canvas remains clipped');
  results[language] = {geometry, mobile, printFits: true, outputs: names};
  await phone.close();
  await page.close();
  }
  const reportDir = path.join(root, 'reports/diagram-checks');
  fs.mkdirSync(reportDir, {recursive: true});
  fs.writeFileSync(path.join(reportDir, 'platform.json'), JSON.stringify(results, null, 2));
  await browser.close();
  console.log('PASS: six platform RU/EN diagrams rendered; labels, paths, legends, budgets, mobile scrolling and print layout checked');
})().catch(async error => { if (browser) await browser.close(); console.error(error.message); process.exitCode = 1; });
