import { scoreMatch } from '../match.js';

/** Keep the `limit` rows whose names match `query` best, so enrichment queries only run for likely candidates. */
export function preRank(query, rows, nameOf, limit) {
    return rows
        .map((row) => ({ row, score: scoreMatch(query, nameOf(row)).score }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((x) => x.row);
}

/** Run `fn` for each item with at most `size` in flight; results keep input order. */
export async function mapLimit(items, size, fn) {
    const out = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
        while (next < items.length) {
            const i = next;
            next += 1;
            out[i] = await fn(items[i], i);
        }
    });
    await Promise.all(workers);
    return out;
}

/** Candidate window fetched from the source before ranking. */
export const candidateWindow = (limit) => Math.min(200, Math.max(60, limit * 12));

export const digitsOnly = (s) => String(s ?? '').replace(/\D/g, '');
