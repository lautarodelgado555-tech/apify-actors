/**
 * Minimal JSON-over-HTTP client with retries. Adapters receive it as `ctx.fetchJson`, so tests can swap it
 * for a fixture-backed function and never touch the network.
 */

export class SourceError extends Error {
    constructor(message, { status = null, blocked = false, url = null } = {}) {
        super(message);
        this.name = 'SourceError';
        this.status = status;
        this.blocked = blocked;
        this.url = url;
    }
}

const BLOCK_PATTERN = /captcha|security check|just a moment|access denied|verify you are human|unusual traffic/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeFetchJson({
    fetchImpl = globalThis.fetch,
    retries = 3,
    timeoutMs = 60_000,
    userAgent = 'us-business-status-monitor/0.1 (Apify Actor; public open-data client)',
    backoffMs = 800,
} = {}) {
    return async function fetchJson(url, { headers = {} } = {}) {
        let lastError;
        for (let attempt = 0; attempt <= retries; attempt += 1) {
            try {
                const res = await fetchImpl(url, {
                    headers: { accept: 'application/json', 'user-agent': userAgent, ...headers },
                    signal: AbortSignal.timeout(timeoutMs),
                });
                const text = await res.text();
                if (res.status === 429 || res.status >= 500) {
                    lastError = new SourceError(`HTTP ${res.status} from source`, { status: res.status, url });
                } else if (res.status === 403 || res.status === 401 || res.status === 999) {
                    // Fail closed: never retry or work around a block.
                    throw new SourceError(`Source refused the request (HTTP ${res.status})`, { status: res.status, blocked: true, url });
                } else if (!res.ok) {
                    throw new SourceError(`HTTP ${res.status} from source: ${text.slice(0, 200)}`, { status: res.status, url });
                } else {
                    try {
                        return JSON.parse(text);
                    } catch {
                        throw new SourceError(
                            BLOCK_PATTERN.test(text) ? 'Source returned a challenge page instead of data' : 'Source returned a non-JSON response',
                            { status: res.status, blocked: BLOCK_PATTERN.test(text), url },
                        );
                    }
                }
            } catch (err) {
                if (err instanceof SourceError && (err.blocked || (err.status && err.status < 500 && err.status !== 429))) throw err;
                lastError = err instanceof SourceError ? err : new SourceError(`Network error: ${err.message}`, { url });
            }
            if (attempt < retries) await sleep(backoffMs * (attempt + 1));
        }
        throw lastError;
    };
}
