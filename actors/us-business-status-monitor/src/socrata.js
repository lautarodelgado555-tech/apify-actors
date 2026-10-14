/**
 * Helpers for the Socrata SODA API used by data.colorado.gov, data.texas.gov, data.ny.gov, data.ct.gov and
 * data.oregon.gov. We always send a SoQL query ($where / $select / $group) instead of downloading datasets.
 */
import { SourceError } from './http.js';

/** Escape a value for use inside a single-quoted SoQL string. */
export const sq = (value) => String(value).replace(/'/g, "''");

/** Uppercase prefix/contains term safe for `upper(col) like 'TERM%'`; strips LIKE wildcards. */
export const likeTerm = (value) => sq(String(value).toUpperCase().replace(/[%_]/g, ' ').replace(/\s+/g, ' ').trim());

/** 'a','b','c' for an `in(...)` clause. */
export const inList = (values) => values.map((v) => `'${sq(v)}'`).join(',');

export function sodaUrl(domain, id, params = {}) {
    const qs = Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&');
    return `https://${domain}/resource/${id}.json${qs ? `?${qs}` : ''}`;
}

/** Run a SoQL query and return the row array. */
export async function soda(ctx, domain, id, params) {
    const url = sodaUrl(domain, id, params);
    const rows = await ctx.fetchJson(url);
    if (!Array.isArray(rows)) {
        throw new SourceError(`Unexpected response from ${domain}/${id}: ${JSON.stringify(rows).slice(0, 200)}`, { url });
    }
    return rows;
}

/**
 * When the dataset's rows were last updated (ISO timestamp), from the public view metadata.
 * Cached per run. Returns null if the metadata cannot be read (freshness is informative, not critical).
 */
export async function datasetUpdatedAt(ctx, domain, id) {
    const key = `fresh:${domain}:${id}`;
    if (ctx.cache.has(key)) return ctx.cache.get(key);
    let value = null;
    try {
        const meta = await ctx.fetchJson(`https://${domain}/api/views/${id}.json`);
        const secs = Number(meta?.rowsUpdatedAt ?? meta?.viewLastModified);
        if (Number.isFinite(secs) && secs > 0) value = new Date(secs * 1000).toISOString();
    } catch (err) {
        ctx.log?.debug?.(`freshness unavailable for ${domain}/${id}: ${err.message}`);
    }
    ctx.cache.set(key, value);
    return value;
}

/** Run fn over chunks of `size` items and concatenate the results (keeps `in(...)` queries short). */
export async function inChunks(items, size, fn) {
    const out = [];
    for (let i = 0; i < items.length; i += size) out.push(...(await fn(items.slice(i, i + size))));
    return out;
}
