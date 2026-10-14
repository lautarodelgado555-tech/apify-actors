// Recon for tiendanube-scraper. Runs on a GitHub runner. Plain fetch, no deps.
// Reads recon/tiendanube-scraper/config.json -> writes recon/tiendanube-scraper/out/*
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const dir = path.dirname(new URL(import.meta.url).pathname);
const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
const out = path.join(dir, cfg.outDir || 'out');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const log = [];
const say = (s) => { console.log(s); log.push(s); };
const safe = (s) => s.replace(/[^a-z0-9.]+/gi, '_').slice(0, 90);

async function get(url, { save, max = 400000, headers = {}, timeout = 30000 } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'es-AR,es;q=0.9', accept: '*/*', ...headers }, redirect: 'follow', signal: AbortSignal.timeout(timeout) });
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

// 2b) explicit pages (full size)
for (const p of cfg.pages || []) {
  say(`== PAGE ${p.save}`);
  await get(p.url, { save: p.save, max: p.max || 3000000, timeout: 60000 });
}

// 3) discovery sources
for (const [i, u] of (cfg.urls || []).entries()) {
  say(`== URL ${i}`);
  await get(u, { save: `disc-${i}.txt`, max: 600000, timeout: 120000 });
}

// 4) host discovery experiment: how many distinct store hosts do CDX sources yield, and are they alive?
const hostOf = (line) => {
  let u = line.trim();
  if (u.startsWith('{')) { try { u = JSON.parse(u).url || ''; } catch { return null; } }
  const m = u.match(/^https?:\/\/([^/:?#]+)/i);
  return m ? m[1].toLowerCase().replace(/^www\./, '') : null;
};
const allHosts = new Map();
for (const src of cfg.cdx || []) {
  say(`== CDX ${src.name}`);
  const r = await get(src.url, { timeout: 150000 });
  const hosts = new Set();
  if (r.status === 200) for (const line of r.text.split('\n')) { const h = hostOf(line); if (h) hosts.add(h); }
  say(`  ${src.name}: rows=${r.text.split('\n').length} distinctHosts=${hosts.size}`);
  fs.writeFileSync(path.join(out, `hosts-${src.name}.txt`), [...hosts].sort().join('\n'));
  for (const h of hosts) allHosts.set(h, (allHosts.get(h) || 0) + 1);
}
const candidates = [...allHosts.keys()].filter((h) => /^[a-z0-9-]+\.(mitiendanube\.com|lojavirtualnuvem\.com\.br)$/.test(h));
say(`== UNION distinct store hosts: ${candidates.length}`);
fs.writeFileSync(path.join(out, 'hosts-union.txt'), candidates.sort().join('\n'));
if (cfg.aliveSample && candidates.length) {
  const sample = candidates.slice().sort(() => Math.random() - 0.5).slice(0, cfg.aliveSample);
  const stats = {};
  const rows = [];
  let idx = 0;
  const worker = async () => {
    while (idx < sample.length) {
      const h = sample[idx++];
      try {
        const res = await fetch(`https://${h}/`, { headers: { 'user-agent': UA, 'accept-language': 'es' }, redirect: 'follow', signal: AbortSignal.timeout(25000) });
        const t = await res.text();
        const name = (t.match(/LS\.store = \{[\s\S]*?name\s*:\s*"([^"]*)"/) || [])[1] || '';
        const country = (t.match(/LS\.country = "([A-Z]{2})"/) || [])[1] || '';
        const cur = (t.match(/LS\.currency = \{\s*code\s*:\s*"([A-Z]{3})"/) || [])[1] || '';
        const k = `${res.status}${new URL(res.url).host.replace(/^www\./, '') === h ? '' : ' redirected'}`;
        stats[k] = (stats[k] || 0) + 1;
        rows.push(`${h}\t${res.status}\t${res.url === `https://${h}/` ? '' : res.url}\t${country}\t${cur}\t${name}\t${t.length}`);
      } catch (e) { stats.error = (stats.error || 0) + 1; rows.push(`${h}\tERR\t${e.cause?.code || e.message}`); }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  say(`  alive sample ${sample.length}: ${JSON.stringify(stats)}`);
  fs.writeFileSync(path.join(out, 'alive-sample.tsv'), rows.join('\n'));
}


// 5) rate-limit experiments: n requests at a given concurrency; log status counts and the first non-200 response
for (const r of cfg.rate || []) {
  say(`== RATE ${r.url} n=${r.n} conc=${r.concurrency} delayMs=${r.delayMs || 0}`);
  const urls = r.urls || Array.from({ length: r.n }, () => r.url);
  const counts = {};
  let first = null;
  let idx = 0;
  const t0 = Date.now();
  const worker = async () => {
    while (idx < urls.length) {
      const u = urls[idx++];
      try {
        const res = await fetch(u, { headers: { 'user-agent': UA, 'accept-language': 'es' }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
        const body = await res.text();
        counts[res.status] = (counts[res.status] || 0) + 1;
        if (res.status !== 200 && !first) first = { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: body.slice(0, 1500) };
      } catch (e) { counts.err = (counts.err || 0) + 1; }
      if (r.delayMs) await new Promise((x) => setTimeout(x, r.delayMs));
    }
  };
  await Promise.all(Array.from({ length: r.concurrency }, worker));
  say(`  counts=${JSON.stringify(counts)} elapsed=${Date.now() - t0}ms`);
  if (first) say(`  first non-200: ${JSON.stringify(first)}`);
}


// 6) distinct-page crawl: take N product URLs from a store's sitemap and fetch them at a given concurrency
for (const c of cfg.crawl || []) {
  say(`== CRAWL ${c.sitemap} n=${c.n} conc=${c.concurrency}`);
  const sm = await get(c.sitemap, { max: 10 });
  const urls = locsOf(sm.text).filter(isProduct).slice(0, c.n);
  const counts = {};
  const lat = [];
  let first = null;
  let idx = 0;
  const t0 = Date.now();
  const worker = async () => {
    while (idx < urls.length) {
      const u = urls[idx++];
      const t1 = Date.now();
      try {
        const res = await fetch(u, { headers: { 'user-agent': UA, 'accept-language': 'es' }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
        const body = await res.text();
        counts[res.status] = (counts[res.status] || 0) + 1;
        lat.push(Date.now() - t1);
        if (res.status !== 200 && !first) first = { url: u, status: res.status, headers: Object.fromEntries(res.headers.entries()), body: body.slice(0, 600) };
      } catch (e) { counts.err = (counts.err || 0) + 1; }
    }
  };
  await Promise.all(Array.from({ length: c.concurrency }, worker));
  lat.sort((a, b) => a - b);
  say(`  urls=${urls.length} counts=${JSON.stringify(counts)} elapsed=${Date.now() - t0}ms p50=${lat[Math.floor(lat.length / 2)]}ms p95=${lat[Math.floor(lat.length * 0.95)]}ms`);
  if (first) say(`  first non-200: ${JSON.stringify(first)}`);
}


// 7) paced crawl experiments: constant request rate on uncached product pages, measure when Cloudflare starts challenging
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitClear(checkUrl, label) {
  const t0 = Date.now();
  let ok = 0;
  while (Date.now() - t0 < 300000) {
    try {
      const res = await fetch(checkUrl, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
      await res.arrayBuffer();
      ok = res.status === 200 ? ok + 1 : 0;
    } catch { ok = 0; }
    if (ok >= 3) break;
    await sleepMs(3000);
  }
  say(`  [${label}] clear after ${Math.round((Date.now() - t0) / 1000)}s (ok streak ${ok})`);
}
for (const c of cfg.paced || []) {
  say(`== PACED ${c.sitemap} rps=${c.rps} seconds=${c.seconds} offset=${c.offset || 0}`);
  await waitClear(cfg.checkUrl, 'before');
  const sm = await get(c.sitemap, { max: 10 });
  const urls = locsOf(sm.text).filter(isProduct).slice(c.offset || 0, (c.offset || 0) + c.rps * c.seconds);
  const results = [];
  let streak = 0;
  let stop = false;
  const t0 = Date.now();
  const inflight = [];
  for (let i = 0; i < urls.length && !stop; i++) {
    const due = t0 + (i * 1000) / c.rps;
    const wait = due - Date.now();
    if (wait > 0) await sleepMs(wait);
    const u = urls[i];
    inflight.push((async () => {
      const t1 = Date.now();
      try {
        const res = await fetch(u, { headers: { 'user-agent': UA, 'accept-language': 'es' }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
        await res.arrayBuffer();
        results.push({ i, t: t1 - t0, status: res.status, ms: Date.now() - t1, cache: res.headers.get('cf-cache-status') || '' });
        streak = res.status === 429 ? streak + 1 : 0;
        if (streak >= 8) stop = true;
      } catch (e) { results.push({ i, t: t1 - t0, status: 0, ms: 0 }); }
    })());
  }
  await Promise.all(inflight);
  results.sort((a, b) => a.i - b.i);
  const first429 = results.find((r) => r.status === 429);
  const counts = {};
  const caches = {};
  for (const r of results) { counts[r.status] = (counts[r.status] || 0) + 1; caches[r.cache] = (caches[r.cache] || 0) + 1; }
  say(`  sent=${results.length}/${urls.length} counts=${JSON.stringify(counts)} cache=${JSON.stringify(caches)} first429=${first429 ? `request#${first429.i} at ${Math.round(first429.t / 1000)}s` : 'none'} stoppedEarly=${stop}`);
}
if (cfg.paced && cfg.paced.length) await waitClear(cfg.checkUrl, 'final');

fs.writeFileSync(path.join(out, 'summary.txt'), log.join('\n') + '\n');
