import { Actor, log } from 'apify';
import { firefox } from 'playwright';
import {
    HOME_URL,
    annualRegistrations,
    buildPageBody,
    buildSearchBody,
    isChallengePage,
    isDetailPage,
    normalizeStatus,
    isoDate,
    parseDetail,
    parseFilings,
    parseResults,
} from './georgia.js';
import { annualReportStatus } from './compliance.js';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searchType = 'businessName',
    searchTerms = [],
    nameMatch = 'startsWith',
    maxResultsPerSearch = 25,
    activeOnly = false,
    fetchDetails = true,
    includeFilings = false,
    proxyConfiguration,
} = input;

const FREE_PLAN_CAP = 10;
// Outside the platform (local runs, CI) there is no plan; the cap only applies to free-plan users on Apify.
const freeCap = process.env.APIFY_IS_AT_HOME === '1' && process.env.APIFY_USER_IS_PAYING !== '1' ? FREE_PLAN_CAP : Infinity;
const MAX_SESSIONS = 8;

const terms = [...new Set(searchTerms.map((t) => String(t ?? '').trim()).filter(Boolean))];
if (!terms.length) {
    await Actor.fail('Input "searchTerms" must contain at least one name or number.');
}
if (!['businessName', 'controlNumber', 'registeredAgent', 'officer'].includes(searchType)) {
    await Actor.fail(`Unknown "searchType": ${searchType}`);
}

const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration(proxyConfiguration) : undefined;
const isPayPerEvent = Actor.getChargingManager().getPricingInfo().isPayPerEvent;
if (Number.isFinite(freeCap)) log.info(`Free plan: results are capped at ${FREE_PLAN_CAP} per run. Upgrade to get more.`);

// State survives migrations: per-term counts, finished terms and entities already emitted (never charged twice).
const state = await Actor.useState('STATE', {
    counts: {},
    done: {},
    seen: {},
    pushed: 0,
    chargeLimitReached: false,
});

class SessionBlocked extends Error {}

let browser = null;
let page = null;
let sessionCount = 0;

async function closeSession() {
    try {
        await browser?.close();
    } catch {
        /* ignore */
    }
    browser = null;
    page = null;
}

/** Open Firefox on the portal home page, on a fresh proxy IP. Cloudflare's JS detection is blocked: with it, the POSTs get challenged. */
async function openSession() {
    await closeSession();
    for (let attempt = 1; attempt <= MAX_SESSIONS; attempt += 1) {
        sessionCount += 1;
        const launchOptions = { headless: true };
        if (proxyConf) {
            const url = new URL(await proxyConf.newUrl(`ga${Date.now().toString(36)}${sessionCount}`));
            launchOptions.proxy = {
                server: `${url.protocol}//${url.host}`,
                username: decodeURIComponent(url.username),
                password: decodeURIComponent(url.password),
            };
        }
        try {
            browser = await firefox.launch(launchOptions);
            const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
            page = await context.newPage();
            await page.route('**/*', (route) => {
                const req = route.request();
                const type = req.resourceType();
                if (req.url().includes('/cdn-cgi/') || ['image', 'font', 'media', 'stylesheet', 'script'].includes(type)) return route.abort();
                return route.continue();
            });
            await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
            const title = await page.title();
            if (/just a moment/i.test(title)) throw new Error('Cloudflare challenge on the home page');
            log.info(`Session ready (attempt ${attempt}).`);
            return;
        } catch (e) {
            log.warning(`Could not open the portal (attempt ${attempt}/${MAX_SESSIONS}): ${String(e.message).split('\n')[0]}`);
            await closeSession();
            await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
    }
    throw new Error('Georgia eCorp blocked every connection attempt (Cloudflare challenge).');
}

/** POST a form from inside the page, like the portal's own scripts do. */
async function post(path, params) {
    if (!page) await openSession();
    const res = await page.evaluate(
        async ({ path: p, params: body }) => {
            const r = await fetch(p, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-requested-with': 'XMLHttpRequest' },
                body: new URLSearchParams(body).toString(),
                credentials: 'include',
            });
            return { status: r.status, mitigated: r.headers.get('cf-mitigated'), text: await r.text() };
        },
        { path, params },
    );
    if (res.mitigated === 'challenge' || isChallengePage(res.text)) throw new SessionBlocked(`Cloudflare challenged ${path} (HTTP ${res.status})`);
    return res;
}

/**
 * The portal's firewall challenges the plain detail URL; the same route with a trailing slash or in lower case
 * reaches the application (the server treats URLs case-insensitively). Try the variants in turn on one session.
 */
const DETAIL_PATHS = ['/BusinessSearch/BusinessInformation/', '/businesssearch/businessinformation'];
let detailPathIndex = 0;
async function postDetail(params) {
    let lastError;
    for (let i = 0; i < DETAIL_PATHS.length; i += 1) {
        const idx = (detailPathIndex + i) % DETAIL_PATHS.length;
        try {
            const res = await post(DETAIL_PATHS[idx], params);
            detailPathIndex = idx;
            return res;
        } catch (e) {
            if (!(e instanceof SessionBlocked)) throw e;
            lastError = e;
        }
    }
    throw lastError;
}

const scrapedAt = () => new Date().toISOString();
const SOURCE_URL = HOME_URL;

