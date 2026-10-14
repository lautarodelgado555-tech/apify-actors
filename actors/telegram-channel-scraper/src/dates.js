// Date inputs: "2026-09-01", "2026-09-01T12:00:00Z", or relative ("7 days", "2 weeks ago", "12 hours").
const UNIT = { hour: 3600e3, day: 86400e3, week: 7 * 86400e3, month: 30 * 86400e3, year: 365 * 86400e3 };

/**
 * @param {string|undefined|null} v
 * @param {'start'|'end'} edge a date-only value means the whole day: start -> 00:00:00.000 UTC, end -> 23:59:59.999 UTC
 * @returns {number|null} epoch ms
 */
export function parseDateInput(v, edge = 'start', now = Date.now()) {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s) return null;
    const rel = s.match(/^(\d+)\s*(hour|day|week|month|year)s?(?:\s+ago)?$/i);
    if (rel) return now - Number(rel[1]) * UNIT[rel[2].toLowerCase()];
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const t = Date.parse(`${s}T00:00:00.000Z`);
        if (Number.isNaN(t)) throw new Error(`Invalid date "${s}". Use YYYY-MM-DD, an ISO timestamp or a relative value like "7 days".`);
        return edge === 'end' ? t + 86400e3 - 1 : t;
    }
    const t = Date.parse(s);
    if (Number.isNaN(t)) throw new Error(`Invalid date "${s}". Use YYYY-MM-DD, an ISO timestamp or a relative value like "7 days".`);
    return t;
}
