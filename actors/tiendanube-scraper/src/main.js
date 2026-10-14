import crypto from 'node:crypto';
import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import {
    buildProductItem,
    isChallengePage,
    looksLikeTiendanube,
    maybeGunzip,
    normalizeInput,
    parseListingLinks,
    parseProductPage,
    parseRobots,
    parseSince,
    parseSitemap,
    parseStoreProfile,
    extractContacts,
    productEntries,
    productSlug,
    snapshotDecision,
} from './tiendanube.js';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'catalog',
    stores = [],
    maxProductsPerStore = 100,
    includeDescriptionHtml = false,
    onlyInStock = false,
    keywords = [],
    since,
    incrementalStoreName,
    maxConcurrency = 8,
    maxConcurrencyPerStore = 4,
    requestsPerSecond = 3,
    proxyConfiguration,
} = input;

const FREE_PLAN_CAP = 10;
const isPaying = process.env.APIFY_USER_IS_PAYING === '1';
const runCap = isPaying ? Infinity : FREE_PLAN_CAP;
const DEBUG = process.env.ACTOR_DEBUG === '1';

const targets = [];
const invalidInputs = [];
for (const raw of [...new Set((stores ?? []).map((s) => String(s ?? '').trim()).filter(Boolean))]) {
    const n = normalizeInput(raw);
    if (n) targets.push({ raw, ...n });
    else invalidInputs.push(raw);
}
if (!targets.length && !invalidInputs.length) {
    await Actor.fail('Input "stores" must contain at least one Tiendanube / Nuvemshop store URL or domain.');
}
if (!['catalog', 'storeProfile'].includes(mode)) await Actor.fail(`Unknown mode "${mode}". Use "catalog" or "storeProfile".`);
const sinceMs = parseSince(since);
if (since && sinceMs === null) await Actor.fail(`Could not understand "since": ${since}. Use an ISO date (2026-10-01) or something like "7 days".`);
const kw = (keywords ?? []).map((k) => String(k).trim().toLowerCase()).filter(Boolean);

const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration(proxyConfiguration) : undefined;
const isPayPerEvent = Actor.getChargingManager().getPricingInfo().isPayPerEvent;

// Survives migrations: what was already emitted (so nothing is charged twice) and run totals.
const state = await Actor.useState('STATE', { emitted: {}, pushed: 0, chargeLimitReached: false });
const summaries = [];
let stopAll = false;

if (!isPaying) log.info(`Free plan: this run returns at most ${FREE_PLAN_CAP} results. Upgrade to a paid Apify plan to remove the cap.`);
for (const raw of invalidInputs) {
    log.warning(`Skipping "${raw}": not a valid URL or domain.`);
    summaries.push({ input: raw, status: 'invalid_input', products: 0 });
}

// ------------------------------------------------------------------ networking

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Semaphore {
    constructor(n) {
        this.n = n;
        this.queue = [];
    }

    async acquire() {
        if (this.n > 0) {
            this.n -= 1;
            return;
        }
        await new Promise((resolve) => this.queue.push(resolve));
    }

    release() {
        const next = this.queue.shift();
        if (next) next();
        else this.n += 1;
    }
}

const globalSlots = new Semaphore(Math.max(1, maxConcurrency));
const hosts = new Map();
function hostOf(host) {
    if (!hosts.has(host)) hosts.set(host, { slots: new Semaphore(Math.max(1, maxConcurrencyPerStore)), challenges: 0 });
    return hosts.get(host);
}

const stats = { requests: 0, retries: 0, throttled: 0, blocked: 0 };

// Tiendanube's edge rate-limits per IP across ALL stores (measured from GitHub runners: about 2 uncached pages
// per second are always fine, around 4 per second starts answering 429 for 6-9 seconds). One shared pacer for the
// whole run keeps the request rate just under that: it slows down after a 429, pauses for a few seconds and speeds
// up slowly again while everything succeeds.
const pacer = {
    rate: Math.max(0.2, requestsPerSecond),
    max: Math.min(30, Math.max(requestsPerSecond * 2, 6)),
    nextSlot: 0,
    pauseUntil: 0,
    okStreak: 0,
    throttleStreak: 0,
};
async function pace() {
    const now = Date.now();
    const at = Math.max(now, pacer.nextSlot, pacer.pauseUntil);
    pacer.nextSlot = at + 1000 / pacer.rate;
    if (at > now) await sleep(at - now);
}
function onThrottle(retryAfterSecs) {
    pacer.rate = Math.max(0.5, pacer.rate * 0.6);
    const pause = retryAfterSecs > 0 ? Math.min(retryAfterSecs, 60) * 1000 : 8000 + Math.random() * 4000;
    pacer.pauseUntil = Math.max(pacer.pauseUntil, Date.now() + pause);
    pacer.okStreak = 0;
    pacer.throttleStreak += 1;
    stats.throttled += 1;
}
function onOk() {
    pacer.throttleStreak = 0;
    pacer.okStreak += 1;
    if (pacer.okStreak >= 25) {
        pacer.okStreak = 0;
        pacer.rate = Math.min(pacer.max, pacer.rate * 1.2);
    }
}

