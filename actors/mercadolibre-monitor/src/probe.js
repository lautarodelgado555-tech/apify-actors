import { Actor, log } from 'apify';
import { firefox } from 'playwright';
import { fetchPage } from './http.js';

const kindOf = (url) => {
    if (/api\.mercadoli/.test(url)) return `api:${(url.match(/api\.mercadolibre\.com\/([a-z]+)/) || [])[1]}`;
    if (/mas-vendidos\/ML|mais-vendidos\/ML/.test(url)) return 'bestsellers-category';
    if (/mas-vendidos|mais-vendidos/.test(url)) return 'bestsellers';
    if (/tiendas-oficiales/.test(url)) return 'stores-landing';
    if (/\/tienda\//.test(url) && /^https:\/\/www/.test(url)) return 'store-home';
    if (/\/up\/MLAU/.test(url)) return 'item-up';
    if (/\/p\/ML/.test(url)) return 'item-catalog';
    if (/articulo\./.test(url)) return 'item-articulo';
    if (/listado\.|lista\./.test(url)) return 'listing';
    return 'other';
};

const titleOf = (t) => ((t.match(/<title[^>]*>([^<]*)/i) || [])[1] || '').trim().slice(0, 80);
const CHALLENGE = /micro-landing-container|snoopy-generation-web/;
const features = (t) => ({
    challenge: CHALLENGE.test(t),
    pdp: /ui-pdp/.test(t),
    ldjson: (t.match(/application\/ld\+json/g) || []).length,
    money: /andes-money-amount/.test(t),
    polyCard: (t.match(/poly-card__content/g) || []).length,
    preloaded: /__PRELOADED_STATE__/.test(t),
});

function proxyParts(proxyUrl) {
    const u = new URL(proxyUrl);
    return { server: `${u.protocol}//${u.host}`, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
}

/** Browser leg: does a real Firefox pass Mercado Libre's JS challenge through the proxy, how many bytes does it cost, and can its cookies be reused over plain HTTP? */
async function browserProbe(route, proxyConf, urls, saveHtml) {
    const sessionId = `pw${Date.now().toString(36)}`.slice(0, 20);
    const proxyUrl = proxyConf ? await proxyConf.newUrl(sessionId) : undefined;
    const browser = await firefox.launch({ headless: true, proxy: proxyUrl ? proxyParts(proxyUrl) : undefined });
    const context = await browser.newContext({ locale: 'es-AR', timezoneId: 'America/Argentina/Buenos_Aires', viewport: { width: 1366, height: 800 } });
    const blocked = new Set(['image', 'media', 'font', 'stylesheet']);
    await context.route('**/*', (r) => (blocked.has(r.request().resourceType()) ? r.abort() : r.continue()));
    let wire = 0;
    const pending = [];
    context.on('requestfinished', (req) => {
        pending.push(
            req.sizes().then((s) => { wire += s.responseBodySize + s.responseHeadersSize + s.requestHeadersSize + s.requestBodySize; }).catch(() => {}),
        );
    });
    const rows = [];
    const savedKinds = new Set();
    for (const url of urls) {
        const page = await context.newPage();
        const t0 = Date.now();
        const wireBefore = wire;
        let html = '';
        let error;
        let passedAfterMs = null;
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
            for (let i = 0; i < 40; i += 1) {
                html = await page.content();
                if (!CHALLENGE.test(html) && html.length > 40000) {
                    passedAfterMs = Date.now() - t0;
                    break;
                }
                await page.waitForTimeout(750);
            }
            html = await page.content();
        } catch (e) {
            error = String(e.message).split('\n')[0].slice(0, 160);
        }
        await Promise.all(pending.splice(0));
        const kind = kindOf(url);
        const row = {
            type: 'probe-browser',
            route,
            kind,
            url,
            finalUrl: page.url().slice(0, 200),
            passedAfterMs,
            ms: Date.now() - t0,
            wireBytes: wire - wireBefore,
            bytes: Buffer.byteLength(html),
            title: titleOf(html),
            error,
            ...features(html),
        };
        if (saveHtml && !savedKinds.has(kind) && passedAfterMs) {
            savedKinds.add(kind);
            row.body = html.slice(0, 3_000_000);
        }
        rows.push(row);
        await Actor.pushData(row);
        log.info(`[browser:${route}] ${kind} passed=${passedAfterMs} wire=${row.wireBytes} bytes=${row.bytes} challenge=${row.challenge} pdp=${row.pdp} ${url.slice(0, 80)}`);
        await page.close();
    }
    const cookies = await context.cookies();
    await Actor.pushData({ type: 'probe-cookies', route, names: cookies.map((c) => `${c.name}@${c.domain}${c.expires > 0 ? `(+${Math.round((c.expires * 1000 - Date.now()) / 60000)}min)` : ''}`) });
    await browser.close();
    return { cookies, proxyUrl, sessionId, rows };
}

/** HTTP leg: reuse the browser's cookies over plain HTTP, same sticky proxy session. */
async function cookieReuseProbe(route, { cookies, proxyUrl }, urls) {
    const out = [];
    for (const url of urls) {
        const host = new URL(url).hostname;
        const cookieHeader = cookies.filter((c) => host.endsWith(c.domain.replace(/^\./, ''))).map((c) => `${c.name}=${c.value}`).join('; ');
        const r = await fetchPage(url, { proxyUrl, headers: { cookie: cookieHeader, 'accept-language': 'es-AR,es;q=0.9' } });
        const row = { type: 'probe-cookie-reuse', route, kind: kindOf(url), url, status: r.status, wireBytes: r.wireBytes, bytes: r.bytes, ms: r.ms, error: r.error, title: titleOf(r.text), ...features(r.text) };
        out.push(row);
        await Actor.pushData(row);
        log.info(`[cookie-reuse:${route}] ${r.status} wire=${r.wireBytes} challenge=${row.challenge} pdp=${row.pdp} ${row.kind}`);
    }
    return out;
}

/**
 * Diagnostics: fetches a list of URLs through each configured route and reports status, wire bytes (compressed, what a metered
 * proxy bills), whether the response is a login wall or JS challenge, and optionally the raw body of one page per kind. Never charges anything.
 */
export async function runProbe(input) {
    const { probeUrls = [], probeRoutes = [{ label: 'direct' }], probeSaveHtml = false, probeConcurrency = 3, probeBrowserUrls = [], probeReuseUrls = [] } = input;
    const summary = [];
    for (const [routeIndex, route] of probeRoutes.entries()) {
        let proxyConf;
        try {
            proxyConf = route.proxyConfiguration ? await Actor.createProxyConfiguration(route.proxyConfiguration) : undefined;
        } catch (error) {
            log.warning(`Route ${route.label}: cannot create proxy configuration: ${error.message}`);
            await Actor.pushData({ type: 'probe-route', route: route.label, error: `proxy configuration: ${error.message}` });
            continue;
        }
        const savedKinds = new Set();
        const rows = [];
        let next = 0;
        const worker = async () => {
            while (next < probeUrls.length) {
                const url = probeUrls[next++];
                const proxyUrl = proxyConf ? await proxyConf.newUrl() : undefined;
                const r = await fetchPage(url, { proxyUrl, headers: /api\.mercadoli/.test(url) ? { accept: 'application/json' } : {} });
                const kind = kindOf(url);
                const row = {
                    type: 'probe',
                    route: route.label,
                    kind,
                    url,
                    status: r.status,
                    blocked: r.blocked,
                    finalUrl: r.finalUrl !== url ? r.finalUrl.slice(0, 200) : undefined,
                    wireBytes: r.wireBytes,
                    bytes: r.bytes,
                    ms: r.ms,
                    title: titleOf(r.text),
                    error: r.error,
                    ...features(r.text),
                    preview: /^\s*[[{]/.test(r.text) ? r.text.slice(0, 400) : undefined,
                };
                if (probeSaveHtml && routeIndex === 0 && r.status === 200 && !r.blocked && !savedKinds.has(kind) && !row.challenge) {
                    savedKinds.add(kind);
                    row.body = r.text.slice(0, 2_500_000);
                }
                rows.push(row);
                await Actor.pushData(row);
                log.info(`[${route.label}] ${r.status}${r.blocked ? ' BLOCKED' : ''}${row.challenge ? ' CHALLENGE' : ''} ${r.wireBytes}B wire ${kind} ${url.slice(0, 90)}`);
            }
        };
        if (probeUrls.length) await Promise.all(Array.from({ length: probeConcurrency }, worker));
        const ok = rows.filter((x) => x.status === 200 && !x.blocked && !x.challenge);
        const stat = {
            type: 'probe-summary',
            route: route.label,
            requests: rows.length,
            ok: ok.length,
            challenge: rows.filter((x) => x.challenge).length,
            blocked: rows.filter((x) => x.blocked).length,
            errors: rows.filter((x) => x.status === 0).length,
            avgWireBytesOk: ok.length ? Math.round(ok.reduce((a, x) => a + x.wireBytes, 0) / ok.length) : 0,
            byKind: Object.fromEntries([...new Set(rows.map((x) => x.kind))].map((k) => [k, rows.filter((x) => x.kind === k).map((x) => (x.blocked ? 'blocked' : x.challenge ? 'challenge' : x.status)).join(',')])),
        };
        summary.push(stat);
        await Actor.pushData(stat);
        log.info(`Route ${route.label}: ${JSON.stringify(stat)}`);

        if (probeBrowserUrls.length) {
            try {
                const res = await browserProbe(route.label, proxyConf, probeBrowserUrls, probeSaveHtml && routeIndex === 0);
                if (probeReuseUrls.length) await cookieReuseProbe(route.label, res, probeReuseUrls);
            } catch (e) {
                log.error(`Browser probe failed: ${e.message}`);
                await Actor.pushData({ type: 'probe-browser-error', route: route.label, error: String(e.message).slice(0, 300) });
            }
        }
    }
    return summary;
}
