// Georgia eCorp spike 2: one Firefox page that passes the Cloudflare JS check on GET, then every search/detail is an in-page fetch() POST.
import fs from 'node:fs';
import pw from 'playwright';

const OUT = 'recon/georgia-sos-scraper/out';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
const save = (name, text) => fs.writeFileSync(`${OUT}/${name}`, String(text).slice(0, 4_000_000));
const HOME = 'https://ecorp.sos.ga.gov/BusinessSearch';

async function openHome(kind) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const browser = await pw[kind].launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    try {
      await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
      for (let i = 0; i < 12; i++) {
        if (!/just a moment/i.test(await page.title())) return { browser, ctx, page, attempt };
        await page.waitForTimeout(2500);
      }
      log('attempt', attempt, 'stuck on challenge');
    } catch (e) { log('attempt', attempt, 'error', e.message.split('\n')[0]); }
    await browser.close();
  }
  return null;
}

const s = await openHome('firefox');
if (!s) { log('NO-GO: could not pass home'); process.exit(0); }
const { browser, page } = s;
log('home passed on attempt', s.attempt);
await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
log('cookies', JSON.stringify((await s.ctx.cookies()).map((c) => c.name)));

const post = (path, params, extraHeaders = {}) =>
  page.evaluate(async ({ path, params, extraHeaders }) => {
    const t0 = Date.now();
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...extraHeaders }, body: new URLSearchParams(params).toString(), credentials: 'include' });
    const text = await r.text();
    return { status: r.status, mitigated: r.headers.get('cf-mitigated'), ct: r.headers.get('content-type'), ms: Date.now() - t0, text };
  }, { path, params, extraHeaders });

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

// warm-up: probe with a trivial POST until Cloudflare lets it through (log timing)
for (let k = 1; k <= 6; k++) {
  const r = await post('/BusinessSearch', { 'search.SearchType': 'BusinessName', 'search.SearchValue': 'Delta Air Lines', 'search.SearchCriteria': 'StartsWith' });
  log('probe', k, r.status, r.mitigated, r.text.length, 'cookies', JSON.stringify((await s.ctx.cookies()).map((c) => c.name)));
  if (r.status === 200) break;
  await page.waitForTimeout(k * 3000);
}

// the JS bundle (XHtmlGrid pager, navigateToBusinessInfo ...)
try {
  const src = await page.$eval('script[src*="/Scripts/Script"]', (e) => e.getAttribute('src'));
  const b = await get(src);
  save('bundle.js', b.text);
  log('bundle', b.status, b.text.length);
} catch (e) { log('bundle ERR', e.message); }

await search('s01-delta-starts', 'BusinessName', 'Delta Air Lines');
const contains = await search('s02-delta-contains', 'BusinessName', 'Delta', 'Contains');
await search('s03-coca-cola', 'BusinessName', 'Coca-Cola');
await search('s04-control', 'ControlNo', 'H853425');
await search('s05-agent', 'AgentName', 'Corporation Service Company', 'StartsWith');
await search('s06-officer', 'PrincipalName', 'Bastian', 'Contains');
await search('s07-none', 'BusinessName', 'zzzqqxx nonexistent');
const gp = await search('s08-georgia-power', 'BusinessName', 'Georgia Power');
const llc = await search('s09-llc', 'BusinessName', 'Peach Holdings LLC');

// paging guesses (page 2 of the Delta contains search)
const pageParams = { 'search.SearchType': 'BusinessName', 'search.SearchValue': 'Delta', 'search.SearchCriteria': 'Contains' };
await run('p1-pageIdx', '/BusinessSearch', { ...pageParams, pageIdx: '2', sortBy: '', sortType: 'a' }, { 'x-requested-with': 'XMLHttpRequest' });
await run('p2-pageIdx-noSearch', '/BusinessSearch', { pageIdx: '2', sortBy: '', sortType: 'a' }, { 'x-requested-with': 'XMLHttpRequest' });
await run('p3-page', '/BusinessSearch', { ...pageParams, page: '2' });
await run('p4-pageNo', '/BusinessSearch', { ...pageParams, pageNo: '2', pageSize: '25' });

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