/** GET with retries. Never throws. Returns { status, body, url, blocked, error }. */
async function fetchPage(url) {
    const host = new URL(url).host;
    const hs = hostOf(host);
    await hs.slots.acquire();
    await globalSlots.acquire();
    try {
        let lastError = null;
        for (let attempt = 0; attempt < 8; attempt += 1) {
            await pace();
            stats.requests += 1;
            let res;
            try {
                res = await gotScraping({
                    url,
                    proxyUrl: proxyConf ? await proxyConf.newUrl() : undefined,
                    responseType: 'buffer',
                    throwHttpErrors: false,
                    followRedirect: true,
                    timeout: { request: 30000 },
                    retry: { limit: 0 },
                    headers: { 'accept-language': 'es-AR,es;q=0.9,pt-BR;q=0.8,en;q=0.5' },
                });
            } catch (e) {
                lastError = e.code || e.message;
                stats.retries += 1;
                // DNS failures mean the domain does not exist: no point in retrying
                if (lastError === 'ENOTFOUND' || attempt >= 3) break;
                await sleep(600 * 2 ** attempt);
                continue;
            }
            const { statusCode: status } = res;
            if (status === 429 || status === 503 || status === 502 || status === 504) {
                onThrottle(Number(res.headers['retry-after']));
                stats.retries += 1;
                lastError = `HTTP ${status}`;
                if (pacer.throttleStreak >= 12) {
                    // twelve rate-limit answers in a row without a single success: this IP is being blocked
                    stats.blocked += 1;
                    return { status, body: '', url: res.url, blocked: true };
                }
                continue;
            }
            const body = maybeGunzip(res.body).toString('utf8');
            if (status === 403 || (status === 200 && isChallengePage(body))) {
                hs.challenges += 1;
                stats.blocked += 1;
                return { status, body: '', url: res.url, blocked: true };
            }
            onOk();
            return { status, body, url: res.url };
        }
        return { status: 0, body: '', url, error: lastError };
    } finally {
        globalSlots.release();
        hs.slots.release();
    }
}

async function mapPool(items, limit, fn) {
    let i = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        while (!stopAll) {
            const idx = i;
            i += 1;
            if (idx >= items.length) return;
            await fn(items[idx], idx);
        }
    });
    await Promise.all(workers);
}

// ------------------------------------------------------------------ emitting

// Emits are serialized so the free-plan cap and the charge limit are exact even with parallel workers.
let emitChain = Promise.resolve();
function emit(eventName, item) {
    const run = emitChain.then(() => emitNow(eventName, item));
    emitChain = run.catch(() => {});
    return run;
}

async function emitNow(eventName, item) {
    if (stopAll) return false;
    if (state.pushed >= runCap) {
        stopAll = true;
        log.warning(`Free plan cap of ${FREE_PLAN_CAP} results reached. Stopping.`);
        return false;
    }
    if (isPayPerEvent) {
        const { eventChargeLimitReached, chargedCount } = await Actor.charge({ eventName });
        if (chargedCount === 0) {
            stopAll = true;
            state.chargeLimitReached = true;
            log.warning('Reached the maximum charge for this run. Stopping; raise the limit to get more results.');
            return false;
        }
        if (eventChargeLimitReached) {
            stopAll = true;
            state.chargeLimitReached = true;
            log.warning('Next result would exceed the charge limit; this is the last one.');
        }
    }
    await Actor.pushData(item);
    state.pushed += 1;
    return true;
}

// ------------------------------------------------------------------ discovery

const BLOG_SITEMAP = /blog/i;

