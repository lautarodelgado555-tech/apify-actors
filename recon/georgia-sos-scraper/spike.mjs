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
const D = { businessId: '567669', businessType: 'Foreign Profit Corporation', fromSearch: 'true' };
const qs = new URLSearchParams(D).toString();
const raw = (name, fn) => page.evaluate(`(${fn})()`).then((r) => { log(name, r.status, r.mitigated, r.text.length, (r.text.match(/<title>[^<]*/) || [''])[0]); save(`${name}.html`, r.text); return r; }).catch((e) => log(name, 'ERR', e.message.split('\n')[0]));
const F = (init) => `async () => { const r = await fetch(${init}); return { status: r.status, mitigated: r.headers.get('cf-mitigated'), text: await r.text() }; }`;
const ev = (code) => `(${code})`;
const V = {
  'v01-post-plain': `async () => { const r = await fetch('/BusinessSearch/BusinessInformation', {method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'}, body:'${qs}', credentials:'include'}); return {status:r.status, mitigated:r.headers.get('cf-mitigated'), text: await r.text()}; }`,
  'v02-get-qs': `async () => { const r = await fetch('/BusinessSearch/BusinessInformation?${qs}', {credentials:'include'}); return {status:r.status, mitigated:r.headers.get('cf-mitigated'), text: await r.text()}; }`,
  'v03-post-xhr-hdr': `async () => { const r = await fetch('/BusinessSearch/BusinessInformation', {method:'POST', headers:{'content-type':'application/x-www-form-urlencoded','x-requested-with':'XMLHttpRequest'}, body:'${qs}', credentials:'include'}); return {status:r.status, mitigated:r.headers.get('cf-mitigated'), text: await r.text()}; }`,
  'v04-post-slash': `async () => { const r = await fetch('/BusinessSearch/BusinessInformation/', {method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'}, body:'${qs}', credentials:'include'}); return {status:r.status, mitigated:r.headers.get('cf-mitigated'), text: await r.text()}; }`,
  'v05-post-qs-and-body': `async () => { const r = await fetch('/BusinessSearch/BusinessInformation?${qs}', {method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'}, body:'${qs}', credentials:'include'}); return {status:r.status, mitigated:r.headers.get('cf-mitigated'), text: await r.text()}; }`,
  'v06-jquery-ajax': `() => new Promise((res) => { $.ajax({ type: 'POST', url: '/BusinessSearch/BusinessInformation', data: ${JSON.stringify(D)}, complete: (x) => res({ status: x.status, mitigated: x.getResponseHeader('cf-mitigated'), text: x.responseText || '' }) }); })`,
  'v07-post-lower': `async () => { const r = await fetch('/businesssearch/businessinformation', {method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'}, body:'${qs}', credentials:'include'}); return {status:r.status, mitigated:r.headers.get('cf-mitigated'), text: await r.text()}; }`,
  'v08-get-lower-state': `async () => { const r = await fetch('/BusinessSearch/BusinessInformation?businessId=567669&businessType=Foreign%20Profit%20Corporation', {credentials:'include'}); return {status:r.status, mitigated:r.headers.get('cf-mitigated'), text: await r.text()}; }`,
};
for (const [name, code] of Object.entries(V)) { await raw(name, code); await page.waitForTimeout(1500); }

// iframe form submit (document-like request inside the page)
try {
  const r = await page.evaluate(() => new Promise((res) => {
    const f = document.createElement('iframe'); f.name = 'ifr'; f.style.display = 'none'; document.body.appendChild(f);
    const form = document.createElement('form'); form.method = 'post'; form.action = '/BusinessSearch/BusinessInformation'; form.target = 'ifr';
    for (const [k, v] of Object.entries({ businessId: '567669', businessType: 'Foreign Profit Corporation', fromSearch: 'true' })) { const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = v; form.appendChild(i); }
    document.body.appendChild(form);
    f.onload = () => { let t = ''; try { t = f.contentDocument.documentElement.outerHTML; } catch (e) { t = 'ERR ' + e.message; } res({ status: 0, mitigated: '', text: t }); };
    form.submit();
    setTimeout(() => res({ status: -1, mitigated: '', text: 'timeout' }), 20000);
  }));
  log('v09-iframe', r.status, r.text.length, (r.text.match(/<title>[^<]*/) || [''])[0]);
  save('v09-iframe.html', r.text);
} catch (e) { log('v09 ERR', e.message.split('\n')[0]); }

// full-page navigation through the real form with the jsd script blocked (document POST)
try {
  await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<form id="zz" method="post" action="/BusinessSearch/BusinessInformation"><input name="businessId" value="567669"><input name="businessType" value="Foreign Profit Corporation"><input name="fromSearch" value="true"></form>'); });
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => log('nav err', e.message.split('\n')[0])), page.evaluate(() => document.getElementById('zz').submit())]);
  await page.waitForTimeout(3000);
  log('v10-document-post title', await page.title());
  save('v10-document.html', await page.content());
} catch (e) { log('v10 ERR', e.message.split('\n')[0]); }

await browser.close();
