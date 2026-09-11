/** Fixed, reproducible pilot assignments. Verification files are outside the allowed change set. */
export const scenarioIds = ['pagination', 'dedupe', 'catalog', 'endpoint', 'dependency-format', 'dependency-sort', 'revision-csv', 'revision-config', 'ui-filter', 'ui-form'];
const prelude = `import assert from 'node:assert/strict';\n`;
const success = `\nconsole.log('PASS: every specified behavior and edge case was checked');\n`;
export function scenario(id, playwright) {
  const cases = {
    pagination: {
      category: 'backend bug', paths: ['paginate.js'],
      goal: 'Fix paginate(items, offset, limit): offset defaults to 0 and limit defaults to 10, zero limit returns [], clamp negative offset to zero, return a slice without mutating items.',
      files: { 'paginate.js': 'export const paginate = (items, offset, limit) => items.splice(offset || 0, limit || 10);\n' },
      check: `import {paginate} from './paginate.js'; const a=[1,2,3,4]; assert.deepEqual(paginate(a,1,2),[2,3]); assert.deepEqual(a,[1,2,3,4]); assert.deepEqual(paginate(a,0,0),[]); assert.deepEqual(paginate(a,-2,2),[1,2]); assert.deepEqual(paginate(a),a); assert.deepEqual(paginate(a,9,2),[]);`,
    },
    dedupe: {
      category: 'backend bug', paths: ['dedupe.js'],
      goal: 'Fix dedupe(rows): keep the first row for each exact id, preserve first-occurrence order, distinguish numeric and string ids, return a new array and never mutate input.',
      files: { 'dedupe.js': 'export const dedupe = rows => Object.values(Object.fromEntries(rows.map(r => [r.id,r])));\n' },
      check: `import {dedupe} from './dedupe.js'; const rows=[{id:2,v:'a'},{id:1,v:'b'},{id:2,v:'c'},{id:'2',v:'d'}]; const before=JSON.stringify(rows); assert.deepEqual(dedupe(rows),[rows[0],rows[1],rows[3]]); assert.equal(JSON.stringify(rows),before); assert.notEqual(dedupe(rows),rows); assert.deepEqual(dedupe([]),[]);`,
    },
    catalog: {
      category: 'multiple files', paths: ['slug.js', 'catalog.js'],
      goal: 'Add slug.js exporting slug(text), trimming/lowercasing ASCII text and collapsing runs of non-alphanumeric characters to one hyphen, with no edge hyphens. Add catalog.js exporting catalog(titles), returning {title,slug} records and rejecting duplicate resulting slugs with an Error.',
      files: {},
      check: `import {slug} from './slug.js'; import {catalog} from './catalog.js'; assert.equal(slug('  Red & Blue!! '),'red-blue'); assert.equal(slug('---'),''); assert.deepEqual(catalog(['Red Book','Blue']),[{title:'Red Book',slug:'red-book'},{title:'Blue',slug:'blue'}]); assert.throws(()=>catalog(['Red Book','RED BOOK'])); assert.deepEqual(catalog([]),[]);`,
    },
    endpoint: {
      category: 'multiple files', paths: ['validate.js', 'endpoint.js'],
      goal: 'Add validate.js exporting validName(value), true only for nonempty trimmed strings of at most 20 characters. Add endpoint.js exporting createItem(body), returning {status:400,body:{error:"invalid name"}} for an absent or invalid name, otherwise {status:201,body:{name:trimmedName}}. Accept a missing or null body without throwing.',
      files: {},
      check: `import {validName} from './validate.js'; import {createItem} from './endpoint.js'; assert.equal(validName(' a '),true); for(const x of ['', ' ', 2, null, 'a'.repeat(21)]) assert.equal(validName(x),false); for(const x of [undefined,null,{}, {name:3}]) assert.deepEqual(createItem(x),{status:400,body:{error:'invalid name'}}); assert.deepEqual(createItem({name:'  hello '}),{status:201,body:{name:'hello'}});`,
    },
    'dependency-format': {
      category: 'dependency setup', paths: ['receipt.js'], dependency: true,
      goal: 'Fix receipt(cents) in receipt.js to use the installed pilot-kit formatCents helper and return "Total: $12.34" for 1234, "Total: $0.00" for 0, and "Total: -$0.25" for -25. Dependency setup is already approved; do not change package or vendor files.',
      files: { 'receipt.js': "export const receipt = cents => 'Total: $' + cents;\n" },
      check: `import {receipt} from './receipt.js'; assert.equal(receipt(1234),'Total: $12.34'); assert.equal(receipt(0),'Total: $0.00'); assert.equal(receipt(-25),'Total: -$0.25');`,
    },
    'dependency-sort': {
      category: 'dependency setup', paths: ['sort.js'], dependency: true,
      goal: 'Fix sortNames(names) in sort.js to use the installed pilot-kit naturalCompare helper, sorting names with numeric ordering into a new array without mutating input. Dependency setup is already approved; do not change package or vendor files.',
      files: { 'sort.js': 'export const sortNames = names => names.sort();\n' },
      check: `import {sortNames} from './sort.js'; const a=['file10','file2','file1']; assert.deepEqual(sortNames(a),['file1','file2','file10']); assert.deepEqual(a,['file10','file2','file1']); assert.deepEqual(sortNames([]),[]);`,
    },
    'revision-csv': {
      category: 'revision of existing behavior', paths: ['csv.js'],
      goal: 'Revise csv(rows) to support comma, quote, and newline characters in fields. Quote such fields and double embedded quotes. Join records with CRLF and append a final CRLF for nonempty input. Preserve the csv export; empty rows input returns an empty string.',
      files: { 'csv.js': "export const csv = rows => rows.map(r=>r.join(',')).join('\\n');\n" },
      check: `import {csv} from './csv.js'; assert.equal(csv([]),''); assert.equal(csv([['a','b']]),'a,b\\r\\n'); assert.equal(csv([['a,b','say "hi"','x\\ny']]),'"a,b","say ""hi""","x\\ny"\\r\\n'); assert.equal(csv([[0,'']]),'0,\\r\\n');`,
    },
    'revision-config': {
      category: 'revision of existing behavior', paths: ['config.js'],
      goal: 'Revise mergeConfig(base, overrides): shallow copy base, apply defined overrides including 0 and false, delete keys whose override is null, ignore undefined overrides, and never mutate either argument. Retain the mergeConfig export.',
      files: { 'config.js': 'export const mergeConfig = (base, overrides) => Object.assign(base,overrides);\n' },
      check: `import {mergeConfig} from './config.js'; const a={port:80,debug:true,host:'x',keep:1}; const b={port:0,debug:false,host:null,keep:undefined}; assert.deepEqual(mergeConfig(a,b),{port:0,debug:false,keep:1}); assert.deepEqual(a,{port:80,debug:true,host:'x',keep:1}); assert.equal(b.host,null); assert.deepEqual(mergeConfig({},{}),{});`,
    },
    'ui-filter': {
      category: 'UI flow', paths: ['index.html'], ui: true,
      goal: 'Implement an accessible responsive catalog filter in index.html. Show a heading Catalog, an input named Filter, and a list with Apples, Bananas, Cherries. Filter case-insensitively as the user types, show "No matches" for an empty result, and restore all items when cleared. Fit a 390px mobile viewport without horizontal overflow. Use the provided check to capture desktop and mobile PNG evidence; run it before writing proof and cite output/playwright/desktop.png and mobile.png.',
      files: { 'index.html': '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Catalog</title><h1>Catalog</h1><p>Filter not implemented.</p>\n' },
      interaction: `const filter=page.getByRole('textbox',{name:'Filter',exact:true}); await filter.fill('AN'); await expectText(['Bananas']); await filter.fill('zzz'); await page.getByText('No matches',{exact:true}).waitFor(); await filter.fill(''); await expectText(['Apples','Bananas','Cherries']);`,
    },
    'ui-form': {
      category: 'UI flow', paths: ['index.html'], ui: true,
      goal: 'Implement a responsive accessible task form in index.html. Heading Tasks, input named New task, button Add task, and a list of added tasks. Trim submitted text, reject blank submissions with "Enter a task", clear input after success, and give each added task a checkbox labelled by its text. Fit a 390px mobile viewport without overflow. Use the provided check to capture desktop and mobile PNG evidence; run it before writing proof and cite output/playwright/desktop.png and mobile.png.',
      files: { 'index.html': '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tasks</title><h1>Tasks</h1><p>Task form not implemented.</p>\n' },
      interaction: `const input=page.getByRole('textbox',{name:'New task',exact:true}); const add=page.getByRole('button',{name:'Add task',exact:true}); await input.fill('   '); await add.click(); await page.getByText('Enter a task',{exact:true}).waitFor(); await input.fill('  Buy milk  '); await add.click(); assert.equal(await input.inputValue(),''); const done=page.getByRole('checkbox',{name:'Buy milk',exact:true}); await done.check(); assert.equal(await done.isChecked(),true); await done.uncheck(); assert.equal(await done.isChecked(),false);`,
    },
  };
  const spec=cases[id]; if(!spec) throw new Error('unknown scenario '+id);
  spec.id=id;
  spec.files={ 'package.json': JSON.stringify({name:'standing-orders-pilot',private:true,type:'module',scripts:{test:'node verify.mjs'},...(spec.dependency?{dependencies:{'pilot-kit':'file:vendor/pilot-kit'}}:{})},null,2)+'\n', '.gitignore':'node_modules/\noutput/\n', 'README.md':'# Disposable unattended pilot\n\nRun npm test. Only the requested implementation files may change.\n', ...spec.files };
  if(spec.dependency) {
    spec.files['vendor/pilot-kit/package.json']=JSON.stringify({name:'pilot-kit',version:'1.0.0',type:'module',exports:'./index.js'})+'\n';
    spec.files['vendor/pilot-kit/index.js']=`export const formatCents = n => (n < 0 ? '-$' : '$') + (Math.abs(n)/100).toFixed(2);\nexport const naturalCompare = (a,b) => a.localeCompare(b, 'en', {numeric:true});\n`;
  }
  if(spec.ui) {
    if(!playwright) throw new Error('UI pilot needs --playwright pointing to an installed playwright/index.mjs');
    spec.check=`import {chromium} from ${JSON.stringify(playwright)}; import {mkdir,readFile} from 'node:fs/promises'; import {createServer} from 'node:http';
const server=createServer(async (_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await readFile('index.html'));}); await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true}); try { const page=await browser.newPage(); const expectText=async expected=>assert.deepEqual((await page.getByRole('listitem').allTextContents()).map(x=>x.trim()),expected); await mkdir('output/playwright',{recursive:true});
for(const [name,width,height] of [['desktop',1280,800],['mobile',390,844]]) { await page.setViewportSize({width,height}); await page.goto('http://127.0.0.1:'+server.address().port); ${spec.interaction} assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true); await page.screenshot({path:'output/playwright/'+name+'.png',fullPage:true}); console.log('PASS '+name+' interaction and '+width+'x'+height+' viewport; screenshot output/playwright/'+name+'.png'); }
} finally {await browser.close(); await new Promise(r=>server.close(r));}`;
  }
  spec.files['verify.mjs']=prelude+spec.check+success;
  return spec;
}
