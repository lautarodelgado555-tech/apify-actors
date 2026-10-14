// Spike round 3. Findings so far: from a GitHub datacenter IP, item pages (/p/MLA..), listings, best sellers redirect to a LOGIN wall
// ("Para continuar, ingresa a tu cuenta"), the API answers 403/401, and the Apify proxy refuses mercadolibre on the FREE plan (403).
// Official store pages (/tienda/<slug>) and /tiendas-oficiales were served normally. Round 3 maps which surfaces stay open, with compressed wire bytes.
// Output: recon/mercadolibre-monitor/out/r3/*   (APIFY_TOKEN env only used to read the proxy password; never printed)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import net from 'node:net';
import { gotScraping } from 'got-scraping';
import { Impit } from 'impit';

const OUT = 'recon/mercadolibre-monitor/out/r3';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const report = { startedAt: new Date().toISOString(), proxy403: null, api: [], surfaces: [], priming: [], impit: [], volume: [], otherSites: [] };

const GATE = /account-verification|suspicious-traffic|captcha|ingresa a tu cuenta|unusual traffic|\/lgz\/login|gz\/login/i;
const titleOf = (t) => ((t.match(/<title[^>]*>([^<]*)/i) || [])[1] || '-').trim().slice(0, 80);
const decode = (buf, enc) => {
  try {
    if (/br/.test(enc)) return zlib.brotliDecompressSync(buf).toString('utf8');
    if (/gzip/.test(enc)) return zlib.gunzipSync(buf).toString('utf8');
    if (/deflate/.test(enc)) return zlib.inflateSync(buf).toString('utf8');
  } catch { /* identity */ }
  return buf.toString('utf8');
};
const feat = (t) => ({ gate: GATE.test(t), poly: (t.match(/poly-card__content/g) || []).length, money: /andes-money-amount/.test(t), pdp: /ui-pdp/.test(t), ld: (t.match(/application\/ld\+json/g) || []).length });
async function get(url, { headers = {}, cookieJar, follow = true } = {}) {
  const t0 = Date.now();
  try {
    const res = await gotScraping({
      url, followRedirect: follow, maxRedirects: 5, throwHttpErrors: false, responseType: 'buffer', decompress: false, cookieJar,
      timeout: { request: 40000 }, retry: { limit: 0 },
      headers: { 'accept-encoding': 'gzip, deflate, br', ...headers },
      headerGeneratorOptions: { browsers: [{ name: 'chrome', minVersion: 120 }], operatingSystems: ['windows'], locales: ['es-AR', 'es'] },
    });
    const enc = String(res.headers['content-encoding'] || 'identity');
    const text = decode(res.body, enc);
    return { url, status: res.statusCode, ms: Date.now() - t0, wire: res.body.length, bytes: Buffer.byteLength(text), enc, finalUrl: res.url, location: res.headers.location, text };
  } catch (e) {
    return { url, status: 0, ms: Date.now() - t0, wire: 0, bytes: 0, error: String(e.message).split('\n')[0].slice(0, 120), text: '' };
  }
}
const brief = (r) => ({ url: r.url.slice(0, 140), status: r.status, ms: r.ms, wire: r.wire, bytes: r.bytes, enc: r.enc, error: r.error, finalUrl: r.finalUrl && r.finalUrl !== r.url ? r.finalUrl.slice(0, 120) : undefined, title: titleOf(r.text), ...feat(r.text) });
const saved = new Set();
const save = (name, text) => { if (saved.has(name) || !text) return; saved.add(name); fs.writeFileSync(path.join(OUT, `${name}.${/^\s*[\[{]/.test(text) ? 'json' : 'html'}`), text.slice(0, 3_000_000)); };
async function pool(list, n, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < list.length) { const k = i++; out[k] = await fn(list[k], k); } })); return out; }

