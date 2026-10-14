import { Actor, log } from 'apify';
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

/**
 * Diagnostics: fetches a list of URLs through each configured route and reports status, wire bytes (compressed, what a metered
 * proxy bills), whether the response is a login wall, and optionally the raw body of one page per kind. Never charges anything.
 */
export async function runProbe(input) {
    const { probeUrls = [], probeRoutes = [{ label: 'direct' }], probeSaveHtml = false, probeConcurrency = 3 } = input;
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
                    preview: /^\s*[[{]/.test(r.text) ? r.text.slice(0, 400) : undefined,
                };
                if (probeSaveHtml && routeIndex === 0 && r.status === 200 && !r.blocked && !savedKinds.has(kind)) {
                    savedKinds.add(kind);
                    row.body = r.text.slice(0, 2_500_000);
                }
                rows.push(row);
                await Actor.pushData(row);
                log.info(`[${route.label}] ${r.status}${r.blocked ? ' BLOCKED' : ''} ${r.wireBytes}B wire ${kind} ${url.slice(0, 90)}`);
            }
        };
        await Promise.all(Array.from({ length: probeConcurrency }, worker));
        const ok = rows.filter((x) => x.status === 200 && !x.blocked);
        const stat = {
            type: 'probe-summary',
            route: route.label,
            requests: rows.length,
            ok: ok.length,
            blocked: rows.filter((x) => x.blocked).length,
            errors: rows.filter((x) => x.status === 0).length,
            avgWireBytesOk: ok.length ? Math.round(ok.reduce((a, x) => a + x.wireBytes, 0) / ok.length) : 0,
            byKind: Object.fromEntries([...new Set(rows.map((x) => x.kind))].map((k) => [k, rows.filter((x) => x.kind === k).map((x) => (x.blocked ? 'blocked' : x.status)).join(',')])),
        };
        summary.push(stat);
        await Actor.pushData(stat);
        log.info(`Route ${route.label}: ${JSON.stringify(stat)}`);
    }
    return summary;
}