async function collectSitemapEntries(origin, robotsSitemaps) {
    const queue = [...new Set([...robotsSitemaps.filter((u) => !BLOG_SITEMAP.test(u)), `${origin}/sitemap.xml`])].map((u) => ({ u, depth: 0 }));
    const seenMaps = new Set();
    const entries = [];
    let fetched = 0;
    while (queue.length && fetched < 25) {
        const { u, depth } = queue.shift();
        if (seenMaps.has(u)) continue;
        seenMaps.add(u);
        fetched += 1;
        const r = await fetchPage(u);
        if (r.status !== 200 || !r.body || !/<(urlset|sitemapindex)/i.test(r.body)) continue;
        const sm = parseSitemap(r.body);
        if (sm.isIndex) {
            if (depth < 2) for (const e of sm.entries) if (!BLOG_SITEMAP.test(e.loc)) queue.push({ u: e.loc, depth: depth + 1 });
        } else {
            entries.push(...sm.entries);
            if (productEntries(sm.entries).length) break; // the main sitemap listed products; no need for the fallbacks
        }
    }
    return entries;
}

async function crawlListing(startUrl, maxProducts) {
    const found = new Map();
    const maxPages = Math.min(300, Math.ceil(maxProducts / 8) + 1);
    for (let page = 1; page <= maxPages && !stopAll; page += 1) {
        const u = new URL(startUrl);
        if (page > 1) u.searchParams.set('page', String(page));
        const r = await fetchPage(u.href);
        if (r.status !== 200 || !r.body) break;
        const links = parseListingLinks(r.body, r.url);
        const before = found.size;
        for (const l of links) if (!found.has(productSlug(l))) found.set(productSlug(l), { loc: l, lastmod: null, images: [] });
        if (found.size === before || found.size >= maxProducts) break;
    }
    return [...found.values()];
}

/** Check the origin really is a Tiendanube / Nuvemshop storefront. Returns { ok, origin, reason, robots }. */
async function verifyStore(target) {
    const robots = await fetchPage(`${target.origin}/robots.txt`);
    if (robots.blocked) return { ok: false, reason: 'blocked' };
    if (robots.status === 200 && robots.body) {
        const parsed = parseRobots(robots.body);
        const origin = new URL(robots.url).origin;
        if (parsed.isTiendanube) return { ok: true, origin, robots: parsed };
    }
    const home = await fetchPage(`${target.origin}/`);
    if (home.blocked) return { ok: false, reason: 'blocked' };
    if (home.status === 410 || home.status === 404) return { ok: false, reason: 'store_not_found' };
    if (home.status !== 200) return { ok: false, reason: home.error === 'ENOTFOUND' ? 'domain_not_found' : `http_${home.status || home.error || 'error'}` };
    if (!looksLikeTiendanube(home.body)) return { ok: false, reason: 'not_tiendanube' };
    return { ok: true, origin: new URL(home.url).origin, robots: robots.status === 200 ? parseRobots(robots.body) : { sitemaps: [] }, home };
}

// ------------------------------------------------------------------ incremental snapshots

const snapshotStore = incrementalStoreName ? await Actor.openKeyValueStore(incrementalStoreName) : null;
const short = (s) => crypto.createHash('sha1').update(s).digest('base64url').slice(0, 10);

// ------------------------------------------------------------------ catalog mode

const matchesKeywords = (item) => {
    if (!kw.length) return true;
    const hay = [item.name, item.brand, item.url, ...(item.categories ?? []), ...(item.tags ?? [])].join(' ').toLowerCase();
    return kw.some((k) => hay.includes(k));
};

