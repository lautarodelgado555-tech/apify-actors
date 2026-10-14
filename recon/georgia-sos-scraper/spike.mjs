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

const DET = '/BusinessSearch/BusinessInformation/';
const rowRe = /navigateToBusinessInfo\((\d+), '([^']+)'\)">[^<]*<\/a><\/td><td >([^<]*)</g;
const rowsOf = (html) => [...html.matchAll(rowRe)].map((m) => ({ id: m[1], type: m[2], control: m[3] }));
const contains = await search('s02-delta-contains', 'BusinessName', 'Delta', 'Contains');
const gp = await search('s08-georgia-power', 'BusinessName', 'Georgia Power');
const llc = await search('s09-llc', 'BusinessName', 'Peach Holdings LLC');
const nonp = await search('s10-nonprofit', 'BusinessName', 'Georgia Chamber', 'StartsWith');
const all = [...rowsOf(contains), ...rowsOf(gp), ...rowsOf(llc), ...rowsOf(nonp)];
const byType = new Map();
for (const r of all) if (!byType.has(r.type)) byType.set(r.type, r);
log('types', JSON.stringify([...byType.values()]));

// detail per entity type: search by control number first so the id belongs to the last search
let i = 0;
for (const r of byType.values()) {
  await search(`c${++i}-ctl-${r.control}`, 'ControlNo', r.control);
  await run(`d${i}-detail-${r.id}`, DET, { businessId: r.id, businessType: r.type, fromSearch: 'true' });
}

// does detail need the id to be in the last search?
await search('t0-ctl-delta', 'ControlNo', 'H853425');
await run('t1-detail-in-last-search', DET, { businessId: '567669', businessType: 'Foreign Profit Corporation', fromSearch: 'true' });
await search('t2-last-is-llc', 'BusinessName', 'Peach Holdings LLC');
await run('t3-detail-not-in-last-search', DET, { businessId: '567669', businessType: 'Foreign Profit Corporation', fromSearch: 'true' });
await run('t4-detail-empty-fromSearch', DET, { businessId: '567669', fromSearch: '' });
await run('t5-detail-id-only', DET, { businessId: '567669' });
await run('t6-detail-nofs-with-type', DET, { businessId: '567669', businessType: 'Foreign Profit Corporation' });

// filings paging
await run('g1-filings-page1', '/BusinessSearch/BusinessFilings/', { businessId: '567669' });
await run('g2-filing-pidx2', '/BusinessSearch/BusinessFiling', { businessid: '567669', sortby: '', stype: 'a', pidx: '2' }, { 'x-requested-with': 'XMLHttpRequest' });
await run('g3-filing-pidx2-slash', '/BusinessSearch/BusinessFiling/', { businessid: '567669', sortby: '', stype: 'a', pidx: '2' }, { 'x-requested-with': 'XMLHttpRequest' });
await run('g4-filing-pidx2-nobiz', '/BusinessSearch/BusinessFiling', { businessid: '', sortby: '', stype: 'a', pidx: '2' }, { 'x-requested-with': 'XMLHttpRequest' });

// stress: details for every row of page 1 of a 25-row result list
const first = await search('u0-contains-again', 'BusinessName', 'Delta', 'Contains');
const t0 = Date.now();
const stat = {};
let n = 0;
for (const r of rowsOf(first)) {
  const x = await post(DET, { businessId: r.id, businessType: r.type, fromSearch: 'true' });
  stat[x.status] = (stat[x.status] || 0) + 1;
  if (n++ < 6) save(`u1-sample-detail-${n}.html`, x.text);
}
log('STRESS details on current page', JSON.stringify(stat), (Date.now() - t0) + 'ms');

await browser.close();
