// Generic page/API fetcher for reconnaissance. Runs in GitHub Actions (the dev shell has no internet).
// Usage: node scripts/recon.mjs recon/<actor>/targets.json   -> writes recon/<actor>/out/*
// targets.json: [{ "name": "wa-detail", "url": "...", "method": "GET|POST", "headers": {..}, "json": {..} | "body": "..",
//                  "strategies": ["fetch","gotScraping","impit","chromium","firefox"], "waitFor": "css selector (browser only)",
//                  "actions": [ {"fill":"#sel","value":"x"}, {"press":"#sel","key":"Enter"}, {"click":"#sel"}, {"wait":2000} ] (browser only) }]
// Output: out/<name>.<strategy>.html (or .json when the body parses as JSON) + out/summary.txt
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const targetsFile = process.argv[2];
if (!targetsFile) throw new Error('usage: node scripts/recon.mjs <targets.json>');
const outDir = path.join(path.dirname(targetsFile), 'out');
const targets = JSON.parse(fs.readFileSync(targetsFile, 'utf8'));
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const title = (t) => (t.match(/<title>([^<]*)/i) || [])[1] || '-';
const MAX_SAVE = 2_000_000;
const save = (name, strategy, text) => {
  let ext = 'html';
  try { JSON.parse(text); ext = 'json'; } catch {}
  fs.writeFileSync(path.join(outDir, `${name}.${strategy}.${ext}`), text.slice(0, MAX_SAVE));
};
const bodyOf = (t) => (t.json !== undefined ? JSON.stringify(t.json) : t.body);
const headersOf = (t) => ({
  'user-agent': UA,
  accept: 'text/html,application/xhtml+xml,application/json,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  ...(t.json !== undefined ? { 'content-type': 'application/json' } : {}),
  ...(t.headers || {}),
});

async function settle(page, t) {
  for (let i = 0; i < 12; i++) {
    if (!/just a moment/i.test(await page.title())) break;
    await page.waitForTimeout(2500);
  }
  for (const a of t.actions || []) {
    if (a.fill) await page.fill(a.fill, a.value);
    else if (a.press) await page.press(a.press, a.key);
    else if (a.click) await page.click(a.click);
    else if (a.wait) await page.waitForTimeout(a.wait);
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  }
  if (t.waitFor) await page.waitForSelector(t.waitFor, { timeout: 20000 }).catch(() => {});
  return { status: 200, text: await page.content() };
}

const strategies = {
  async fetch(t) {
    const res = await fetch(t.url, { method: t.method || 'GET', headers: headersOf(t), body: bodyOf(t), redirect: 'manual' });
    return { status: res.status, text: await res.text(), extra: res.headers.get('location') || '' };
  },
  async gotScraping(t) {
    const { gotScraping } = require('got-scraping');
    const res = await gotScraping({
      url: t.url, method: t.method || 'GET', body: bodyOf(t), headers: t.headers,
      headerGeneratorOptions: { browsers: [{ name: 'chrome', minVersion: 120 }], operatingSystems: ['windows'] },
      throwHttpErrors: false, timeout: { request: 30000 },
    });
    return { status: res.statusCode, text: res.body };
  },
  async impit(t) {
    const { Impit } = require('impit');
    const impit = new Impit({ browser: 'chrome' });
    const res = await impit.fetch(t.url, { method: t.method || 'GET', headers: t.headers, body: bodyOf(t) });
    return { status: res.status, text: await res.text() };
  },
  async chromium(t) { return browserRun('chromium', t); },
  async firefox(t) { return browserRun('firefox', t); },
};

async function browserRun(kind, t) {
  const browser = await require('playwright')[kind].launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    return await settle(page, t);
  } finally {
    await browser.close();
  }
}

const lines = [];
for (const t of targets) {
  for (const s of t.strategies || ['fetch']) {
    const started = Date.now();
    try {
      const { status, text, extra } = await strategies[s](t);
      save(t.name, s, text);
      lines.push(`${t.name} [${s}] status=${status} len=${text.length} title="${title(text)}" ${extra ? 'location=' + extra + ' ' : ''}${Date.now() - started}ms`);
    } catch (e) {
      lines.push(`${t.name} [${s}] ERROR ${String(e.message).split('\n')[0]}`);
    }
    console.log(lines[lines.length - 1]);
  }
}
fs.writeFileSync(path.join(outDir, 'summary.txt'), lines.join('\n') + '\n');
