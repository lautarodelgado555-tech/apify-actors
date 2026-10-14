// Georgia eCorp spike: drive Firefox through a search, log every network request, save pages.
import fs from 'node:fs';
import pw from 'playwright';

const OUT = 'recon/georgia-sos-scraper/out';
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => { console.log(...a); };
const save = (name, text) => fs.writeFileSync(`${OUT}/${name}`, String(text).slice(0, 3_000_000));

const kind = process.env.BROWSER || 'firefox';
const browser = await pw[kind].launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
let seq = 0;
const netlog = [];
page.on('request', (r) => {
  if (!/ecorp\.sos\.ga\.gov/.test(r.url())) return;
  if (/\.(png|jpg|gif|css|woff2?|ico)(\?|$)/i.test(r.url())) return;
  netlog.push(`REQ ${r.method()} ${r.url()} type=${r.resourceType()} body=${(r.postData() || '').slice(0, 600)}`);
});
page.on('response', async (r) => {
  if (!/ecorp\.sos\.ga\.gov/.test(r.url())) return;
  if (/\.(png|jpg|gif|css|woff2?|ico|js)(\?|$)/i.test(r.url())) return;
  const rt = r.request().resourceType();
  let body = '';
  try { body = await r.text(); } catch {}
  netlog.push(`RES ${r.status()} ${r.url()} type=${rt} len=${body.length} ct=${r.headers()['content-type'] || ''}`);
  if (rt === 'xhr' || rt === 'fetch') save(`xhr-${String(++seq).padStart(2, '0')}.txt`, `${r.request().method()} ${r.url()}\n${r.request().postData() || ''}\n---\n${body}`);
});

async function passCf(label) {
  for (let i = 0; i < 24; i++) {
    const t = await page.title().catch(() => '');
    if (!/just a moment/i.test(t)) return true;
    await page.waitForTimeout(2500);
  }
  log(label, 'still on Cloudflare challenge');
  return false;
}
const snap = async (name) => save(name, await page.content());

try {
  await page.goto('https://ecorp.sos.ga.gov/BusinessSearch', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const ok = await passCf('home');
  log('cf passed:', ok, 'title:', await page.title());
  await snap('01-home.html');
  save('cookies-after-home.json', JSON.stringify(await ctx.cookies(), null, 1).replace(/"value": "[^"]{12,}"/g, (m) => m.slice(0, 20) + '..."'));
  if (!ok) throw new Error('blocked at home');

  // Search: Starts With "Delta Air Lines"
  await page.check('#rdStartsWith');
  await page.fill('#txtBusinessName', 'Delta Air Lines');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => log('nav err', e.message)), page.click('#btnSearch')]);
  await passCf('results');
  await page.waitForTimeout(5000);
  log('results url:', page.url(), 'title:', await page.title());
  await snap('02-results.html');

  // First link that looks like a detail link
  const links = await page.$$eval('a', (as) => as.map((a) => ({ t: a.textContent.trim().slice(0, 80), h: a.getAttribute('href'), oc: a.getAttribute('onclick') })).filter((x) => x.h || x.oc));
  save('02-links.json', JSON.stringify(links, null, 1));
  const cand = await page.$('a:has-text("DELTA AIR LINES")');
  if (cand) {
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => log('nav2 err', e.message)), cand.click()]);
    await passCf('detail');
    await page.waitForTimeout(4000);
    log('detail url:', page.url(), 'title:', await page.title());
    await snap('03-detail.html');
    const dl = await page.$$eval('a,button,input[type=button]', (as) => as.map((a) => ({ t: (a.textContent || a.value || '').trim().slice(0, 80), h: a.getAttribute('href'), oc: a.getAttribute('onclick') })).filter((x) => x.h || x.oc));
    save('03-detail-links.json', JSON.stringify(dl, null, 1));
    // Filing history
    const fh = await page.$('a:has-text("Filing History"), input[value*="Filing"], button:has-text("Filing History")');
    if (fh) {
      await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => log('nav3 err', e.message)), fh.click()]);
      await page.waitForTimeout(4000);
      await snap('04-filing-history.html');
      log('filing history url:', page.url());
    } else log('no filing history link');
  } else log('no DELTA AIR LINES link on results');

  // Second search: control number via a fresh home load
  await page.goto('https://ecorp.sos.ga.gov/BusinessSearch', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await passCf('home2');
  await page.click('#rdBusinessName');
  await page.fill('#txtBusinessName', 'zzzqqxx nonexistent');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}), page.click('#btnSearch')]);
  await page.waitForTimeout(4000);
  await snap('05-noresults.html');
} catch (e) {
  log('ERROR', e.message);
  try { await snap('99-error.html'); } catch {}
}
save('netlog.txt', netlog.join('\n'));
save('cookies-final.json', JSON.stringify((await ctx.cookies()).map((c) => ({ name: c.name, domain: c.domain, path: c.path, httpOnly: c.httpOnly, len: c.value.length })), null, 1));
await browser.close();
