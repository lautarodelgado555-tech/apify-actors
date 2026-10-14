import zlib from 'node:zlib';
import { gotScraping } from 'got-scraping';

/** Pages that Mercado Libre serves to unverified visitors instead of the real content (login wall / suspicious-traffic gate). */
const GATE_URL = /\/gz\/account-verification|\/jms\/[a-z]+\/lgz\/login|\/gz\/login/i;
const GATE_BODY = /suspicious-traffic-frontend|gz-account-verification|data-testid="action:understood-button"[^]{0,4000}Para continuar, ingresa a tu cuenta/i;

export function isBlockedResponse({ status, finalUrl = '', text = '' }) {
    if (status === 403 || status === 429 || status === 401) return true;
    if (GATE_URL.test(finalUrl)) return true;
    if (status >= 200 && status < 300 && text.length < 120000 && GATE_BODY.test(text)) return true;
    return false;
}

const decode = (buf, encoding) => {
    try {
        if (/br/.test(encoding)) return zlib.brotliDecompressSync(buf).toString('utf8');
        if (/gzip/.test(encoding)) return zlib.gunzipSync(buf).toString('utf8');
        if (/deflate/.test(encoding)) return zlib.inflateSync(buf).toString('utf8');
    } catch {
        /* fall through to identity */
    }
    return buf.toString('utf8');
};

/**
 * One HTTP GET with a browser-like TLS/header fingerprint. Returns the compressed size on the wire as well,
 * which is what a metered (residential) proxy bills.
 */
export async function fetchPage(url, { proxyUrl, headers = {}, timeoutMs = 40000 } = {}) {
    const started = Date.now();
    try {
        const res = await gotScraping({
            url,
            proxyUrl,
            followRedirect: true,
            maxRedirects: 5,
            throwHttpErrors: false,
            responseType: 'buffer',
            decompress: false,
            timeout: { request: timeoutMs },
            retry: { limit: 0 },
            headers: { 'accept-encoding': 'gzip, deflate, br', ...headers },
            headerGeneratorOptions: { browsers: [{ name: 'chrome', minVersion: 120 }], operatingSystems: ['windows'], locales: ['es-AR', 'es'] },
        });
        const encoding = String(res.headers['content-encoding'] || 'identity');
        const text = decode(res.body, encoding);
        const out = { url, status: res.statusCode, finalUrl: res.url, wireBytes: res.body.length, bytes: Buffer.byteLength(text), ms: Date.now() - started, text };
        out.blocked = isBlockedResponse(out);
        return out;
    } catch (error) {
        return { url, status: 0, finalUrl: url, wireBytes: 0, bytes: 0, ms: Date.now() - started, text: '', blocked: false, error: String(error.message).split('\n')[0].slice(0, 200) };
    }
}
