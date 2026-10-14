// HTTP access to t.me with polite pacing, backoff on 429/5xx, shared throttling and optional proxy rotation.
import { gotScraping } from 'got-scraping';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TelegramFetcher {
    /**
     * @param {object} o
     * @param {number} [o.minDelayMs] minimum gap between two requests of the same channel worker
     * @param {number} [o.maxRetries]
     * @param {import('apify').ProxyConfiguration} [o.proxyConfiguration]
     * @param {(msg:string)=>void} [o.log]
     */
    constructor({ minDelayMs = 150, maxRetries = 6, proxyConfiguration, log = () => {} } = {}) {
        this.minDelayMs = minDelayMs;
        this.maxRetries = maxRetries;
        this.proxyConfiguration = proxyConfiguration;
        this.log = log;
        this.penaltyUntil = 0; // shared across workers: after a 429 everybody slows down
        this.stats = { requests: 0, retries: 0, rateLimited: 0, bytes: 0 };
        this.sessions = new Map();
        this.last = new Map();
    }

    async proxyUrlFor(key, rotate) {
        if (!this.proxyConfiguration) return undefined;
        let n = this.sessions.get(key) ?? 0;
        if (rotate) { n += 1; this.sessions.set(key, n); }
        const id = `tg${Math.abs(hash(key))}x${n}`.slice(0, 50);
        return this.proxyConfiguration.newUrl(id);
    }

    /** GET https://t.me<path>; resolves with { status, body, location }. Rejects only after exhausting retries. */
    async get(path, key = path.split('?')[0]) {
        const url = `https://t.me${path}`;
        let attempt = 0; let rotate = false;
        for (;;) {
            const wait = Math.max(this.penaltyUntil - Date.now(), (this.last.get(key) ?? 0) + this.minDelayMs - Date.now(), 0);
            if (wait > 0) await sleep(wait);
            this.last.set(key, Date.now());
            let status = 0; let body = ''; let headers = {}; let error = null;
            try {
                const proxyUrl = await this.proxyUrlFor(key, rotate);
                rotate = false;
                this.stats.requests += 1;
                const r = await gotScraping({
                    url, proxyUrl, followRedirect: false, throwHttpErrors: false, retry: { limit: 0 },
                    timeout: { request: 30000 }, http2: false,
                    headerGeneratorOptions: { browsers: [{ name: 'chrome', minVersion: 120 }], devices: ['desktop'], locales: ['en-US'] },
                });
                status = r.statusCode; body = r.body; headers = r.headers;
                this.stats.bytes += Buffer.byteLength(body ?? '');
            } catch (e) {
                error = e;
            }
            if (!error && ((status >= 200 && status < 300) || (status >= 300 && status < 400) || status === 404 || status === 400)) {
                return { status, body, location: headers.location ?? null };
            }
            // 429 / 5xx / network error -> back off
            attempt += 1;
            this.stats.retries += 1;
            if (status === 429) this.stats.rateLimited += 1;
            if (attempt > this.maxRetries) {
                throw new Error(error ? `Network error: ${error.message}` : `HTTP ${status} from t.me after ${this.maxRetries} retries`);
            }
            const retryAfter = Number(headers['retry-after']);
            const backoff = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 120) * 1000 : Math.min(2000 * 2 ** (attempt - 1), 60000);
            const jitter = Math.floor(Math.random() * 500);
            if (status === 429 || status === 403) {
                this.penaltyUntil = Math.max(this.penaltyUntil, Date.now() + backoff + jitter);
                rotate = true; // new proxy session (no-op without proxy)
            }
            this.log(`t.me ${error ? 'network error' : `HTTP ${status}`} for ${path}; retry ${attempt}/${this.maxRetries} in ${Math.round((backoff + jitter) / 1000)}s`);
            await sleep(backoff + jitter);
        }
    }
}

function hash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
}