// ---- 0. why does the Apify proxy answer 403? (read the CONNECT response body; password not logged)
try {
  const j = await (await fetch('https://api.apify.com/v2/users/me', { headers: { Authorization: `Bearer ${process.env.APIFY_TOKEN || ''}` } })).json();
  const pw = j?.data?.proxy?.password;
  report.plan = j?.data?.plan?.id;
  if (pw) {
    for (const [label, user] of [['res', 'groups-RESIDENTIAL,country-AR'], ['auto', 'auto']]) {
      await new Promise((resolve) => {
        {
          const s = net.connect(8000, 'proxy.apify.com', () => {
            const auth = Buffer.from(`${user}:${pw}`).toString('base64');
            s.write(`CONNECT www.mercadolibre.com.ar:443 HTTP/1.1\r\nHost: www.mercadolibre.com.ar:443\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
          });
          let buf = '';
          s.on('data', (d) => { buf += d.toString(); });
          s.setTimeout(8000, () => s.destroy());
          s.on('close', () => { report.proxy403 = report.proxy403 || {}; report.proxy403[label] = buf.replaceAll(pw, '***').slice(0, 600); resolve(); });
          s.on('error', () => resolve());
        }
      });
    }
  }
} catch (e) { report.proxy403 = { error: String(e.message).slice(0, 100) }; }
log('proxy403', JSON.stringify(report.proxy403));

// ---- known live ids from round 2
const ITEM = 'MLA2639626512'; const PROD = 'MLA58756915';
const itemUrl = `https://www.mercadolibre.com.ar/microondas-bgh-mecanico-18l-blanco-b118mb25/p/${PROD}?pdp_filters=item_id%3A${ITEM}`;

// ---- 1. API with real ids
for (const u of [`/items/${ITEM}`, `/items?ids=${ITEM}`, `/items/${ITEM}?attributes=id,price,original_price,available_quantity,sold_quantity,seller_id`, `/products/${PROD}`, `/products/${PROD}/items`, `/products/${PROD}/items?limit=5`, `/sites/MLA/search?q=microondas&limit=3`, `/sites/MLA/search?category=MLA1055&limit=3`, `/users/139060460`, `/sites/MLA/search?seller_id=139060460&limit=3`, `/sites/MLA/search?official_store_id=56&limit=3`, `/categories/MLA1055`, `/highlights/MLA/category/MLA1055`, `/items/${ITEM}/prices`, `/reviews/item/${ITEM}`]) {
  const r = await get(`https://api.mercadolibre.com${u}`, { headers: { accept: 'application/json' } });
  report.api.push({ u, status: r.status, wire: r.wire, body: r.text.slice(0, 160) });
  if (r.status === 200) save(`api-${u.replace(/[^a-z0-9]/gi, '_').slice(0, 40)}`, r.text);
  log('api', r.status, u);
  await sleep(200);
}

// ---- 2. which surfaces stay open from a datacenter IP?
const surfaces = [
  'https://www.mercadolibre.com.ar/', 'https://www.mercadolibre.com.ar/tiendas-oficiales', 'https://www.mercadolibre.com.ar/tienda/bgh', 'https://listado.mercadolibre.com.ar/tienda/bgh/',
  'https://www.mercadolibre.com.ar/c/celulares-y-telefonos', 'https://www.mercadolibre.com.ar/c/electrodomesticos-y-aires-ac', 'https://www.mercadolibre.com.ar/categorias',
  'https://www.mercadolibre.com.ar/ofertas', 'https://www.mercadolibre.com.ar/ofertas/supermercado', 'https://www.mercadolibre.com.ar/mas-vendidos', 'https://www.mercadolibre.com.ar/mas-vendidos/MLA1055',
  'https://listado.mercadolibre.com.ar/celulares-telefonos/celulares-smartphones/', 'https://listado.mercadolibre.com.ar/microondas', 'https://www.mercadolibre.com.ar/jm/search?as_word=microondas',
  itemUrl, `https://www.mercadolibre.com.ar/p/${PROD}`, `https://www.mercadolibre.com.ar/MLA-${ITEM.slice(3)}`, `https://articulo.mercadolibre.com.ar/MLA-${ITEM.slice(3)}`, `https://www.mercadolibre.com.ar/perfil/BGH`,
  'https://www.mercadolibre.com.ar/ayuda', 'https://www.mercadolibre.com.ar/sitemap.xml', 'https://www.mercadolibre.com.ar/robots.txt',
];
for (const u of surfaces) {
  const r = await get(u);
  report.surfaces.push(brief(r)); log('surface', r.status, r.gate ?? '', feat(r.text).gate ? 'GATE' : 'open', r.wire, u.slice(0, 90));
  if (r.status === 200 && !GATE.test(r.text)) save(`surface-${u.replace(/[^a-z0-9]/gi, '_').slice(8, 70)}`, r.text);
  await sleep(300);
}

// ---- 3. priming: open store page (cookies) then item with referer; mobile UA; impit
const jar = new (await import('tough-cookie')).CookieJar();
const p1 = await get('https://www.mercadolibre.com.ar/tienda/bgh', { cookieJar: jar });
const p2 = await get(itemUrl, { cookieJar: jar, headers: { referer: 'https://www.mercadolibre.com.ar/tienda/bgh', 'sec-fetch-site': 'same-origin' } });
report.priming.push(brief(p1), brief(p2));
const p3 = await get(itemUrl, { headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' } });
report.priming.push({ ...brief(p3), note: 'iphone-ua' });
log('priming', p1.status, p2.status, feat(p2.text).gate ? 'GATE' : 'open', p3.status, feat(p3.text).gate ? 'GATE' : 'open');
try {
  const impit = new Impit({ browser: 'chrome', followRedirects: true, cookieJar: undefined });
  for (const u of [itemUrl, 'https://listado.mercadolibre.com.ar/microondas', 'https://www.mercadolibre.com.ar/tienda/bgh']) {
    const res = await impit.fetch(u); const text = await res.text();
    report.impit.push({ url: u.slice(0, 100), status: res.status, bytes: text.length, ...feat(text), title: titleOf(text) });
  }
} catch (e) { report.impit.push({ error: String(e.message).slice(0, 100) }); }
log('impit', JSON.stringify(report.impit.map((x) => [x.status, x.gate])));

// ---- 4. volume test on the open surface: official store pages (compressed wire bytes, block rate)
const land = await get('https://www.mercadolibre.com.ar/tiendas-oficiales');
const slugs = [...new Set([...land.text.matchAll(/mercadolibre\.com\.ar\/tienda\/([a-z0-9-]+)/g)].map((m) => m[1]))];
log('slugs', slugs.length);
let n = 0;
const vol = await pool(slugs.slice(0, 80), 5, async (s, k) => {
  const r = await get(`https://www.mercadolibre.com.ar/tienda/${s}`);
  if (k < 4 && r.status === 200 && !GATE.test(r.text)) save(`store-${s}`, r.text);
  n++; await sleep(100);
  return { slug: s, ...brief(r) };
});
const ok = vol.filter((x) => x.status === 200 && !x.gate);
report.volume = { n: vol.length, byStatus: vol.reduce((a, x) => ((a[x.status] = (a[x.status] || 0) + 1), a), {}), gated: vol.filter((x) => x.gate).length, ok: ok.length, avgWire: Math.round(ok.reduce((a, x) => a + x.wire, 0) / (ok.length || 1)), avgBytes: Math.round(ok.reduce((a, x) => a + x.bytes, 0) / (ok.length || 1)), avgMs: Math.round(ok.reduce((a, x) => a + x.ms, 0) / (ok.length || 1)), cardsPerPage: Math.round(ok.reduce((a, x) => a + x.poly, 0) / (ok.length || 1)), sample: vol.slice(0, 5) };
log('volume', JSON.stringify({ ...report.volume, sample: undefined }));

// ---- 5. other sites: official-store landings and a store page
for (const [host, landing, storeRe] of [['www.mercadolibre.com.mx', '/tiendas-oficiales', /mercadolibre\.com\.mx\/tienda\/([a-z0-9-]+)/g], ['www.mercadolivre.com.br', '/lojas-oficiais', /mercadolivre\.com\.br\/loja\/([a-z0-9-]+)/g], ['www.mercadolibre.cl', '/tiendas-oficiales', /mercadolibre\.cl\/tienda\/([a-z0-9-]+)/g], ['www.mercadolibre.com.co', '/tiendas-oficiales', /mercadolibre\.com\.co\/tienda\/([a-z0-9-]+)/g]]) {
  const l = await get(`https://${host}${landing}`);
  const ss = [...new Set([...l.text.matchAll(storeRe)].map((m) => m[1]))];
  const row = { host, landing: brief(l), slugs: ss.length };
  if (ss.length) {
    const kind = host.includes('.br') ? 'loja' : 'tienda';
    const s = await get(`https://${host}/${kind}/${ss[0]}`);
    row.store = brief(s); if (s.status === 200 && !GATE.test(s.text)) save(`store-${host}`, s.text);
  }
  const it = await get(`https://${host}/`);
  row.home = brief(it);
  report.otherSites.push(row); log('other', host, l.status, ss.length, row.store?.status, row.store?.gate);
  await sleep(300);
}

report.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
console.log('done');
