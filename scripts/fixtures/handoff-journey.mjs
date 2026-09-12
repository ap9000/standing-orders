/** Fixed contract for exercising intent, approval, revision and inherited evidence. */
export function handoffFixture(playwright) {
  const goal = 'Build a responsive fruit catalog in index.html using normalizeQuery(value) exported by filter.js. normalizeQuery must trim and lowercase strings and return an empty string for null or undefined. The page has heading Catalog, textbox named Filter and a list containing Apples, Bananas and Cherries. Filter case-insensitively as typed, show No matches for an empty result and restore the list when cleared. Fit desktop and 390px mobile widths. Run npm test before submitting proof and cite output/playwright/desktop.png and output/playwright/mobile.png. Keep this exact filed goal, exclusions and rubric when planning; implementation detail belongs in the plan.';
  const exclusions = 'Do not change package.json, verify.mjs or README.md. No external resources, dependencies, network services, publication or unrelated features.';
  const acceptance = [
    {id:'normalization',statement:'normalizeQuery trims and lowercases strings and treats null or undefined as empty.',evidence:['check'],how:'npm test checks filter.js independently of the page.'},
    {id:'filter',statement:'The accessible catalog filters case-insensitively, shows No matches and restores all three items when cleared.',evidence:['check','screenshot'],how:'npm test exercises the real page at both widths.'},
    {id:'responsive',statement:'The tested page fits 1280px desktop and 390px mobile without horizontal overflow, with screenshots at both widths.',evidence:['check','screenshot'],how:'Cite output/playwright/desktop.png and output/playwright/mobile.png.'},
  ];
  const verify = `import assert from 'node:assert/strict';
import {normalizeQuery} from './filter.js';
import {chromium} from ${JSON.stringify(playwright)};
import {readFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
assert.equal(normalizeQuery('  BANana '),'banana'); assert.equal(normalizeQuery(null),''); assert.equal(normalizeQuery(undefined),''); assert.equal(normalizeQuery(''),'');
const server=createServer(async(req,res)=>{ const name=req.url==='/filter.js'?'filter.js':'index.html'; res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':'text/html');res.end(await readFile(name)); });
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage(); await mkdir('output/playwright',{recursive:true});
 for(const [name,width,height] of [['desktop',1280,800],['mobile',390,844]]) {
  await page.setViewportSize({width,height}); await page.goto('http://127.0.0.1:'+server.address().port);
  await page.getByRole('heading',{name:/^(Fruit catalog|Catalog)$/}).waitFor();
  const input=page.getByRole('textbox',{name:'Filter',exact:true});
  const items=async()=> (await page.getByRole('listitem').allTextContents()).map(s=>s.trim());
  await input.fill('  AN  '); assert.deepEqual(await items(),['Bananas']);
  await input.fill('zzz'); await page.getByText('No matches',{exact:true}).waitFor();
  await input.fill(''); assert.deepEqual(await items(),['Apples','Bananas','Cherries']);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:'output/playwright/'+name+'.png',fullPage:true});
  console.log('PASS '+name+' behavior and viewport; screenshot output/playwright/'+name+'.png');
 }
} finally { await browser.close(); await new Promise(r=>server.close(r)); }
console.log('PASS normalization, filtering, accessibility and responsive screenshots');
`;
  return {goal,exclusions,acceptance,touches:['filter.js','index.html'],files:{
    'package.json':JSON.stringify({name:'standing-orders-handoff-fixture',private:true,type:'module',scripts:{test:'node verify.mjs'}},null,2)+'\n',
    '.gitignore':'output/\nnode_modules/\n',
    'README.md':'# Handoff journey fixture\n\nImplement only the filed contract. Run npm test. Only filter.js and index.html may change.\n',
    'index.html':'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Catalog</title><h1>Catalog</h1><p>Implementation pending.</p>\n',
    'verify.mjs':verify,
  }};
}
