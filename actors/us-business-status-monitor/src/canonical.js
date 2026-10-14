/**
 * Canonical vocabulary and the normalized record every adapter must return.
 *
 * Canonical `status`:
 *   active      The entity exists and its registration is in effect.
 *   delinquent  Still registered but behind on a required filing/fee (curable, e.g. CO "Delinquent",
 *               CT "Active - Annual report past due", DC "Active - Not in Good Standing").
 *   suspended   Authority/right to transact suspended or forfeited by the state (curable by reinstatement,
 *               e.g. TX franchise tax "Forfeited", NY "Suspended").
 *   dissolved   Ended for good: dissolved, revoked, terminated, expired charter.
 *   inactive    No longer registered in this state for another reason: withdrawn, merged out, converted,
 *               cancelled, or simply absent from a state's list of active entities.
 *   unknown     The source gives no usable status (name reservations, unmapped codes).
 *
 * `goodStanding`: true / false / null. null means the source cannot tell (never a guess).
 * `annualReportDue`: ISO date. Only when the source states it, or the state's rule is documented in code with a
 * source URL (then `annualReportDueBasis` is "statutory-rule"). Otherwise null.
 */

export const STATUSES = ['active', 'inactive', 'dissolved', 'delinquent', 'suspended', 'unknown'];

/** Statuses that count as "behind with the state" for newlyDelinquent alerts. */
export const DELINQUENT_LIKE = new Set(['delinquent', 'suspended']);

const MONTHS = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

const pad = (n) => String(n).padStart(2, '0');
const fromUtc = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/**
 * Turn the date formats found in the supported sources into YYYY-MM-DD (UTC calendar date) or null.
 * Accepts Date, epoch milliseconds, "2026-01-16T00:00:00.000", "MM/DD/YYYY" and "Month D, YYYY".
 * Placeholder dates (year < 1700) are treated as missing.
 */
export function isoDate(value) {
    if (value === null || value === undefined || value === '') return null;
    let out = null;
    if (value instanceof Date) out = Number.isNaN(value.getTime()) ? null : fromUtc(value);
    else if (typeof value === 'number') out = Number.isFinite(value) ? fromUtc(new Date(value)) : null;
    else {
        const s = String(value).trim();
        let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (m) out = `${m[1]}-${m[2]}-${m[3]}`;
        else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) out = `${m[3]}-${pad(m[1])}-${pad(m[2])}`;
        else if ((m = s.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/)) && MONTHS[m[1].toLowerCase()] !== undefined) {
            out = `${m[3]}-${pad(MONTHS[m[1].toLowerCase()] + 1)}-${pad(m[2])}`;
        }
    }
    if (!out) return null;
    return Number(out.slice(0, 4)) < 1700 ? null : out;
}

/** Trim and collapse whitespace; empty strings become null. */
export function clean(value) {
    if (value === null || value === undefined) return null;
    const s = String(value).replace(/\s+/g, ' ').trim();
    return s === '' ? null : s;
}

export const joinParts = (parts, sep = ', ') => clean(parts.map(clean).filter(Boolean).join(sep));

export const RECORD_KEYS = [
    'state', 'entityId', 'name', 'entityType', 'statusRaw', 'statusDetail', 'status', 'goodStanding',
    'formationDate', 'statusDate', 'annualReportDue', 'annualReportDueBasis', 'annualReportDueNote',
    'lastReportFiled', 'registeredAgent', 'registeredAgentAddress',
    'source', 'sourceUrl', 'mode', 'dataFreshness', 'checkedAt', 'details',
];

/**
 * Build a complete normalized record. Every key is always present (null when unknown) so downstream
 * code, datasets and diffs never deal with missing fields. Throws on contract violations, which keeps
 * a buggy adapter from silently writing garbage.
 */
export function makeRecord(p) {
    if (!p.state || !/^[A-Z]{2}$/.test(p.state)) throw new Error(`record.state must be a 2-letter code, got ${p.state}`);
    if (!clean(p.entityId)) throw new Error('record.entityId is required');
    if (!STATUSES.includes(p.status)) throw new Error(`record.status "${p.status}" is not canonical`);
    if (p.goodStanding !== true && p.goodStanding !== false && p.goodStanding !== null && p.goodStanding !== undefined) {
        throw new Error('record.goodStanding must be true, false or null');
    }
    const due = isoDate(p.annualReportDue);
    return {
        state: p.state,
        entityId: String(p.entityId),
        name: clean(p.name),
        entityType: clean(p.entityType),
        statusRaw: clean(p.statusRaw),
        statusDetail: clean(p.statusDetail),
        status: p.status,
        goodStanding: p.goodStanding ?? null,
        formationDate: isoDate(p.formationDate),
        statusDate: isoDate(p.statusDate),
        annualReportDue: due,
        annualReportDueBasis: due ? (p.annualReportDueBasis ?? 'source') : null,
        annualReportDueNote: clean(p.annualReportDueNote),
        lastReportFiled: isoDate(p.lastReportFiled),
        registeredAgent: clean(p.registeredAgent),
        registeredAgentAddress: clean(p.registeredAgentAddress),
        source: p.source,
        sourceUrl: p.sourceUrl ?? null,
        mode: p.mode ?? 'opendata',
        dataFreshness: p.dataFreshness ?? null,
        checkedAt: p.checkedAt,
        details: p.details ?? {},
    };
}

/** Next calendar date strictly after `now` for a month/day anniversary (used by statutory rules). */
export function nextOccurrence(month, day, now, { inclusive = false } = {}) {
    const y = now.getUTCFullYear();
    const today = Date.UTC(y, now.getUTCMonth(), now.getUTCDate());
    let cand = Date.UTC(y, month - 1, day);
    if (inclusive ? cand < today : cand <= today) cand = Date.UTC(y + 1, month - 1, day);
    return new Date(cand);
}

/** Move a weekend date to the following Monday (the Comptroller moves weekend due dates to the next business day). */
export function nextBusinessDay(date) {
    const d = new Date(date.getTime());
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
    return d;
}

export const toIso = (d) => fromUtc(d);
