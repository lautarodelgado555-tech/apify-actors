// Recon for the Washington CCFS search (runs on a GitHub runner only).
// VARIANT env: probe | chromium | firefox | chromium-headed | firefox-headed.
//  probe: plain-HTTP calls to ccfs-api.prod.sos.wa.gov with and without a Turnstile header.
//  others: drive the real search form and log the API calls, the Turnstile outcome and the responses.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const VARIANT = process.env.VARIANT || 'probe';
const out = path.join(path.dirname(new URL(import.meta.url).pathname), 'out', VARIANT);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const log = [];
const L = (...a) => { const s = a.join(' '); console.log(s); log.push(s); };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const API = 'https://ccfs-api.prod.sos.wa.gov/api/';

async function probe(name, url, init = {}, headers = {}) {
  try {
    const r = await fetch(url, { ...init, headers: { 'user-agent': UA, accept: 'application/json, text/plain, */*', origin: 'https://ccfs.sos.wa.gov', referer: 'https://ccfs.sos.wa.gov/', ...headers } });
    const t = await r.text();
    L('probe', name, r.status, t.length, t.slice(0, 300).replace(/\s+/g, ' '));
    fs.writeFileSync(path.join(out, `probe-${name}.json`), t.slice(0, 500000));
  } catch (e) { L('probe', name, 'ERR', e.message, String(e.cause && (e.cause.code || e.cause.message))); }
}

if (VARIANT === 'probe') {
  const criteria = { Type: 'BusinessName', SearchType: 'BusinessName', SearchEntityName: 'Microsoft', SortType: 'ASC', SortBy: 'Entity Name', SearchValue: 'Microsoft', SearchCriteria: 'StartsWith', IsSearch: true, PageID: 1, PageCount: 25 };
  for (const [label, hdr] of [['nohdr', {}], ['empty', { 'X-reCAPTCHA': '' }], ['local', { 'X-reCAPTCHA': 'local' }], ['junk', { 'X-reCAPTCHA': 'abc' }]]) {
    await probe(`list-json-${label}`, `${API}BusinessSearch/GetBusinessSearchList`, { method: 'POST', body: JSON.stringify(criteria) }, { 'content-type': 'application/json', ...hdr });
    await probe(`list-form-${label}`, `${API}BusinessSearch/GetBusinessSearchList`, { method: 'POST', body: JSON.stringify(criteria) }, { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8', ...hdr });
    await probe(`detail-${label}`, `${API}BusinessSearch/BusinessInformation?businessID=1348199`, {}, hdr);
  }
  await probe('options', `${API}BusinessSearch/GetBusinessSearchList`, { method: 'OPTIONS' }, { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-recaptcha' });
  fs.writeFileSync(path.join(out, 'run.log'), log.join('\n'));
  process.exit(0);
}

const kind = VARIANT.startsWith('firefox') ? 'firefox' : 'chromium';
const headed = VARIANT.endsWith('headed');
const launchOpts = { headless: !headed };
const GL = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'];
if (VARIANT.startsWith('chrome')) { launchOpts.channel = 'chrome'; launchOpts.ignoreDefaultArgs = ['--enable-automation']; }
if (VARIANT.includes('gl')) launchOpts.args = GL;
if (VARIANT.endsWith('resi') || VARIANT.endsWith('dc')) {
  const group = VARIANT.endsWith('resi') ? 'groups-RESIDENTIAL,country-US' : 'auto';
  launchOpts.proxy = { server: 'http://proxy.apify.com:8000', username: group, password: process.env.APIFY_PROXY_PASSWORD };
}
if (kind === 'chromium') launchOpts.args = [...(launchOpts.args || []), '--disable-blink-features=AutomationControlled'];
const browser = await require('playwright')[kind].launch(launchOpts);
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, ...(kind === 'chromium' ? { userAgent: UA } : {}) });
const page = await ctx.newPage();
const calls = [];
page.on('console', (m) => { const t = m.text(); if (/turnstile|cloudflare|error|fail/i.test(t)) L('console', t.slice(0, 300)); });
page.on('request', (rq) => {
  const u = rq.url();
  if (!/ccfs-api\.prod\.sos\.wa\.gov|cdn-cgi|challenges\.cloudflare/.test(u)) return;
  const h = { ...rq.headers() }; delete h.cookie;
  calls.push({ url: u, method: rq.method(), headers: h, postData: rq.postData() });
});
page.on('response', async (rs) => {
  const rq = rs.request();
  const c = calls.find((x) => x.url === rq.url() && x.method === rq.method() && x.status === undefined);
  if (!c) return;
  c.status = rs.status();
  try { c.body = (await rs.text()).slice(0, 300000); } catch (e) { c.body = `ERR ${e.message}`; }
});
const step = async (n) => {
  await page.screenshot({ path: path.join(out, `shot-${n}.png`), fullPage: true }).catch(() => {});
  fs.writeFileSync(path.join(out, `page-${n}.html`), (await page.content()).slice(0, 400000));
  L('step', n, page.url());
};
try {
  await page.goto('https://ccfs.sos.wa.gov/#/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#BusinessName', { timeout: 30000 });
  await page.waitForTimeout(4000);
  await step('1-home');
  const input = page.locator('#BusinessName');
  await input.click();
  await input.pressSequentially('Microsoft', { delay: 70 });
  await page.waitForTimeout(500);
  await page.locator('button.btn-search').first().click();
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(2500);
    if (calls.some((c) => /GetBusinessSearchList/.test(c.url) && c.status)) break;
  }
  await page.waitForTimeout(2000);
  await step('2-results');
  const rows = await page.locator('table tbody tr').count();
  L('result rows', rows);
  if (rows) {
    await page.locator('table tbody tr a').first().click().catch((e) => L('row err', e.message));
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(2500);
      if (calls.some((c) => /BusinessInformation/.test(c.url) && c.status)) break;
    }
    await step('3-detail');
  }
} catch (e) { L('browser error', e.message); }
fs.writeFileSync(path.join(out, 'network.json'), JSON.stringify(calls, null, 1));
L('calls', calls.length, calls.map((c) => `${c.method} ${c.url.slice(0, 120)} ${c.status}`).join(' | '));
await browser.close();
fs.writeFileSync(path.join(out, 'run.log'), log.join('\n'));
