// Recon for the Washington CCFS search. Runs on a GitHub runner only.
// 1) pulls the Angular bundles and extracts the API URL/payload hints, 2) drives the real search page and logs XHR calls,
// 3) probes plain-HTTP access to the detail endpoint.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const out = path.join(path.dirname(new URL(import.meta.url).pathname), 'out');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const log = [];
const L = (...a) => { const s = a.join(' '); console.log(s); log.push(s); };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// ---- 1. bundles
try {
  const res = await fetch('https://ccfs.sos.wa.gov/', { headers: { 'user-agent': UA } });
  const html = await res.text();
  L('root status', res.status, 'len', html.length);
  fs.writeFileSync(path.join(out, 'root.html'), html.slice(0, 200000));
  const srcs = [...html.matchAll(/src="([^"]+(?:\.js|js\?version=[0-9.]+))"/g)].map((m) => m[1]).filter((x) => !/cloudflare|googletag/.test(x));
  L('scripts', srcs.join(', '));
  let hints = '';
  for (const s of srcs) {
    const u = new URL(s, 'https://ccfs.sos.wa.gov/').href;
    const r = await fetch(u, { headers: { 'user-agent': UA } }).catch((e) => ({ status: String(e) }));
    if (!r.text) { L('bundle fail', u, r.status); continue; }
    const js = await r.text();
    L('bundle', u, r.status, js.length);
    if (/apiURL/.test(u)) fs.writeFileSync(path.join(out, 'apiURL.js'), js);
    if (/ccfs-js/.test(u)) fs.writeFileSync(path.join(out, 'ccfs.js'), js);
    for (const m of js.matchAll(/cfda\.sos\.wa\.gov[^"'`\s]{0,200}|api\/[A-Za-z]+\/[A-Za-z]+[^"'`\s]{0,100}/g)) hints += `${s}: ${m[0]}\n`;
    for (const m of js.matchAll(/(GetBusinessSearchList|BusinessInformation)/g)) {
      const i = m.index;
      hints += `\n--- ${s} @${i} ${m[1]}\n${js.slice(Math.max(0, i - 500), i + 900)}\n`;
      if (hints.length > 600000) break;
    }
  }
  fs.writeFileSync(path.join(out, 'bundle-hints.txt'), hints.slice(0, 900000));
} catch (e) { L('bundle step error', e.message); }

// ---- 3. plain HTTP probes
async function probe(name, url, init = {}) {
  try {
    const r = await fetch(url, { ...init, headers: { 'user-agent': UA, accept: 'application/json, text/plain, */*', origin: 'https://ccfs.sos.wa.gov', referer: 'https://ccfs.sos.wa.gov/', ...(init.headers || {}) } });
    const t = await r.text();
    L('probe', name, r.status, t.length, t.slice(0, 200).replace(/\s+/g, ' '));
    fs.writeFileSync(path.join(out, `probe-${name}.json`), t.slice(0, 500000));
  } catch (e) { L('probe', name, 'ERR', e.message, String(e.cause && (e.cause.code || e.cause.message))); }
}
await probe('detail-1348199', 'https://cfda.sos.wa.gov/api/BusinessSearch/BusinessInformation?businessID=1348199');
await probe('detail-604000000', 'https://cfda.sos.wa.gov/api/BusinessSearch/BusinessInformation?businessID=604000000');

// ---- 2. browser
const KIND = process.env.BROWSER || 'chromium';
const browser = await require('playwright')[KIND].launch({ headless: process.env.HEADED ? false : true });
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1400, height: 1000 } });
const page = await ctx.newPage();
const calls = [];
page.on('request', (rq) => {
  const u = rq.url();
  if (!/cfda\.sos\.wa\.gov|ccfs\.sos\.wa\.gov/.test(u)) return;
  if (/\.(js|css|png|jpg|svg|woff2?|ico|gif)(\?|$)/.test(u)) return;
  const h = { ...rq.headers() }; delete h.cookie;
  calls.push({ t: Date.now(), url: u, method: rq.method(), type: rq.resourceType(), headers: h, postData: rq.postData() });
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
  const ctrls = await page.evaluate(() => [...document.querySelectorAll('input,select,button,a,textarea')].map((e) => ({ tag: e.tagName, id: e.id, name: e.name, type: e.type, ph: e.placeholder, txt: (e.innerText || e.value || '').slice(0, 60), href: e.getAttribute('href'), cls: e.className })).slice(0, 200));
  fs.writeFileSync(path.join(out, `controls-${n}.json`), JSON.stringify(ctrls, null, 1));
  L('step', n, page.url(), 'controls', ctrls.length);
};
try {
  await page.goto('https://ccfs.sos.wa.gov/#/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  await step('1-home');
  const link = page.getByText(/business search/i).first();
  if (await link.count()) { await link.click().catch((e) => L('click err', e.message)); await page.waitForTimeout(4000); }
  await step('2-search');
  const input = page.locator('#BusinessName');
  L('text inputs visible', await page.locator('input[type=text]:visible').count());
  await input.click(); await input.pressSequentially('Microsoft', { delay: 60 }).catch((e) => L('fill err', e.message));
  await page.waitForTimeout(500);
  const btn = page.locator('button.btn-search').first();
  if (await btn.count()) await btn.click().catch((e) => L('btn err', e.message)); else await input.press('Enter');
  await page.waitForTimeout(8000);
  await step('3-results');
  const first = page.locator('table tbody tr a:visible, table tbody tr:visible').first();
  if (await first.count()) { await first.click().catch((e) => L('row err', e.message)); await page.waitForTimeout(6000); }
  await step('4-detail');
} catch (e) { L('browser error', e.message); }
fs.writeFileSync(path.join(out, 'network.json'), JSON.stringify(calls, null, 1));
L('calls captured', calls.length, calls.map((c) => `${c.method} ${c.url} ${c.status}`).join(' | '));
await browser.close();
fs.writeFileSync(path.join(out, 'run.log'), log.join('\n'));
