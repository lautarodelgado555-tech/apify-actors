import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const targets = JSON.parse(fs.readFileSync('recon/targets.json', 'utf8'));
fs.mkdirSync('recon/out', { recursive: true });
for (const f of fs.readdirSync('recon/out')) if (f !== '.keep') fs.rmSync(`recon/out/${f}`, { recursive: true });

const title = (t) => (t.match(/<title>([^<]*)/i) || [])[1] || '-';
const save = (name, text) => fs.writeFileSync(`recon/out/${name}.html`, text);
const log = (...a) => console.log(...a);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

async function settle(page) {
  for (let i = 0; i < 12; i++) {
    if (!/just a moment/i.test(await page.title())) break;
    await page.waitForTimeout(2500);
  }
  return { status: 200, text: await page.content() };
}

const strategies = {
  async fetch(t) {
    const res = await fetch(t.url, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' },
      redirect: 'manual',
    });
    return { status: res.status, text: await res.text() };
  },
  async gotScraping(t) {
    const { gotScraping } = require('got-scraping');
    const res = await gotScraping({
      url: t.url,
      headerGeneratorOptions: { browsers: [{ name: 'chrome', minVersion: 120 }], operatingSystems: ['windows'] },
      throwHttpErrors: false,
      timeout: { request: 30000 },
    });
    return { status: res.statusCode, text: res.body };
  },
  async impit(t) {
    const { Impit } = require('impit');
    const impit = new Impit({ browser: 'chrome' });
    const res = await impit.fetch(t.url);
    return { status: res.status, text: await res.text() };
  },
  async chromium(t) {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      return await settle(page);
    } finally {
      await browser.close();
    }
  },
  async firefox(t) {
    const { firefox } = require('playwright');
    const browser = await firefox.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      return await settle(page);
    } finally {
      await browser.close();
    }
  },
};

for (const t of targets) {
  for (const s of t.strategies || ['fetch']) {
    const started = Date.now();
    try {
      const { status, text } = await strategies[s](t);
      save(`${t.name}.${s}`, text);
      log(`${t.name} [${s}] status=${status} len=${text.length} title="${title(text)}" ${Date.now() - started}ms`);
    } catch (e) {
      log(`${t.name} [${s}] ERROR ${String(e.message).split('\n')[0]}`);
    }
  }
}
