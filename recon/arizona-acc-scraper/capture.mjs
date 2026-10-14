// Network capture for the Arizona Business Center SPA. Runs on a GitHub runner.
// usage: node recon/arizona-acc-scraper/capture.mjs  -> recon/arizona-acc-scraper/out/net-*.json
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const out = 'recon/arizona-acc-scraper/out';
fs.mkdirSync(out, { recursive: true });
const BASE = 'https://arizonabusinesscenter.azcc.gov';
const TERM = process.env.TERM_NAME || 'Banner Health';

async function run(kind) {
    const pw = require('playwright');
    const browser = await pw[kind].launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await ctx.newPage();
    const log = [];
    const scripts = new Set();
    page.on('request', (r) => {
        if (['xhr', 'fetch'].includes(r.resourceType())) {
            log.push({ t: 'req', method: r.method(), url: r.url(), post: (r.postData() || '').slice(0, 5000), headers: r.headers() });
        }
    });
    page.on('response', async (r) => {
        const req = r.request();
        if (req.resourceType() === 'script') scripts.add(r.url());
        if (!['xhr', 'fetch'].includes(req.resourceType())) return;
        let body = '';
        try { body = (await r.text()).slice(0, 300000); } catch {}
        log.push({ t: 'res', status: r.status(), url: r.url(), ctype: r.headers()['content-type'], body });
    });
    const step = async (name, fn) => {
        try { await fn(); } catch (e) { log.push({ t: 'error', step: name, msg: String(e.message).split('\n')[0] }); }
    };
    const snap = async (name) => {
        await page.screenshot({ path: path.join(out, `${kind}-${name}.png`), fullPage: true }).catch(() => {});
        fs.writeFileSync(path.join(out, `${kind}-${name}.html`), (await page.content()).slice(0, 1500000));
    };
    await step('goto', async () => { await page.goto(`${BASE}/businesssearch`, { waitUntil: 'networkidle', timeout: 60000 }); });
    for (let i = 0; i < 10 && /just a moment/i.test(await page.title()); i++) await page.waitForTimeout(2500);
    await page.waitForTimeout(4000);
    log.push({ t: 'info', title: await page.title(), url: page.url() });
    await snap('1-search');
    const inputs = await page.$$eval('input,select,textarea,button,a[role=button]', (els) => els.map((e) => ({ tag: e.tagName, type: e.type, id: e.id, name: e.name, ph: e.placeholder, aria: e.getAttribute('aria-label'), text: (e.innerText || '').slice(0, 60), cls: String(e.className).slice(0, 80) })));
    log.push({ t: 'inputs', inputs });
    await step('search', async () => {
        const box = page.locator('input[type=text],input[type=search],input:not([type])').first();
        await box.fill(TERM);
        await page.waitForTimeout(500);
        await box.press('Enter');
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(5000);
    });
    await snap('2-results');
    const links = await page.$$eval('a', (as) => as.map((a) => ({ href: a.href, text: (a.innerText || '').slice(0, 80) })).slice(0, 200));
    log.push({ t: 'links', links });
    fs.writeFileSync(path.join(out, `net-${kind}.json`), JSON.stringify(log, null, 1));
    fs.writeFileSync(path.join(out, `scripts-${kind}.txt`), [...scripts].join('\n'));
    const bundles = [...scripts].filter((u) => u.startsWith(BASE)).slice(0, 12);
    const hits = [];
    for (const u of bundles) {
        try {
            const txt = await (await ctx.request.get(u)).text();
            const m = txt.match(/["'`]\/?api\/[A-Za-z0-9_\/\-\.{}$]*/g) || [];
            hits.push({ u, size: txt.length, api: [...new Set(m)].slice(0, 200) });
        } catch (e) { hits.push({ u, err: String(e.message) }); }
    }
    fs.writeFileSync(path.join(out, `bundles-${kind}.json`), JSON.stringify(hits, null, 1));
    await browser.close();
}

for (const kind of (process.env.KINDS || 'chromium,firefox').split(',')) {
    await run(kind).catch((e) => fs.writeFileSync(path.join(out, `net-${kind}-ERROR.txt`), String(e.stack)));
}
