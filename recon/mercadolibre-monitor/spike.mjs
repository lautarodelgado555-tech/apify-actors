// Spike round 2: round 1 showed that GitHub datacenter IPs get the "suspicious traffic" gate on listings/best sellers and 403 on most API calls.
// Round 2 compares three routes: direct (datacenter), Apify datacenter proxy, Apify residential proxy (AR), measuring wire bytes (compressed) too.
// Output: recon/mercadolibre-monitor/out/r2/*   (needs APIFY_TOKEN env for the proxy password; the password is never printed)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { gotScraping } from 'got-scraping';

const OUT = 'recon/mercadolibre-monitor/out/r2';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const report = { startedAt: new Date().toISOString(), proxyGroups: null, discovery: {}, routes: {}, api: [], bestsellers: [], firefox: [] };

// ---- proxy credentials (never logged)
let PW = '';
try {
  const res = await fetch('https://api.apify.com/v2/users/me', { headers: { Authorization: `Bearer ${process.env.APIFY_TOKEN || ''}` } });
  const j = await res.json();
  PW = j?.data?.proxy?.password || '';
  report.proxyGroups = (j?.data?.proxy?.groups || []).map((g) => g.name);
  report.plan = j?.data?.plan?.id || null;
} catch (e) { report.proxyError = String(e.message).slice(0, 100); }
log('proxy password present:', !!PW, 'groups:', JSON.stringify(report.proxyGroups));

const ROUTES = {
  direct: () => undefined,
  dc: () => (PW ? `http://auto:${PW}@proxy.apify.com:8000` : undefined),
  res: (country = 'AR') => (PW ? `http://groups-RESIDENTIAL,country-${country}:${PW}@proxy.apify.com:8000` : undefined),
};
const routeAvailable = (r) => r === 'direct' || !!PW;

const MARKERS = /account-verification|suspicious-traffic|captcha|unusual traffic|are you a human/i;
const titleOf = (t) => ((t.match(/<title[^>]*>([^<]*)/i) || [])[1] || '-').trim().slice(0, 100);
const features = (t) => ({
  gate: MARKERS.test(t),
  ldjson: (t.match(/application\/ld\+json/g) || []).length,
  preloaded: /__PRELOADED_STATE__/.test(t),
  nordic: /nordic/i.test(t),
  pdp: /ui-pdp/.test(t),
  money: /andes-money-amount/.test(t),
  polyCard: /poly-card/.test(t),
  uiSearch: /ui-search-layout|ui-search-result/.test(t),
});
const decode = (buf, enc) => {
  try {
    if (/br/.test(enc)) return zlib.brotliDecompressSync(buf).toString('utf8');
    if (/gzip/.test(enc)) return zlib.gunzipSync(buf).toString('utf8');
    if (/deflate/.test(enc)) return zlib.inflateSync(buf).toString('utf8');
  } catch { /* fall through */ }
  return buf.toString('utf8');
};
async function get(url, route = 'direct', { country, headers } = {}) {
  const t0 = Date.now();
  const proxyUrl = ROUTES[route](country);
  if (route !== 'direct' && !proxyUrl) return { url, route, status: -1, error: 'no proxy', text: '', wire: 0, bytes: 0, ms: 0 };
  try {
    const res = await gotScraping({
      url, proxyUrl, followRedirect: true, maxRedirects: 5, throwHttpErrors: false, responseType: 'buffer', decompress: false,
      timeout: { request: 45000 }, retry: { limit: 0 }, headers,
      headerGeneratorOptions: { browsers: [{ name: 'chrome', minVersion: 120 }], operatingSystems: ['windows'], locales: ['es-AR', 'es'] },
    });
    const text = decode(res.body, String(res.headers['content-encoding'] || ''));
    return { url, route, status: res.statusCode, ms: Date.now() - t0, wire: res.body.length, bytes: Buffer.byteLength(text), finalUrl: res.url, text };
  } catch (e) {
    return { url, route, status: 0, ms: Date.now() - t0, wire: 0, bytes: 0, error: String(e.message).split('\n')[0].slice(0, 120), text: '' };
  }
}
const brief = (r) => ({ url: r.url, route: r.route, status: r.status, ms: r.ms, wire: r.wire, bytes: r.bytes, error: r.error, finalUrl: r.finalUrl !== r.url ? r.finalUrl : undefined, title: titleOf(r.text), ...features(r.text) });
const saved = new Set();
function save(name, text) {
  if (saved.has(name) || !text) return;
  saved.add(name);
  fs.writeFileSync(path.join(OUT, `${name}.${/^\s*[\[{]/.test(text) ? 'json' : 'html'}`), text.slice(0, 3_000_000));
}
async function pool(list, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < list.length) { const k = i++; out[k] = await fn(list[k], k); } }));
  return out;
}
const summarize = (arr) => {
  const by = {}; for (const x of arr) by[x.status] = (by[x.status] || 0) + 1;
  const ok = arr.filter((x) => x.status === 200 && !x.gate);
  const avg = (f) => (ok.length ? Math.round(ok.reduce((a, x) => a + x[f], 0) / ok.length) : 0);
  return { n: arr.length, byStatus: by, gated: arr.filter((x) => x.gate).length, okClean: ok.length, avgWireBytes: avg('wire'), avgBytes: avg('bytes'), avgMs: avg('ms') };
};