async function processCatalogStore(target) {
    const summary = { input: target.raw, status: 'ok', discovered: 0, examined: 0, products: 0, unchanged: 0, skipped: 0, failed: 0 };
    summaries.push(summary);
    let entries;
    let origin = target.origin;
    if (target.kind === 'product') {
        entries = [{ loc: target.url, lastmod: null, images: [] }];
    } else {
        const v = await verifyStore(target);
        if (!v.ok) {
            summary.status = v.reason;
            log.warning(`${target.raw}: ${v.reason === 'blocked' ? 'the site served a bot-check / 403 page; stopping for this store (nothing charged).' : `not usable (${v.reason}).`}`);
            return;
        }
        origin = v.origin;
        if (target.kind === 'listing') {
            entries = await crawlListing(`${origin}${new URL(target.url).pathname}${new URL(target.url).search}`, maxProductsPerStore);
        } else {
            entries = productEntries(await collectSitemapEntries(origin, v.robots?.sitemaps ?? []));
            if (!entries.length) {
                log.info(`${target.raw}: no products in the sitemap, falling back to the catalog pages.`);
                entries = await crawlListing(`${origin}/productos/`, maxProductsPerStore);
                if (!entries.length) entries = await crawlListing(`${origin}/produtos/`, maxProductsPerStore);
            }
        }
    }
    summary.discovered = entries.length;
    if (sinceMs) entries = entries.filter((e) => e.lastmod === null || e.lastmod >= sinceMs);
    // Most recently changed first, so a small maxProductsPerStore still yields the freshest products.
    if (entries.some((e) => e.lastmod)) entries.sort((a, b) => (b.lastmod ?? 0) - (a.lastmod ?? 0));
    entries = entries.slice(0, maxProductsPerStore);
    summary.examined = entries.length;
    log.info(`${target.raw}: ${summary.discovered} products found, examining ${entries.length}.`);

    const host = new URL(origin).host;
    const snapKey = `snapshot-${host}`;
    const snapshot = snapshotStore ? (await snapshotStore.getValue(snapKey)) ?? {} : null;
    let dirty = 0;

    await mapPool(entries, maxConcurrencyPerStore, async (entry) => {
        const url = entry.loc;
        const slug = productSlug(url);
        if (state.emitted[url]) return;
        const r = await fetchPage(url);
        if (r.blocked) {
            summary.failed += 1;
            if (hostOf(new URL(url).host).challenges >= 3) {
                summary.status = 'blocked';
                stopAll = true;
                log.error(`${target.raw}: repeated bot-check / 403 responses. Stopping (fail closed).`);
            }
            return;
        }
        if (r.status !== 200 || !r.body) {
            if (r.status === 404 || r.status === 410) summary.skipped += 1;
            else summary.failed += 1;
            if (DEBUG) log.debug(`${url} -> ${r.status} ${r.error ?? ''}`);
            return;
        }
        let parsed;
        try {
            parsed = parseProductPage(r.body, r.url);
        } catch (e) {
            log.warning(`Could not parse ${url}: ${e.message}`);
            summary.failed += 1;
            return;
        }
        if (!parsed || !parsed.name) {
            summary.skipped += 1; // not a product page (deleted or hidden products answer 200 with a 404 template)
            return;
        }
        const item = buildProductItem(parsed, { url: r.url.split('#')[0].split('?')[0], store: null, lastmod: entry.lastmod, scrapedAt: new Date().toISOString() });
        if (!includeDescriptionHtml) delete item.descriptionHtml;
        if (onlyInStock && !item.inStock) {
            summary.skipped += 1;
            return;
        }
        if (!matchesKeywords(item)) {
            summary.skipped += 1;
            return;
        }
        if (snapshot) {
            const decision = snapshotDecision(snapshot, slug, item, short);
            if (decision.skip) {
                summary.unchanged += 1;
                return;
            }
            item.changeType = decision.changeType;
            if (await emit('product', item)) {
                snapshot[slug] = decision.fp;
                summary.products += 1;
                state.emitted[url] = 1;
                dirty += 1;
                if (dirty % 100 === 0) await snapshotStore.setValue(snapKey, snapshot);
            }
            return;
        }
        if (await emit('product', item)) {
            summary.products += 1;
            state.emitted[url] = 1;
        }
    });
    if (snapshot) await snapshotStore.setValue(snapKey, snapshot);
    log.info(`${target.raw}: ${summary.products} saved, ${summary.unchanged} unchanged, ${summary.skipped} skipped, ${summary.failed} failed.`);
    await Actor.setStatusMessage(`${state.pushed} results so far`);
}

// ------------------------------------------------------------------ storeProfile mode

