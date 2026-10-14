// Georgia eCorp spike 2: one Firefox page that passes the Cloudflare JS check on GET, then every search/detail is an in-page fetch() POST.
import fs from 'node:fs';
import pw from 'playwright';

const OUT = `recon/georgia-sos-scraper/out/j${process.env.JOB || '0'}`;
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
const save = (name, text) => fs.writeFileSync(`${OUT}/${name}`, String(text).slice(0, 4_000_000));
const HOME = 'https://ecorp.sos.ga.gov/BusinessSearch';

let page; let ctx; let browser; let curMode = '';
async function openHome(mode) {
  curMode = mode;
  for (let attempt = 1; attempt <= 3; attempt++) {
    browser = await pw.firefox.launch({ headless: true });
    ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await ctx.newPage();
    if (mode === 'block') await page.route('**/cdn-cgi/**', (r) => r.abort());
    try {
      await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
      for (let i = 0; i < 20; i++) {
        if (!/just a moment/i.test(await page.title())) return true;
        await page.waitForTimeout(2500);
      }
      log(mode, 'attempt', attempt, 'stuck on challenge');
    } catch (e) { log(mode, 'attempt', attempt, 'error', e.message.split('\n')[0]); }
    await browser.close();
  }
  return false;
}

const post = async (path, params, extraHeaders = {}) => {
  if (curMode === 'clear') await ctx.clearCookies({ name: 'cf_clearance' });
  return page.evaluate(async ({ path, params, extraHeaders }) => {
    const t0 = Date.now();
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...extraHeaders }, body: new URLSearchParams(params).toString(), credentials: 'include' });
    const text = await r.text();
    return { status: r.status, mitigated: r.headers.get('cf-mitigated'), ct: r.headers.get('content-type'), ms: Date.now() - t0, text };
  }, { path, params, extraHeaders });
};

const get = (path) =>
  page.evaluate(async (path) => {
    const r = await fetch(path, { credentials: 'include' });
    return { status: r.status, mitigated: r.headers.get('cf-mitigated'), text: await r.text() };
  }, path);

async function run(name, path, params, headers) {
  try {
    const r = await post(path, params, headers);
    log(name, 'status', r.status, 'mit', r.mitigated, 'len', r.text.length, r.ms + 'ms', (r.text.match(/Page \d+ of \d+[^<]*/) || [''])[0]);
    save(`${name}.html`, r.text);
    return r.text;
  } catch (e) { log(name, 'ERR', e.message.split('\n')[0]); return ''; }
}
const search = (name, type, value, criteria = 'StartsWith') =>
  run(name, '/BusinessSearch', { 'search.SearchType': type, 'search.SearchValue': value, 'search.SearchCriteria': criteria });

const probeBody = { 'search.SearchType': 'BusinessName', 'search.SearchValue': 'Delta Air Lines', 'search.SearchCriteria': 'StartsWith' };
async function probe(mode) {
  const res = [];
  for (let k = 1; k <= 5; k++) {
    const r = await post('/BusinessSearch', probeBody);
    res.push(r.status);
    if (mode !== 'burst') await page.waitForTimeout(1500);
  }
  log('MODE', mode, 'statuses', res.join(','), 'cookies', JSON.stringify((await ctx.cookies()).map((c) => c.name)));
  return res.every((x) => x === 200);
}
let winner = null;
for (const mode of ['block', 'clear', 'burst', 'plain']) {
  const ok = await openHome(mode === 'plain' ? 'plain' : mode);
  if (!ok) { log('MODE', mode, 'home not passed'); continue; }
  if (await probe(mode)) { winner = mode; break; }
  await browser.close();
}
if (!winner) { log('BLOCKED: no mode got repeated POSTs through on this runner'); process.exit(0); }
log('WINNER', winner);

await search('s01-delta-starts', 'BusinessName', 'Delta Air Lines');
const contains = await search('s02-delta-contains', 'BusinessName', 'Delta', 'Contains');
await search('s03-coca-cola', 'BusinessName', 'Coca-Cola');
await search('s04-control', 'ControlNo', 'H853425');
await search('s05-agent', 'AgentName', 'Corporation Service Company', 'StartsWith');
await search('s06-officer', 'PrincipalName', 'Bastian', 'Contains');
await search('s07-none', 'BusinessName', 'zzzqqxx nonexistent');
const gp = await search('s08-georgia-power', 'BusinessName', 'Georgia Power');
const llc = await search('s09-llc', 'BusinessName', 'Peach Holdings LLC');

// paging: XHtmlGrid posts "&sortby=&stype=a&pidx=N" to /BusinessSearch (search state kept in the session)
await search('s02b-delta-contains-again', 'BusinessName', 'Delta', 'Contains');
await run('p1-pidx2', '/BusinessSearch', { sortby: '', stype: 'a', pidx: '2' }, { 'x-requested-with': 'XMLHttpRequest' });
await run('p2-pidx3', '/BusinessSearch', { sortby: '', stype: 'a', pidx: '3' }, { 'x-requested-with': 'XMLHttpRequest' });
await run('p3-sort-name', '/BusinessSearch', { sortby: 'Business Name', stype: 'a', pidx: '1' }, { 'x-requested-with': 'XMLHttpRequest' });

// details: pick businessId/type from a few result sets
const ids = [];
for (const html of [contains, gp, llc]) {
  for (const m of html.matchAll(/navigateToBusinessInfo\((\d+), '([^']+)'\)/g)) ids.push([m[1], m[2]]);
}
const wanted = [['567669', 'Foreign Profit Corporation'], ['301509', 'Domestic Nonprofit Corporation']];
const seenTypes = new Set(wanted.map((w) => w[1]));
for (const [id, type] of ids) { if (!seenTypes.has(type)) { seenTypes.add(type); wanted.push([id, type]); } }
log('detail targets', JSON.stringify(wanted));
let i = 0;
for (const [id, type] of wanted.slice(0, 7)) {
  const html = await run(`d${++i}-detail-${id}`, '/BusinessSearch/BusinessInformation', { businessId: id, businessType: type, fromSearch: 'true' });
  const hooks = [...html.matchAll(/(action=["'][^"']+["']|function\s+\w+\([^)]*\)\s*\{[^}]{0,300}|\$\.submitForm\([^)]*\)|\.load\([^)]*\)|\.post\([^)]*\)|\.ajax\(\{[^}]{0,200})/g)].map((m) => m[0]);
  save(`d${i}-hooks.txt`, hooks.join('\n---\n'));
}

await browser.close();
