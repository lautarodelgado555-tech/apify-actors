// Spike: can Mercado Libre be fetched from a datacenter IP? Measures block rate, size, time; probes the public API.
// Runs on a GitHub runner. Output: recon/mercadolibre-monitor/out/*
import fs from 'node:fs';
import path from 'node:path';
import { gotScraping } from 'got-scraping';
import { Impit } from 'impit';

const OUT = 'recon/mercadolibre-monitor/out';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const report = { startedAt: new Date().toISOString(), api: [], listings: [], items: [], itemsImpit: [], sites: [], bestsellers: [], sellers: [], firefox: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MARKERS = /captcha|account-verification|\/gz\/|login|robot|are you a human|unusual traffic|verifica que no eres|suspicious/i;
const features = (t) => ({
  ldjson: (t.match(/application\/ld\+json/g) || []).length,
  preloaded: /__PRELOADED_STATE__/.test(t),
  nordic: /nordic-state|__NORDIC/i.test(t),
  pdpPrice: /ui-pdp-price/.test(t),
  money: /andes-money-amount__fraction/.test(t),
  availableQty: /available_quantity/.test(t),
  soldQty: /sold_quantity|vendidos/i.test(t),
  polyCard: /poly-card/.test(t),
  uiSearch: /ui-search-result/.test(t),
  marker: (t.match(MARKERS) || [])[0] || null,
});
const titleOf = (t) => ((t.match(/<title[^>]*>([^<]*)/i) || [])[1] || '-').trim().slice(0, 100);
const saved = new Set();
function saveSample(name, text) {
  if (saved.has(name)) return;
  saved.add(name);
  const ext = /^\s*[\[{]/.test(text) ? 'json' : 'html';
  fs.writeFileSync(path.join(OUT, `${name}.${ext}`), text.slice(0, 3_000_000));
}

async function get(url, { follow = false, headers = {}, client = 'got' } = {}) {
  const t0 = Date.now();
  try {
    if (client === 'impit') {
      const impit = (get.impit ||= new Impit({ browser: 'chrome', followRedirects: false }));
      const res = await impit.fetch(url, { headers });
      const text = await res.text();
      return { url, status: res.status, ms: Date.now() - t0, bytes: Buffer.byteLength(text), location: res.headers.get('location') || '', text };
    }
    const res = await gotScraping({
      url, followRedirect: follow, throwHttpErrors: false, timeout: { request: 30000 },
      headerGeneratorOptions: { browsers: [{ name: 'chrome', minVersion: 120 }], operatingSystems: ['windows'], locales: ['es-AR', 'es'] },
      headers, retry: { limit: 0 },
    });
    const text = res.body || '';
    return { url, status: res.statusCode, ms: Date.now() - t0, bytes: Buffer.byteLength(text), location: res.headers.location || '', text };
  } catch (e) {
    return { url, status: 0, ms: Date.now() - t0, bytes: 0, error: String(e.message).split('\n')[0], text: '' };
  }
}
const brief = (r) => ({ url: r.url, status: r.status, ms: r.ms, bytes: r.bytes, location: r.location || undefined, error: r.error, title: titleOf(r.text), ...features(r.text) });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- A. listing pages (discovery of live IDs) ----------
const SITES = {
  MLA: { list: 'listado.mercadolibre.com.ar', terms: ['zapatillas', 'celular-samsung', 'heladera', 'auriculares-bluetooth', 'notebook', 'yerba-mate', 'perfume', 'lavarropas', 'smart-tv', 'mochila'] },
  MLM: { list: 'listado.mercadolibre.com.mx', terms: ['audifonos', 'tenis'] },
  MLB: { list: 'lista.mercadolivre.com.br', terms: ['fone-de-ouvido', 'tenis'] },
  MLC: { list: 'listado.mercadolibre.cl', terms: ['zapatillas'] },
  MCO: { list: 'listado.mercadolibre.com.co', terms: ['audifonos'] },
};
const found = {}; // site -> Map(id -> url)
for (const [site, cfg] of Object.entries(SITES)) {
  found[site] = new Map();
  for (const term of cfg.terms) {
    const url = `https://${cfg.list}/${term}`;
    const r = await get(url, { follow: true });
    const b = brief(r); report.listings.push(b); log('listing', site, term, r.status, r.bytes, b.marker || '');
    if (site === 'MLA' && term === 'zapatillas') saveSample('listing-MLA-zapatillas', r.text);
    if (site !== 'MLA' && term === cfg.terms[0]) saveSample(`listing-${site}`, r.text);
    // item links: https://articulo.mercadolibre.com.ar/MLA-123-title_JM  | https://www.mercadolibre.com.ar/title/p/MLA123 | .../up/MLAU123
    for (const m of r.text.matchAll(/https?:\/\/[^"'\s<>\\]*?(?:articulo\.[a-z.]+\/ML[A-Z]-\d+[^"'\s<>\\?#]*|\/p\/ML[A-Z]\d+|\/up\/ML[A-Z]U\d+)/g)) {
      const u = m[0].replace(/\\u002F/g, '/');
      const id = (u.match(/ML[A-Z]U?-?\d+/) || [])[0];
      if (id && !found[site].has(id)) found[site].set(id, u);
    }
    await sleep(500);
  }
  log('found', site, found[site].size);
}
report.discovered = Object.fromEntries(Object.entries(found).map(([k, v]) => [k, v.size]));
const discovered = Object.fromEntries(Object.entries(found).map(([k, v]) => [k, [...v.values()]]));
fs.writeFileSync(path.join(OUT, 'discovered-urls.json'), JSON.stringify(discovered, null, 1));

// ---------- B. public API without token ----------
const sampleId = (found.MLA.keys().next().value || '').replace('-', '');
const apiUrls = [
  'https://api.mercadolibre.com/sites/MLA',
  'https://api.mercadolibre.com/sites/MLA/search?q=zapatillas&limit=5',
  'https://api.mercadolibre.com/sites/MLA/categories',
  'https://api.mercadolibre.com/categories/MLA1055',
  'https://api.mercadolibre.com/highlights/MLA/category/MLA1055',
  'https://api.mercadolibre.com/trends/MLA',
  'https://api.mercadolibre.com/sites/MLA/domain_discovery/search?q=zapatillas',
  `https://api.mercadolibre.com/items/${sampleId}`,
  `https://api.mercadolibre.com/items?ids=${[...found.MLA.keys()].slice(0, 5).map((x) => x.replace('-', '')).join(',')}`,
  `https://api.mercadolibre.com/items/${sampleId}/description`,
  'https://api.mercadolibre.com/users/1',
  'https://api.mercadolibre.com/sites/MLA/search?seller_id=1&limit=3',
  'https://api.mercadolibre.com/currencies/ARS',
];
for (const u of apiUrls) {
  for (const [label, headers] of [['browser-ua', undefined], ['curl-ua', { 'user-agent': 'curl/8.5.0', accept: '*/*' }]]) {
    if (label === 'curl-ua' && !/items\/MLA|sites\/MLA\/search/.test(u)) continue;
    const r = await get(u, { follow: true, headers });
    report.api.push({ ...brief(r), label, body: r.text.slice(0, 500) });
    log('api', label, r.status, u.replace('https://api.mercadolibre.com', ''));
    if (/items\/MLA\d+$/.test(u) && label === 'browser-ua') saveSample('api-item', r.text);
    if (/sites\/MLA\/search/.test(u) && label === 'browser-ua') saveSample('api-search', r.text);
    await sleep(300);
  }
}

// ---------- C. item pages (MLA, many) ----------
async function pool(list, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < list.length) { const k = i++; out[k] = await fn(list[k], k); } }));
  return out;
}
const sellerIds = new Set(); const sellerSlugs = new Set(); const storeSlugs = new Set();
const harvest = (t) => {
  for (const m of t.matchAll(/seller_id["':= ]+(\d{4,12})/g)) sellerIds.add(m[1]);
  for (const m of t.matchAll(/mercadolibre\.com\.ar\/perfil\/([A-Za-z0-9_.+%-]+)/g)) sellerSlugs.add(m[1]);
  for (const m of t.matchAll(/mercadolibre\.com\.ar\/tienda\/([a-z0-9-]+)/g)) storeSlugs.add(m[1]);
};
const mlaUrls = discovered.MLA;
const itemTargets = mlaUrls.slice(0, 300);
log('item targets', itemTargets.length);
let catalogSamples = 0;
const itemResults = await pool(itemTargets, 6, async (u, k) => {
  const r = await get(u, { follow: true });
  const b = brief(r);
  if (r.status === 200) harvest(r.text);
  const isCat = /\/p\/ML/.test(u);
  if (k < 3 || (isCat && catalogSamples < 3 && ++catalogSamples)) saveSample(`item-MLA-${k}${isCat ? '-catalog' : ''}`, r.text);
  await sleep(150);
  return b;
});
report.items = itemResults;
log('items ok', itemResults.filter((x) => x.status === 200 && !x.marker).length, '/', itemResults.length);

// impit variant on 60
const impitTargets = mlaUrls.slice(0, 60);
report.itemsImpit = await pool(impitTargets, 4, async (u) => { const r = await get(u, { client: 'impit', follow: false }); await sleep(150); return brief(r); });
log('impit done');

// ---------- D. other sites ----------
for (const site of ['MLM', 'MLB', 'MLC', 'MCO']) {
  const urls = discovered[site].slice(0, 12);
  const res = await pool(urls, 4, async (u, k) => {
    const r = await get(u, { follow: true });
    if (k === 0) saveSample(`item-${site}`, r.text);
    await sleep(200);
    return brief(r);
  });
  report.sites.push({ site, results: res });
  log('site', site, res.map((x) => x.status).join(','));
}

// ---------- E. best sellers ----------
const bsLanding = await get('https://www.mercadolibre.com.ar/mas-vendidos', { follow: true });
report.bestsellers.push(brief(bsLanding)); saveSample('bestsellers-landing-MLA', bsLanding.text);
const catLinks = [...new Set([...bsLanding.text.matchAll(/mas-vendidos\/(MLA\d+)/g)].map((m) => m[1]))].slice(0, 12);
report.bestsellerCategories = catLinks;
log('bestseller categories', catLinks.length);
for (const [k, c] of catLinks.entries()) {
  const r = await get(`https://www.mercadolibre.com.ar/mas-vendidos/${c}`, { follow: true });
  report.bestsellers.push(brief(r)); if (k < 2) saveSample(`bestsellers-${c}`, r.text);
  await sleep(300);
}
for (const u of ['https://www.mercadolibre.com.mx/mas-vendidos', 'https://www.mercadolivre.com.br/mais-vendidos', 'https://www.mercadolibre.cl/mas-vendidos']) {
  const r = await get(u, { follow: true }); report.bestsellers.push(brief(r)); await sleep(300);
}

// ---------- F. sellers ----------
report.sellerDiscovery = { sellerIds: [...sellerIds].slice(0, 20), sellerSlugs: [...sellerSlugs].slice(0, 20), storeSlugs: [...storeSlugs].slice(0, 20) };
const sellerTargets = [
  ...[...sellerIds].slice(0, 3).map((id) => `https://listado.mercadolibre.com.ar/_CustId_${id}`),
  ...[...sellerIds].slice(0, 2).map((id) => `https://api.mercadolibre.com/users/${id}`),
  ...[...sellerSlugs].slice(0, 3).map((s) => `https://www.mercadolibre.com.ar/perfil/${s}`),
  ...[...storeSlugs].slice(0, 3).map((s) => `https://www.mercadolibre.com.ar/tienda/${s}`),
  'https://www.mercadolibre.com.ar/tiendas-oficiales',
];
for (const [k, u] of sellerTargets.entries()) {
  const r = await get(u, { follow: true });
  report.sellers.push(brief(r)); saveSample(`seller-${k}`, r.text); log('seller', r.status, u);
  await sleep(300);
}

// ---------- G. Firefox fallback on a few ----------
try {
  const { firefox } = await import('playwright');
  const browser = await firefox.launch({ headless: true });
  const targets = [discovered.MLA[0], discovered.MLA[1], 'https://listado.mercadolibre.com.ar/zapatillas', 'https://www.mercadolibre.com.ar/mas-vendidos'].filter(Boolean);
  for (const [k, u] of targets.entries()) {
    const t0 = Date.now();
    const page = await browser.newPage();
    try {
      const resp = await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2500);
      const html = await page.content();
      report.firefox.push({ url: u, status: resp?.status(), ms: Date.now() - t0, bytes: Buffer.byteLength(html), title: titleOf(html), ...features(html) });
      if (k === 0) saveSample('firefox-item', html);
    } catch (e) { report.firefox.push({ url: u, error: String(e.message).split('\n')[0] }); }
    await page.close();
  }
  await browser.close();
} catch (e) { report.firefox.push({ error: String(e.message).split('\n')[0] }); }

// ---------- summary ----------
const stat = (arr) => {
  const by = {}; for (const x of arr) by[x.status] = (by[x.status] || 0) + 1;
  const okx = arr.filter((x) => x.status === 200 && !x.marker);
  const avg = (f) => okx.length ? Math.round(okx.reduce((a, x) => a + x[f], 0) / okx.length) : 0;
  return { n: arr.length, byStatus: by, okClean: okx.length, markers: arr.filter((x) => x.marker).length, avgBytes: avg('bytes'), avgMs: avg('ms'), withLdJson: okx.filter((x) => x.ldjson).length, withPreloaded: okx.filter((x) => x.preloaded).length };
};
report.summary = { items: stat(report.items), itemsImpit: stat(report.itemsImpit), listings: stat(report.listings), bestsellers: stat(report.bestsellers), sellers: stat(report.sellers), sites: report.sites.map((s) => ({ site: s.site, ...stat(s.results) })) };
report.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report.summary, null, 1));
