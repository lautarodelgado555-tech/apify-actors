// Spike round 4 (runner = datacenter IP). Questions:
//  A) Does a real browser that arrives at an item page by clicking a card on an open official-store page get the item or the login wall?
//  B) Which JSON endpoints does the open official-store page use (apiBasePath .../tienda/<slug>/api), and are they open from a datacenter IP?
//  C) Which other pages are open (home, offers)?
// Output: recon/mercadolibre-monitor/out/r4/*
import fs from 'node:fs';
import path from 'node:path';
import { gotScraping } from 'got-scraping';

const OUT = 'recon/mercadolibre-monitor/out/r4';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const report = { flows: [], bundles: [], api: [], open: [] };
const save = (name, text) => fs.writeFileSync(path.join(OUT, name), String(text).slice(0, 3_000_000));
const titleOf = (t) => ((t.match(/<title[^>]*>([^<]*)/i) || [])[1] || '').trim().slice(0, 80);
const WALL = /gz\/account-verification|Para continuar, ingresa a tu cuenta/i;

async function get(url, headers = {}) {
  try {
    const res = await gotScraping({ url, throwHttpErrors: false, followRedirect: true, timeout: { request: 30000 }, retry: { limit: 0 }, headers: { 'accept-language': 'es-AR,es;q=0.9', ...headers },
      headerGeneratorOptions: { browsers: [{ name: 'chrome', minVersion: 120 }], operatingSystems: ['windows'], locales: ['es-AR', 'es'] } });
    return { status: res.statusCode, text: res.body || '', finalUrl: res.url, ct: res.headers['content-type'] };
  } catch (e) { return { status: 0, text: '', finalUrl: url, error: String(e.message).slice(0, 100) }; }
}

// ---- B. bundles and API paths
const store = await get('https://www.mercadolibre.com.ar/tienda/bgh');
save('store-bgh.html', store.text);
const scripts = [...new Set([...store.text.matchAll(/src="(https:\/\/http2\.mlstatic\.com\/frontend-assets\/mshops-web-home\/[^"]+\.js)"/g)].map((m) => m[1]))];
log('store status', store.status, 'bundles', scripts.length);
const apiPaths = new Map();
for (const s of scripts.slice(0, 8)) {
  const r = await get(s);
  report.bundles.push({ s, status: r.status, len: r.text.length });
  save(`bundle-${path.basename(s)}`, r.text);
  for (const m of r.text.matchAll(/["'`](\/?(?:api|tienda)[A-Za-z0-9_\-/{}$.:?=&]{3,120})["'`]/g)) apiPaths.set(m[1], (apiPaths.get(m[1]) || 0) + 1);
  for (const m of r.text.matchAll(/["'`]((?:\/)?(?:items|search|products|component|components|home|catalog|listing)[A-Za-z0-9_\-/{}$.:?=&]{0,100})["'`]/g)) apiPaths.set(m[1], (apiPaths.get(m[1]) || 0) + 1);
}
report.apiPaths = [...apiPaths.keys()].slice(0, 200);
log('api path candidates', apiPaths.size);
const base = 'https://www.mercadolibre.com.ar/tienda/bgh/api';
const guesses = ['', '/home', '/search', '/items', '/products', '/components', '/sections/home', '/storefront', '/listing', '/search?limit=5', '/items?limit=5', ...[...apiPaths.keys()].filter((p) => /^\/?api\//.test(p)).slice(0, 25).map((p) => p.replace(/^\/?api/, ''))];
for (const g of [...new Set(guesses)].slice(0, 45)) {
  const r = await get(base + g, { accept: 'application/json' });
  report.api.push({ g, status: r.status, ct: r.ct, len: r.text.length, head: r.text.slice(0, 120).replace(/\s+/g, ' ') });
}
log('api tested', report.api.length);

// ---- C. open pages
for (const u of ['https://www.mercadolibre.com.ar/', 'https://www.mercadolibre.com.ar/ofertas/supermercado', 'https://www.mercadolibre.com.ar/ofertas/farmacia', 'https://www.mercadolibre.com.ar/tienda/samsung', 'https://www.mercadolibre.com.ar/tienda/adidas', 'https://www.mercadolibre.com.mx/tiendas-oficiales', 'https://www.mercadolivre.com.br/lojas-oficiais', 'https://www.mercadolibre.com.mx/', 'https://www.mercadolivre.com.br/', 'https://www.mercadolibre.cl/', 'https://www.mercadolibre.com.co/']) {
  const r = await get(u);
  report.open.push({ u, status: r.status, len: r.text.length, wall: WALL.test(r.text) || WALL.test(r.finalUrl), cards: (r.text.match(/poly-card__content/g) || []).length, title: titleOf(r.text), finalUrl: r.finalUrl.slice(0, 100) });
  if (r.status === 200 && !WALL.test(r.finalUrl) && r.text.length > 60000) save(`open-${u.replace(/[^a-z0-9]/gi, '_').slice(8, 60)}.html`, r.text);
}
log('open pages', JSON.stringify(report.open.map((o) => [o.u.slice(8, 50), o.status, o.len, o.wall, o.cards])));

// ---- A. click-through flow in a real browser
try {
  const pw = await import('playwright');
  for (const kind of ['firefox', 'chromium']) {
    let browser;
    try {
      browser = await pw[kind].launch({ headless: true });
      const ctx = await browser.newContext({ locale: 'es-AR', timezoneId: 'America/Argentina/Buenos_Aires', viewport: { width: 1366, height: 850 } });
      const page = await ctx.newPage();
      await page.goto('https://www.mercadolibre.com.ar/tienda/bgh', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(3000);
      const open1 = { title: await page.title(), url: page.url() };
      const link = await page.$('a.poly-component__title');
      const href = link ? await link.getAttribute('href') : null;
      let after = null;
      if (link) {
        await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}), link.click()]);
        await page.waitForTimeout(8000);
        const html = await page.content();
        after = { url: page.url().slice(0, 160), title: await page.title(), wall: WALL.test(html) || WALL.test(page.url()), len: html.length, pdp: /ui-pdp/.test(html), ld: (html.match(/application\/ld\+json/g) || []).length };
        save(`flow-${kind}-after-click.html`, html);
      }
      report.flows.push({ kind, open1, href: href && href.slice(0, 160), after });
      log('flow', kind, JSON.stringify(after));
    } catch (e) { report.flows.push({ kind, error: String(e.message).split('\n')[0].slice(0, 200) }); }
    finally { await browser?.close(); }
  }
} catch (e) { report.flows.push({ error: String(e.message).slice(0, 200) }); }

fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
console.log('done');