async function processProfile(target) {
    const summary = { input: target.raw, status: 'ok', products: 0 };
    summaries.push(summary);
    const home = await fetchPage(`${target.origin}/`);
    if (home.blocked) {
        summary.status = 'blocked';
        log.warning(`${target.raw}: bot-check / 403 page. Nothing charged.`);
        return;
    }
    if (home.status === 410 || home.status === 404) {
        summary.status = 'store_not_found';
        log.warning(`${target.raw}: store not found or closed (HTTP ${home.status}).`);
        return;
    }
    if (home.status !== 200) {
        summary.status = home.error === 'ENOTFOUND' ? 'domain_not_found' : `http_${home.status || home.error || 'error'}`;
        log.warning(`${target.raw}: not reachable (${summary.status}).`);
        return;
    }
    const origin = new URL(home.url).origin;
    const robots = await fetchPage(`${origin}/robots.txt`);
    const robotsInfo = robots.status === 200 ? parseRobots(robots.body) : { sitemaps: [], isTiendanube: false };
    if (!robotsInfo.isTiendanube && !looksLikeTiendanube(home.body)) {
        summary.status = 'not_tiendanube';
        log.warning(`${target.raw}: this does not look like a Tiendanube / Nuvemshop store.`);
        return;
    }
    const profile = parseStoreProfile(home.body);
    const contacts = profile.contacts;
    // Contact page: the e-mail address usually only lives there.
    for (const path of ['/contacto/', '/contato/']) {
        const c = await fetchPage(`${origin}${path}`);
        if (c.status === 200 && c.body && !c.blocked) {
            const extra = extractContacts(c.body);
            contacts.emails = [...new Set([...contacts.emails, ...extra.emails])];
            contacts.phones = [...new Set([...contacts.phones, ...extra.phones])];
            contacts.whatsapp = [...new Set([...contacts.whatsapp, ...extra.whatsapp])];
            contacts.socials = { ...extra.socials, ...contacts.socials };
            break;
        }
    }
    const products = productEntries(await collectSitemapEntries(origin, robotsInfo.sitemaps));
    const lastMods = products.map((p) => p.lastmod).filter(Boolean);
    const host = new URL(origin).hostname;
    const row = {
        url: origin,
        domain: host.replace(/^www\./, ''),
        name: profile.name,
        platform: /\.com\.br$/i.test(host) || profile.country === 'BR' ? 'nuvemshop' : 'tiendanube',
        country: profile.country,
        currency: profile.currency,
        language: profile.language,
        description: profile.description,
        logo: profile.logo,
        emails: contacts.emails,
        phones: contacts.phones,
        whatsapp: contacts.whatsapp,
        instagram: contacts.socials.instagram ?? null,
        facebook: contacts.socials.facebook ?? null,
        tiktok: contacts.socials.tiktok ?? null,
        youtube: contacts.socials.youtube ?? null,
        twitter: contacts.socials.twitter ?? null,
        pinterest: contacts.socials.pinterest ?? null,
        linkedin: contacts.socials.linkedin ?? null,
        businessName: profile.business?.name ?? null,
        businessAddress: profile.business?.address ?? null,
        productCount: products.length,
        lastProductUpdate: lastMods.length ? new Date(Math.max(...lastMods)).toISOString() : null,
        createdAt: profile.createdAt ?? null,
        engine: profile.engine,
        scrapedAt: new Date().toISOString(),
    };
    if (await emit('store', row)) summary.products = 1;
}

// ------------------------------------------------------------------ run

const worker = mode === 'storeProfile' ? processProfile : processCatalogStore;
await mapPool(targets, mode === 'storeProfile' ? Math.max(1, maxConcurrency) : 2, async (t) => {
    try {
        await worker(t);
    } catch (e) {
        log.error(`${t.raw}: unexpected error: ${e.message}`);
        const s = summaries.find((x) => x.input === t.raw);
        if (s) s.status = 'error';
    }
});

await Actor.setValue('OUTPUT', { mode, results: state.pushed, stores: summaries, requests: stats, finishedAt: new Date().toISOString() });
log.info(`Done. ${state.pushed} results from ${targets.length} input(s). Requests: ${stats.requests} (${stats.throttled} throttled, ${stats.blocked} blocked).`);

const blocked = summaries.filter((s) => s.status === 'blocked');
if (!state.pushed && blocked.length) {
    await Actor.fail(`The source blocked the run (bot-check / 403) for: ${blocked.map((b) => b.input).join(', ')}. Nothing was charged.`);
} else {
    const bad = summaries.filter((s) => s.status !== 'ok');
    await Actor.exit(bad.length ? { statusMessage: `${state.pushed} results. ${bad.length} input(s) not usable: ${bad.map((b) => `${b.input} (${b.status})`).join(', ')}` } : { statusMessage: `${state.pushed} results` });
}
