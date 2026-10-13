import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import { firefox } from 'playwright';
import {
    buildSearchUrl,
    comparableName,
    isChallengePage,
    isDetailPage,
    isNameSearch,
    parseDetail,
    parseSearchResults,
    BASE,
} from './sunbiz.js';
import { annualReportStatus } from './compliance.js';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searchType = 'entityName',
    searchTerms = [],
    nameMatch = 'startsWith',
    maxResultsPerSearch = 25,
    activeOnly = false,
    fetchDetails = true,
    proxyConfiguration,
} = input;
const DEBUG = process.env.SUNBIZ_DEBUG === '1';

const terms = [...new Set(searchTerms.map((t) => String(t ?? '').trim()).filter(Boolean))];
if (!terms.length) {
    await Actor.fail('Input "searchTerms" must contain at least one name or number.');
}

const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration(proxyConfiguration) : undefined;
const isPayPerEvent = Actor.getChargingManager().getPricingInfo().isPayPerEvent;

// Per-term bookkeeping survives migrations: emitted counts, details in flight,
// the next list page to open once in-flight details settle, and seen entities.
const state = await Actor.useState('STATE', {
    counts: {},
    pending: {},
    next: {},
    seen: {},
    pushed: 0,
    chargeLimitReached: false,
});

const canonicalDetailUrl = (url) => {
    const u = new URL(url);
    const aggregateId = u.searchParams.get('aggregateId');
    if (!aggregateId) return url;
    const p = new URLSearchParams({
        inquirytype: u.searchParams.get('inquirytype') ?? 'EntityName',
        directionType: 'Initial',
        searchNameOrder: u.searchParams.get('searchNameOrder') ?? '',
        aggregateId,
    });
    return `${BASE}/Inquiry/CorporationSearch/SearchResultDetail?${p}`;
};

const aggregateIdOf = (url) => new URL(url).searchParams.get('aggregateId') ?? url;
const digits = (s) => String(s ?? '').replace(/\D/g, '');

/** Decide whether a list row matches the term, and whether the list has moved past all possible matches. */
function matchesTerm(row, term) {
    if (searchType === 'feiEin') {
        const same = digits(row.matchedName) === digits(term);
        return { accept: same, pastBlock: !same };
    }
    if (!isNameSearch(searchType) || nameMatch === 'all') return { accept: true, pastBlock: false };
    const name = searchType === 'entityName' ? row.entityName : row.matchedName;
    const a = comparableName(name);
    const b = comparableName(term);
    if (!a.startsWith(b)) return { accept: false, pastBlock: true };
    if (nameMatch === 'exact') return { accept: a === b, pastBlock: false };
    return { accept: true, pastBlock: false };
}

let crawler;

