import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

export const fixture = (name) => JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'));

/**
 * Fixture-backed stand-in for ctx.fetchJson. `routes` is a list of [matcher, fixtureName | value];
 * matcher is a substring or a predicate on the decoded URL. Unrouted URLs throw, so tests notice unexpected calls.
 */
export function stubFetch(routes) {
    const calls = [];
    const fn = async (url) => {
        const decoded = decodeURIComponent(url);
        calls.push(decoded);
        for (const [matcher, payload] of routes) {
            const hit = typeof matcher === 'function' ? matcher(decoded) : decoded.includes(matcher);
            if (hit) return typeof payload === 'string' ? fixture(payload) : payload;
        }
        throw new Error(`No fixture route for ${decoded}`);
    };
    fn.calls = calls;
    return fn;
}

export function makeCtx(routes, now = '2026-10-14T12:00:00.000Z') {
    const fetchJson = stubFetch(routes);
    return {
        fetchJson,
        now: new Date(now),
        cache: new Map(),
        log: { info() {}, debug() {}, warning() {} },
    };
}

const meta = fixture('meta');
export const metaRoutes = Object.entries({
    'data.colorado.gov/api/views/4ykn-tg5h': meta.co,
    'data.texas.gov/api/views/9cir-efmm': meta.tx,
    'data.ny.gov/api/views/3gg2-jgnp': meta.ny,
    'data.ct.gov/api/views/n7gp-d28j': meta.ct,
    'data.oregon.gov/api/views/tckn-sxa6': meta.or,
    'data.oregon.gov/api/views/6g49-bcrm': meta['or-county'],
});

/** In-memory snapshot store with the same interface main.js passes to the monitor. */
export function memoryStore(seed = {}) {
    const data = new Map(Object.entries(seed));
    return {
        data,
        get: async (k) => data.get(k),
        set: async (k, v) => {
            data.set(k, v);
        },
    };
}
