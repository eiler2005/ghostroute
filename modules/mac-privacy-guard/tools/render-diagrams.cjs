// Export and check the public documentation figures; no operator browser state.
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'../../..');
const {chromium}=require(process.env.GUARD_PLAYWRIGHT || path.join(root,'modules/ghostroute-console/app/node_modules/playwright'));
const assets=path.join(root,'docs/assets/diagrams');
const assert=(ok,message)=>{if(!ok)throw Error(message);};
let browser;
(async()=>{
  browser=await chromium.launch({channel:process.env.GUARD_DIAGRAM_BROWSER || 'chrome',headless:true});
  const context=await browser.newContext({viewport:{width:1400,height:1000},deviceScaleFactor:2});
  const report={};
  for(const lang of ['ru','en']){
    const page=await context.newPage();
    const source=path.join(assets,`ghostroute-guard-${lang}.html`);
    await page.goto(pathToFileURL(source).href);await page.evaluate(()=>document.fonts.ready);
    const geometry=await page.evaluate(()=>{
      const errors=[],figures=[];
      for(const svg of document.querySelectorAll('svg')){
        const nodes=[...svg.querySelectorAll('[data-node]')].map(g=>({key:g.dataset.node,group:g,rect:g.querySelector('rect').getBBox()}));
        const edges=[...svg.querySelectorAll('path[data-from]')];
        const overlap=(a,b)=>a.x<b.x+b.width && a.x+a.width>b.x && a.y<b.y+b.height && a.y+a.height>b.y;
        const title=svg.querySelector('title'),desc=svg.querySelector('desc');
        if(svg.firstElementChild!==title || !title?.textContent || !desc?.textContent || svg.getAttribute('aria-labelledby')!==`${title.id} ${desc.id}`)errors.push(`${svg.id}: inaccessible figure`);
        for(const node of nodes)for(const text of node.group.querySelectorAll('text')){
          const b=text.getBBox(),r=node.rect;
          if(b.x<r.x+7 || b.x+b.width>r.x+r.width-7 || b.y<r.y+5 || b.y+b.height>r.y+r.height-5)errors.push(`${svg.id}/${node.key}: text overflow: ${text.textContent}`);
        }
        for(const edge of edges){
          for(let d=0;d<=edge.getTotalLength();d+=2){
            const p=edge.getPointAtLength(d);
            for(const node of nodes){
              if([edge.dataset.from,edge.dataset.to].includes(node.key))continue;
              const r=node.rect;
              if(p.x>r.x+1 && p.x<r.x+r.width-1 && p.y>r.y+1 && p.y<r.y+r.height-1)errors.push(`${svg.id}: connector crosses ${node.key}`);
            }
          }
        }
        for(const mask of svg.querySelectorAll('.edge-label rect')){
          if(nodes.some(n=>overlap(mask.getBBox(),n.rect)))errors.push(`${svg.id}: label mask overlaps a node`);
        }
        for(const text of svg.querySelectorAll('text')){
          const b=text.getBBox();if(b.x<0 || b.y<0 || b.x+b.width>1280 || b.y+b.height>720)errors.push(`${svg.id}: canvas overflow: ${text.textContent}`);
        }
        if(nodes.length>9 || edges.length>12 || svg.querySelectorAll('.node.focal').length>2)errors.push(`${svg.id}: complexity budget`);
        figures.push({id:svg.id,nodes:nodes.length,edges:edges.length});
      }
      return {errors:[...new Set(errors)],figures,font:getComputedStyle(document.querySelector('svg text')).fontFamily};
    });
    assert(!geometry.errors.length,geometry.errors.join('\n'));
    const exportPage=await context.newPage();
    const style=await page.locator('style').textContent();
    for(const figure of geometry.figures){
      const markup=await page.locator('#'+figure.id).evaluate(el=>el.outerHTML);
      await exportPage.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${style}html,body{width:1280px;height:720px;overflow:hidden}svg{width:1280px;height:720px}</style></head><body>${markup}</body></html>`);
      await exportPage.evaluate(()=>document.fonts.ready);
      await exportPage.screenshot({path:path.join(assets,figure.id+'.png'),clip:{x:0,y:0,width:1280,height:720},omitBackground:true});
    }
    await exportPage.close();
    await page.setViewportSize({width:390,height:844});
    const mobile=await page.evaluate(()=>({noPageOverflow:document.documentElement.scrollWidth<=innerWidth,localScrollers:[...document.querySelectorAll('.diagram-container')].every(el=>el.scrollWidth>el.clientWidth && getComputedStyle(el).overflowX==='auto')}));
    assert(mobile.noPageOverflow && mobile.localScrollers,'Mobile overflow');
    await page.emulateMedia({media:'print'});
    assert(await page.locator('svg').first().evaluate(el=>getComputedStyle(el).minWidth==='0px'),'Print clipping');
    report[lang]={geometry,mobile,printFits:true};await page.close();
  }
  const out=path.join(root,'reports/diagram-checks');fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,'mac-guard.json'),JSON.stringify(report,null,2));
  await browser.close();
  console.log('PASS: six Mac Guard figures exported; accessible names, labels, connector clearance, budgets, mobile scrolling and print checked');
})().catch(async error=>{if(browser)await browser.close();console.error(error.message);process.exitCode=1;});