async function emit(item) {
    if (state.chargeLimitReached) return false;
    if (isPayPerEvent) {
        const { eventChargeLimitReached, chargedCount } = await Actor.charge({ eventName: 'result' });
        if (chargedCount === 0) {
            state.chargeLimitReached = true;
            log.warning('Reached the maximum charge for this run. Stopping; raise the limit to get more results.');
            await crawler?.autoscaledPool?.abort();
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

async function waitForCloudflare(page, session) {
    for (let i = 0; i < 12; i += 1) {
        const title = await page.title().catch(() => '');
        if (!/just a moment/i.test(title)) return;
        await page.waitForTimeout(2000);
    }
    session?.retire();
    throw new Error('Cloudflare challenge was not solved; retrying with a new session');
}

const scrapedAt = () => new Date().toISOString();

function basicItem(row, term) {
    return {
        entityName: row.entityName,
        documentNumber: row.documentNumber,
        status: row.status,
        matchedName: row.matchedName ?? null,
        sunbizUrl: canonicalDetailUrl(row.detailUrl),
        searchType,
        searchTerm: term,
        scrapedAt: scrapedAt(),
    };
}

/** Open the next list page for a term once nothing is in flight and more results are wanted. */
async function maybeContinue(term, c) {
    const wanted = (state.counts[term] ?? 0) < maxResultsPerSearch;
    if (wanted && !state.chargeLimitReached && (state.pending[term] ?? 0) === 0 && state.next[term]) {
        const url = state.next[term];
        delete state.next[term];
        await c.addRequests([{ url, label: 'LIST', userData: { term } }]);
    }
}

async function handleDetail({ html, url, term, row }) {
    const detail = parseDetail(html, canonicalDetailUrl(url));
    if (!detail.documentNumber && !detail.entityName) throw new Error('Detail page did not contain an entity');
    if (activeOnly && !/^active/i.test(detail.status ?? '')) {
        log.debug(`Skipping inactive entity ${detail.entityName} (${detail.documentNumber})`);
        return false;
    }
    return emit({
        ...detail,
        ...annualReportStatus(detail),
        matchedName: row?.matchedName ?? null,
        searchType,
        searchTerm: term,
        scrapedAt: scrapedAt(),
    });
}

async function saveDebug(name, html) {
    if (!DEBUG) return;
    await Actor.setValue(`DEBUG-${name.replace(/[^a-z0-9]/gi, '_')}`, html, { contentType: 'text/html' });
}

crawler = new PlaywrightCrawler({
    proxyConfiguration: proxyConf,
    launchContext: {
        launcher: firefox,
        launchOptions: { headless: true },
    },
    browserPoolOptions: {
        useFingerprints: true,
        fingerprintOptions: {
            fingerprintGeneratorOptions: { browsers: ['firefox'], operatingSystems: ['windows', 'macos'] },
        },
        retireBrowserAfterPageCount: 60,
    },
    useSessionPool: true,
    persistCookiesPerSession: true,
    maxConcurrency: 4,
    maxRequestRetries: 3,
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 120,
    preNavigationHooks: [
        async ({ page }) => {
            await page.route('**/*', (route) => {
                const type = route.request().resourceType();
                if (type === 'image' || type === 'font' || type === 'media') return route.abort();
                return route.continue();
            });
        },
    ],
    async requestHandler({ request, page, session, crawler: c }) {
        const { term, row } = request.userData;
        await waitForCloudflare(page, session);

        if (request.label === 'FORM') {
            // Document-number lookups only work through Sunbiz's own form (POST + redirect).
            await page.fill('#SearchTerm', term);
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
                page.press('#SearchTerm', 'Enter'),
            ]);
            await waitForCloudflare(page, session);
        }

        const html = await page.content();
        if (isChallengePage(html)) throw new Error('Still on the Cloudflare page');

        if (request.label === 'DETAIL') {
            let emitted = false;
            try {
                emitted = await handleDetail({ html, url: request.url, term, row });
            } finally {
                state.pending[term] = Math.max(0, (state.pending[term] ?? 0) - 1);
                if (emitted) state.counts[term] = (state.counts[term] ?? 0) + 1;
            }
            await maybeContinue(term, c);
            return;
        }

        if (isDetailPage(html)) {
            // Document number and EIN lookups can open the entity directly.
            const emitted = await handleDetail({ html, url: page.url(), term });
            if (emitted) state.counts[term] = (state.counts[term] ?? 0) + 1;
            return;
        }

        const { rows, nextUrl } = parseSearchResults(html, searchType);
        if (!rows.length) {
            log.info(`No results for "${term}"`);
            await saveDebug(`noresults-${term}`, html);
            return;
        }
        let pastBlock = false;
        let full = false;
        const detailRequests = [];
        for (const r of rows) {
            const capacity = maxResultsPerSearch - (state.counts[term] ?? 0) - (state.pending[term] ?? 0);
            if (capacity <= 0) {
                full = true;
                break;
            }
            const match = matchesTerm(r, term);
            if (match.pastBlock) {
                pastBlock = true;
                break;
            }
            if (!match.accept) continue;
            if (activeOnly && r.status && !/^active/i.test(r.status)) continue;
            const id = aggregateIdOf(r.detailUrl);
            if (state.seen[id]) continue;
            state.seen[id] = 1;
            if (fetchDetails) {
                state.pending[term] = (state.pending[term] ?? 0) + 1;
                detailRequests.push({
                    url: r.detailUrl,
                    label: 'DETAIL',
                    uniqueKey: `detail:${id}`,
                    userData: { term, row: r },
                });
            } else if (await emit(basicItem(r, term))) {
                state.counts[term] = (state.counts[term] ?? 0) + 1;
            }
        }
        if (detailRequests.length) await c.addRequests(detailRequests);
        if (!pastBlock && nextUrl && !full) state.next[term] = nextUrl;
        if (full && nextUrl) state.next[term] = nextUrl; // more rows exist in case in-flight details get skipped
        log.info(`"${term}": ${state.counts[term] ?? 0} saved, ${state.pending[term] ?? 0} in flight${pastBlock ? ' (end of matches)' : ''}`);
        await maybeContinue(term, c);
    },
    async failedRequestHandler({ request, crawler: c }, error) {
        log.error(`Giving up on ${request.url}: ${error.message}`);
        const { term } = request.userData;
        if (request.label === 'DETAIL' && term) {
            state.pending[term] = Math.max(0, (state.pending[term] ?? 0) - 1);
            await maybeContinue(term, c);
        }
    },
});

const startRequests = terms.map((term) =>
    searchType === 'documentNumber'
        ? {
              url: `${BASE}/Inquiry/CorporationSearch/ByDocumentNumber`,
              label: 'FORM',
              uniqueKey: `form:${searchType}:${term.toLowerCase()}`,
              userData: { term },
          }
        : {
              url: buildSearchUrl(searchType, term),
              label: 'LIST',
              uniqueKey: `list:${searchType}:${term.toLowerCase()}`,
              userData: { term },
          },
);

await crawler.run(startRequests);

log.info(`Done. ${state.pushed} entities saved for ${terms.length} search term(s).`);
await Actor.exit();