function baseItem({ row, detail, filings, term }) {
    const src = detail ?? {};
    const status = src.status ?? row.status;
    const out = {
        controlNumber: src.controlNumber ?? row.controlNumber,
        name: src.name ?? row.name,
        entityType: src.entityType ?? row.entityType,
        status,
        ...normalizeStatus(status),
        formationDate: src.formationDateIso ?? null,
        jurisdiction: src.jurisdiction ?? null,
        purpose: src.purpose ?? null,
        naicsCode: src.naicsCode ?? null,
        naicsSubCode: src.naicsSubCode ?? null,
        dissolvedDate: src.dissolvedDate ? isoDate(src.dissolvedDate) : null,
        principalAddress: src.principalAddress ?? row.principalAddress,
        registeredAgentName: src.registeredAgentName ?? row.registeredAgentName,
    };
    if (!detail) return { ...out, portalBusinessId: row.businessId, sourceUrl: SOURCE_URL, searchType, searchTerm: term, scrapedAt: scrapedAt() };
    Object.assign(out, {
        registeredAgentAddress: src.registeredAgentAddress,
        registeredAgentCounty: src.registeredAgentCounty,
        officers: src.officers,
        ...annualReportStatus({ status, formationDate: src.formationDate, lastAnnualReportYear: src.lastAnnualReportYear }),
    });
    if (filings) {
        const ar = annualRegistrations(filings);
        out.annualRegistrations = ar;
        out.lastAnnualReportFiledDate = ar.length ? ar[ar.length - 1].filedDate : null;
        out.filings = filings;
    }
    return { ...out, portalBusinessId: row.businessId, sourceUrl: SOURCE_URL, searchType, searchTerm: term, scrapedAt: scrapedAt() };
}

async function emit(item) {
    if (state.chargeLimitReached) return false;
    if (isPayPerEvent) {
        const { eventChargeLimitReached, chargedCount } = await Actor.charge({ eventName: 'result' });
        if (chargedCount === 0) {
            state.chargeLimitReached = true;
            log.warning('Reached the maximum charge for this run. Stopping; raise the limit to get more results.');
            return false;
        }
        if (eventChargeLimitReached) {
            state.chargeLimitReached = true;
            log.warning('Next result would exceed the charge limit; this is the last one.');
        }
    }
    await Actor.pushData(item);
    state.pushed += 1;
    return true;
}

async function fetchFilings(businessId) {
    const first = await post('/BusinessSearch/BusinessFilings/', { businessId });
    const parsed = parseFilings(first.text);
    const filings = [...parsed.filings];
    for (let p = 2; p <= parsed.totalPages && p <= 20; p += 1) {
        const next = await post('/BusinessSearch/BusinessFiling', { businessid: businessId, ...buildPageBody(p) });
        filings.push(...parseFilings(next.text).filings);
    }
    return filings;
}

/** Fetch one entity's detail (and optionally filings); returns null when the portal has no detail for it. */
async function loadEntity(row, term) {
    if (!fetchDetails) return baseItem({ row, term });
    const res = await postDetail({ businessId: row.businessId, fromSearch: '' });
    if (res.status !== 200 || !isDetailPage(res.text)) {
        log.warning(`No detail page for ${row.name} (${row.controlNumber || 'no control number'}, HTTP ${res.status}); skipping it.`);
        return null;
    }
    const detail = parseDetail(res.text);
    const filings = includeFilings ? await fetchFilings(row.businessId) : null;
    return baseItem({ row, detail, filings, term });
}

const stopped = () => state.chargeLimitReached || state.pushed >= freeCap;

/** Run one search term to completion (or the cap). Throws SessionBlocked when the portal challenges us. */
async function runTerm(term) {
    const cap = maxResultsPerSearch;
    let res = await post('/BusinessSearch', buildSearchBody(searchType, term, nameMatch));
    let list = parseResults(res.text);
    if (!list.rows.length) {
        log.info(list.noData ? `No results for "${term}".` : `No rows returned for "${term}"${list.error ? ` (${list.error})` : ''}.`);
        return;
    }
    log.info(`"${term}": ${list.totalRecords} record(s) in ${list.totalPages} page(s).`);
    let pageNo = 1;
    for (;;) {
        for (const row of list.rows) {
            if ((state.counts[term] ?? 0) >= cap || stopped()) return;
            if (state.seen[row.businessId]) continue;
            if (activeOnly && !/^active/i.test(row.status)) continue;
            const item = await loadEntity(row, term);
            state.seen[row.businessId] = 1;
            if (!item) continue;
            if (activeOnly && !item.active) continue;
            if (await emit(item)) state.counts[term] = (state.counts[term] ?? 0) + 1;
        }
        if (pageNo >= list.totalPages || (state.counts[term] ?? 0) >= cap || stopped()) return;
        pageNo += 1;
        res = await post('/BusinessSearch', buildPageBody(pageNo));
        list = parseResults(res.text);
        if (!list.rows.length) return;
    }
}

let blockedTerms = 0;
for (const term of terms) {
    if (state.done[term] || stopped()) continue;
    let finished = false;
    for (let attempt = 1; attempt <= 4 && !finished; attempt += 1) {
        try {
            await runTerm(term);
            finished = true;
        } catch (e) {
            if (!(e instanceof SessionBlocked)) {
                log.error(`Search "${term}" failed: ${e.message}`);
                break;
            }
            log.warning(`${e.message}; opening a new session (${attempt}/4).`);
            try {
                await openSession();
            } catch (err) {
                log.error(err.message);
                break;
            }
        }
    }
    if (finished) state.done[term] = true;
    else blockedTerms += 1;
}

await closeSession();

log.info(`Done. ${state.pushed} entities saved for ${terms.length} search term(s).`);
if (!state.pushed && blockedTerms === terms.length) {
    await Actor.fail('Georgia eCorp blocked the run (Cloudflare challenge) or could not be searched. Nothing was charged. Try again later or use a different proxy group.');
} else {
    await Actor.exit();
}
