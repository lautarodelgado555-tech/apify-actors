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

const terms = [...new Set(searchTerms.map((t) => String(t ?? '').trim()).filter(Boolean))];
if (!terms.length) {
    await Actor.fail('Input "searchTerms" must contain at least one name or number.');
}

const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration(proxyConfiguration) : undefined;
const chargingManager = Actor.getChargingManager();
const isPayPerEvent = chargingManager.getPricingInfo().isPayPerEvent;

// Accepted-result counters per search term survive migrations and restarts.
const state = await Actor.useState('STATE', { counts: {}, pushed: 0, chargeLimitReached: false });

const canonicalDetailUrl = (url) => {
    const u = new URL(url);
    const aggregateId = u.searchParams.get('aggregateId');
    const searchNameOrder = u.searchParams.get('searchNameOrder') ?? '';
    const inquiryType = u.searchParams.get('inquirytype') ?? 'EntityName';
    if (!aggregateId) return url;
    const p = new URLSearchParams({ inquirytype: inquiryType, directionType: 'Initial', searchNameOrder, aggregateId });
    return `${BASE}/Inquiry/CorporationSearch/SearchResultDetail?${p}`;
};

const aggregateIdOf = (url) => new URL(url).searchParams.get('aggregateId') ?? url;

const matchesTerm = (name, term) => {
    if (!isNameSearch(searchType) || nameMatch === 'all') return { accept: true, pastBlock: false };
    const a = comparableName(name);
    const b = comparableName(term);
    const startsWith = a.startsWith(b);
    if (!startsWith) return { accept: false, pastBlock: true };
    if (nameMatch === 'exact') return { accept: a === b, pastBlock: false };
    return { accept: true, pastBlock: false };
};

let crawler;

async function emit(item) {
    if (state.chargeLimitReached) return false;
    if (isPayPerEvent) {
        const { eventChargeLimitReached, chargedCount } = await Actor.charge({ eventName: 'result' });
        if (chargedCount === 0 || eventChargeLimitReached) {
            if (chargedCount === 0) {
                state.chargeLimitReached = true;
                log.warning('Reached the maximum charge for this run. Stopping; raise the limit to get more results.');
                await crawler?.autoscaledPool?.abort();
                return false;
            }
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

function basicItem(row, term) {
    return {
        entityName: row.entityName,
        documentNumber: row.documentNumber,
        status: row.status,
        matchedName: row.matchedName ?? null,
        sunbizUrl: canonicalDetailUrl(row.detailUrl),
        searchType,
        searchTerm: term,
        scrapedAt: new Date().toISOString(),
    };
}

async function handleDetail({ html, url, term, row }) {
    const detail = parseDetail(html, canonicalDetailUrl(url));
    if (!detail.documentNumber && !detail.entityName) throw new Error('Detail page did not contain an entity');
    if (activeOnly && !/^active/i.test(detail.status ?? '')) {
        log.debug(`Skipping inactive entity ${detail.entityName}`);
        return;
    }
    const compliance = annualReportStatus(detail);
    await emit({
        ...detail,
        ...compliance,
        matchedName: row?.matchedName ?? null,
        searchType,
        searchTerm: term,
        scrapedAt: new Date().toISOString(),
    });
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
        const html = await page.content();
        if (isChallengePage(html)) throw new Error('Still on the Cloudflare page');

        if (request.label === 'DETAIL' || isDetailPage(html)) {
            if (request.label !== 'DETAIL') {
                // Document number and EIN searches open the entity directly.
                state.counts[term] = (state.counts[term] ?? 0) + 1;
            }
            await handleDetail({ html, url: request.url, term, row });
            return;
        }

        const { rows, nextUrl } = parseSearchResults(html, searchType);
        if (!rows.length) {
            log.info(`No results for "${term}"`);
            return;
        }
        let stop = false;
        const detailRequests = [];
        for (const r of rows) {
            if ((state.counts[term] ?? 0) >= maxResultsPerSearch) {
                stop = true;
                break;
            }
            const name = searchType === 'entityName' ? r.entityName : r.matchedName;
            const { accept, pastBlock } = matchesTerm(name, term);
            if (pastBlock) {
                stop = true;
                break;
            }
            if (!accept) continue;
            if (activeOnly && r.status && !/^active/i.test(r.status)) continue;
            state.counts[term] = (state.counts[term] ?? 0) + 1;
            if (fetchDetails) {
                detailRequests.push({
                    url: r.detailUrl,
                    label: 'DETAIL',
                    uniqueKey: `detail:${aggregateIdOf(r.detailUrl)}`,
                    userData: { term, row: r },
                });
            } else {
                await emit(basicItem(r, term));
            }
        }
        if (detailRequests.length) await c.addRequests(detailRequests);
        if (!stop && nextUrl && (state.counts[term] ?? 0) < maxResultsPerSearch && !state.chargeLimitReached) {
            await c.addRequests([{ url: nextUrl, label: 'LIST', userData: { term } }]);
        }
        log.info(`"${term}": accepted ${state.counts[term] ?? 0} so far${stop ? ' (done)' : ''}`);
    },
    failedRequestHandler({ request }, error) {
        log.error(`Giving up on ${request.url}: ${error.message}`);
    },
});

await crawler.run(
    terms.map((term) => ({
        url: buildSearchUrl(searchType, term),
        label: 'LIST',
        uniqueKey: `list:${searchType}:${term.toLowerCase()}`,
        userData: { term },
    })),
);

log.info(`Done. ${state.pushed} entities saved for ${terms.length} search term(s).`);
await Actor.exit();
