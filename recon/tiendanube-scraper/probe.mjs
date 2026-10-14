// Recon for tiendanube-scraper. Runs on a GitHub runner. Plain fetch, no deps.
// Reads recon/tiendanube-scraper/config.json -> writes recon/tiendanube-scraper/out/*
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const dir = path.dirname(new URL(import.meta.url).pathname);
const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
const out = path.join(dir, 'out');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const log = [];
const say = (s) => { console.log(s); log.push(s); };
const safe = (s) => s.replace(/[^a-z0-9.]+/gi, '_').slice(0, 90);

async function get(url, { save, max = 400000, headers = {} } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'es-AR,es;q=0.9', accept: '*/*', ...headers }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
    let buf = Buffer.from(await res.arrayBuffer());
    const gz = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
    if (gz) { try { buf = zlib.gunzipSync(buf); } catch (e) { say(`  gunzip failed ${url}: ${e.message}`); } }
    const text = buf.toString('utf8');
    const hdr = ['server', 'content-type', 'content-encoding', 'cf-ray', 'x-ratelimit-remaining', 'retry-after', 'cache-control'].map((h) => (res.headers.get(h) ? `${h}=${res.headers.get(h)}` : '')).filter(Boolean).join(' ');
    say(`GET ${url} -> ${res.status} final=${res.url} len=${text.length} gz=${gz} ${Date.now() - t0}ms ${hdr}`);
    if (save) fs.writeFileSync(path.join(out, save), text.slice(0, max));
    return { status: res.status, text, url: res.url, headers: res.headers };
  } catch (e) {
    say(`GET ${url} -> ERROR ${e.cause?.code || e.message}`);
    return { status: 0, text: '' };
  }
}

const locsOf = (xml) => [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) => m[1]);
const isProduct = (u) => /\/(productos|produtos|products)\/[^/?#]+/.test(u);

// 1) store probes
for (const store of cfg.stores || []) {
  const host = store.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const base = `https://${host}`;
  const tag = safe(host);
  say(`== STORE ${host}`);
  const home = await get(base + '/', { save: `${tag}.home.html` });
  await get(base + '/robots.txt', { save: `${tag}.robots.txt` });
  const sm = await get(base + '/sitemap.xml', { save: `${tag}.sitemap.xml` });
  let productUrl = null;
  const locs = locsOf(sm.text);
  const children = locs.filter((l) => /sitemap/i.test(l));
  say(`  sitemap locs=${locs.length} children=${children.length}`);
  for (const c of children.slice(0, 6)) {
    const child = await get(c, { save: `${tag}.child.${safe(c.split('/').pop())}.xml`, max: 150000 });
    const cl = locsOf(child.text);
    say(`  child ${c} locs=${cl.length} sample=${cl.slice(0, 2).join(' | ')}`);
    if (!productUrl) productUrl = cl.find(isProduct);
  }
  if (!productUrl) productUrl = locs.find(isProduct);
  if (!productUrl) {
    const m = home.text.match(/href="(https?:\/\/[^"]*\/(?:productos|produtos)\/[^"/?#]+\/?)"/) || home.text.match(/href="(\/(?:productos|produtos)\/[^"/?#]+\/?)"/);
    if (m) productUrl = m[1].startsWith('/') ? base + m[1] : m[1];
  }
  say(`  product url: ${productUrl}`);
  if (productUrl) await get(productUrl, { save: `${tag}.product.html` });
  await get(base + '/productos/', { save: `${tag}.productos.html`, max: 300000 });
  await get(base + '/productos/?mpage=2', { save: `${tag}.productos2.html`, max: 100000 });
  await get(base + '/produtos/', { save: `${tag}.produtos.html`, max: 100000 });
}

// 2) rate-limit burst
if (cfg.burst) {
  say(`== BURST ${cfg.burst.url} x${cfg.burst.n}`);
  const codes = {};
  const t0 = Date.now();
  for (let i = 0; i < cfg.burst.n; i++) {
    const r = await fetch(cfg.burst.url, { headers: { 'user-agent': UA } })
      .then(async (x) => { await x.arrayBuffer(); return x.status; })
      .catch(() => 0);
    codes[r] = (codes[r] || 0) + 1;
  }
  say(`  codes=${JSON.stringify(codes)} total=${Date.now() - t0}ms`);
}

// 3) discovery sources
for (const [i, u] of (cfg.urls || []).entries()) {
  say(`== URL ${i}`);
  await get(u, { save: `disc-${i}-${safe(u.replace(/^https?:\/\//, ''))}.txt`, max: 300000 });
}
fs.writeFileSync(path.join(out, 'summary.txt'), log.join('\n') + '\n');