// ---- item link extraction
function extractItems(text, host) {
  const t = text.replace(/\\u002F/gi, '/').replace(/&amp;/g, '&');
  const out = new Map();
  for (const m of t.matchAll(/https?:\/\/[^"'\s<>\\]+/g)) {
    const u = m[0];
    const id = (u.match(/\/(ML[A-Z])-?(\d{8,12})(?![\d])/) || u.match(/\/p\/(ML[A-Z])(\d{6,12})/) || u.match(/\/up\/(ML[A-Z]U)(\d{6,12})/) || []);
    if (id[0] && /mercadoli[bv]re/.test(u) && !/mlstatic|\.(jpg|webp|png)/.test(u)) out.set(id[1] + id[2] + (u.includes('/p/') ? 'p' : u.includes('/up/') ? 'u' : ''), u.split('#')[0]);
  }
  return [...out.values()];
}

// ---- 1. discovery of live item URLs: tiendas-oficiales -> tienda pages (compared across routes)
const landingUrl = 'https://www.mercadolibre.com.ar/tiendas-oficiales';
const landing = await get(landingUrl, 'direct');
const slugs = [...new Set([...landing.text.matchAll(/mercadolibre\.com\.ar\/tienda\/([a-z0-9-]+)/g)].map((m) => m[1]))];
report.discovery.landing = brief(landing); report.discovery.slugCount = slugs.length; report.discovery.slugs = slugs.slice(0, 30);
log('store slugs', slugs.length);
const pick = ['bgh', 'samsung', 'adidas', 'philips', 'motorola'].filter((s) => slugs.includes(s));
const storeSlugs = [...new Set([...pick, ...slugs.slice(0, 6)])].slice(0, 6);
const itemUrls = new Set();
report.discovery.tienda = [];
for (const route of ['direct', 'dc', 'res']) {
  if (!routeAvailable(route)) continue;
  const rs = [];
  for (const s of storeSlugs) {
    const r = await get(`https://www.mercadolibre.com.ar/tienda/${s}`, route);
    const items = extractItems(r.text);
    rs.push({ ...brief(r), itemLinks: items.length });
    if (!r.text.match(MARKERS)) items.forEach((u) => itemUrls.add(u));
    if (!saved.has(`tienda-${route}`) && r.status === 200 && !MARKERS.test(r.text)) save(`tienda-${route}`, r.text);
    await sleep(300);
  }
  report.discovery.tienda.push({ route, summary: summarize(rs), pages: rs });
  log('tienda', route, JSON.stringify(summarize(rs)), 'items so far', itemUrls.size);
}
// search listing through res as a second source (listing pages)
const listingTerms = ['zapatillas', 'heladera', 'notebook'];
report.discovery.listings = [];
for (const route of ['direct', 'dc', 'res']) {
  if (!routeAvailable(route)) continue;
  const rs = [];
  for (const term of listingTerms) {
    const r = await get(`https://listado.mercadolibre.com.ar/${term}`, route);
    const items = extractItems(r.text);
    rs.push({ ...brief(r), itemLinks: items.length });
    if (!MARKERS.test(r.text)) { items.forEach((u) => itemUrls.add(u)); save(`listing-${route}-${term}`, r.text); }
    await sleep(300);
  }
  report.discovery.listings.push({ route, summary: summarize(rs), pages: rs });
  log('listing', route, JSON.stringify(summarize(rs)), 'items so far', itemUrls.size);
}
const items = [...itemUrls];
fs.writeFileSync(path.join(OUT, 'discovered-items.json'), JSON.stringify(items, null, 1));
log('total item urls', items.length);

// ---- 2. item pages per route
const N = { direct: 40, dc: 40, res: 40 };
for (const route of ['direct', 'dc', 'res']) {
  if (!routeAvailable(route) || !items.length) continue;
  const targets = items.slice(0, N[route]);
  let k0 = 0;
  const rs = await pool(targets, route === 'direct' ? 6 : 4, async (u, k) => {
    const r = await get(u, route);
    if (r.status === 200 && !MARKERS.test(r.text) && k0 < 3) { k0++; save(`item-${route}-${k}`, r.text); }
    await sleep(120);
    return brief(r);
  });
  report.routes[route] = { summary: summarize(rs), results: rs };
  log('items', route, JSON.stringify(summarize(rs)));
}

// ---- 3. API with real item IDs, per route
const idsOf = items.map((u) => (u.match(/ML[A-Z]-?\d{8,12}/) || [])[0]).filter(Boolean).map((x) => x.replace('-', ''));
const apiIds = [...new Set(idsOf)].slice(0, 3);
for (const route of ['direct', 'dc', 'res']) {
  if (!routeAvailable(route)) continue;
  for (const id of apiIds.slice(0, route === 'direct' ? 3 : 2)) {
    for (const u of [`https://api.mercadolibre.com/items/${id}`, `https://api.mercadolibre.com/items?ids=${id}`]) {
      const r = await get(u, route, { headers: { accept: 'application/json' } });
      report.api.push({ route, url: u, status: r.status, wire: r.wire, body: r.text.slice(0, 300) });
      if (r.status === 200 && /items\/ML/.test(u)) save(`api-item-${route}`, r.text);
      log('api', route, r.status, u.replace('https://api.mercadolibre.com', ''));
    }
  }
}

// ---- 4. best sellers (landing -> categories), tried on the routes
const bsRoutes = ['direct', 'res'];
for (const route of bsRoutes) {
  if (!routeAvailable(route)) continue;
  const land = await get('https://www.mercadolibre.com.ar/mas-vendidos', route);
  report.bestsellers.push(brief(land));
  if (land.status === 200 && !MARKERS.test(land.text)) {
    save(`bestsellers-landing-${route}`, land.text);
    const cats = [...new Set([...land.text.replace(/\\u002F/g, '/').matchAll(/mas-vendidos\/(MLA\d+)/g)].map((m) => m[1]))].slice(0, 4);
    report.bestsellerCategories = cats;
    for (const [k, c] of cats.entries()) {
      const r = await get(`https://www.mercadolibre.com.ar/mas-vendidos/${c}`, route);
      report.bestsellers.push(brief(r));
      if (k < 2 && r.status === 200 && !MARKERS.test(r.text)) save(`bestsellers-${route}-${c}`, r.text);
      await sleep(300);
    }
  }
}
// other sites through residential (country matched)
if (routeAvailable('res')) {
  for (const [host, cc, path_] of [['https://listado.mercadolibre.com.mx', 'MX', 'audifonos'], ['https://lista.mercadolivre.com.br', 'BR', 'fone-de-ouvido'], ['https://www.mercadolibre.com.mx', 'MX', 'mas-vendidos'], ['https://www.mercadolivre.com.br', 'BR', 'mais-vendidos']]) {
    const r = await get(`${host}/${path_}`, 'res', { country: cc });
    report.bestsellers.push({ ...brief(r), note: `other-site ${cc}` });
    if (r.status === 200 && !MARKERS.test(r.text)) save(`other-${cc}-${path_}`, r.text);
    await sleep(300);
  }
}

// ---- 5. Firefox: direct and through the residential proxy (pass/fail only)
try {
  const { firefox } = await import('playwright');
  for (const route of ['direct', 'res']) {
    if (!routeAvailable(route) || !items.length) continue;
    const browser = await firefox.launch({ headless: true, proxy: route === 'res' ? { server: 'http://proxy.apify.com:8000', username: 'groups-RESIDENTIAL,country-AR', password: PW } : undefined });
    for (const u of [items[0], 'https://listado.mercadolibre.com.ar/zapatillas']) {
      const t0 = Date.now(); const page = await browser.newPage(); let wire = 0;
      page.on('response', async (resp) => { try { const cl = Number(resp.headers()['content-length'] || 0); wire += cl; } catch { /* ignore */ } });
      try {
        const resp = await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(2500);
        const html = await page.content();
        report.firefox.push({ route, url: u, status: resp?.status(), ms: Date.now() - t0, bytes: Buffer.byteLength(html), wireApprox: wire, title: titleOf(html), ...features(html) });
        if (!MARKERS.test(html)) save(`firefox-${route}-${u.includes('listado') ? 'listing' : 'item'}`, html);
      } catch (e) { report.firefox.push({ route, url: u, error: String(e.message).split('\n')[0].slice(0, 120) }); }
      await page.close();
    }
    await browser.close();
  }
} catch (e) { report.firefox.push({ error: String(e.message).split('\n')[0] }); }

report.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
console.log(JSON.stringify({ routes: Object.fromEntries(Object.entries(report.routes).map(([k, v]) => [k, v.summary])), firefox: report.firefox.map((f) => [f.route, f.status, f.gate, f.error]) }, null, 1));
