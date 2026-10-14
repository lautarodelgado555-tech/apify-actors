// Crawl logic for one channel. Network access goes through an injected `fetcher` and output through an injected `sink`,
// so the whole flow (pagination, date window, incremental mode, dedupe) is unit-tested with saved pages.
import { parsePage, classifyProfile } from './telegram.js';

export const pagePath = (username, before) => `/s/${username}${before ? `?before=${before}` : ''}`;

const newest = (messages) => messages.reduce((a, m) => (m.messageId > a ? m.messageId : a), 0);
const oldest = (messages) => messages.reduce((a, m) => (m.messageId < a ? m.messageId : a), Infinity);

/** Fetch + parse one preview page. Redirects mean "no public preview". Throws only when retries are exhausted. */
async function loadPage(fetcher, username, before) {
    const res = await fetcher.get(pagePath(username, before));
    if (res.status >= 300 && res.status < 400) return { kind: 'redirect' };
    if (res.status === 404) return { kind: 'notfound' };
    if (res.status !== 200) throw new Error(`Unexpected HTTP ${res.status} from t.me`);
    return { kind: 'ok', parsed: parsePage(res.body) };
}

/**
 * Binary search for the `before` value whose page starts at the newest message dated <= dateTo.
 * Dates grow with message ids, so ~log2(latestId) cheap requests replace walking the whole archive.
 */
export async function locateBefore(fetcher, username, latestId, dateTo) {
    let lo = 1; let hi = latestId + 1; let probes = 0;
    while (hi - lo > 1 && probes < 40) {
        const mid = Math.floor((lo + hi) / 2);
        const r = await loadPage(fetcher, username, mid);
        probes += 1;
        const msgs = r.kind === 'ok' ? r.parsed.messages.filter((m) => m.date) : [];
        if (!msgs.length) { lo = mid; continue; }
        const top = msgs.reduce((a, m) => (m.messageId > a.messageId ? m : a));
        if (Date.parse(top.date) <= dateTo) lo = mid; else hi = mid;
    }
    return { before: lo, probes };
}

/**
 * @param {object} ctx
 * @param {string} ctx.username
 * @param {{get:(path:string)=>Promise<{status:number,body:string}>}} ctx.fetcher
 * @param {object} ctx.opt { maxMessages, maxPages, dateFrom, dateTo (ms or null), incremental, lastId, filter, includeService, decorate }
 * @param {{emit:(msg:object)=>Promise<boolean>}} ctx.sink emit returns false when no more messages may be pushed (charge limit)
 */
export async function scrapeChannel({ username, fetcher, opt, sink, log = () => {} }) {
    const {
        maxMessages = 100, maxPages = 1000, dateFrom = null, dateTo = null, incremental = false, lastId = null,
        filter = { test: () => true }, includeService = false, decorate = (m) => m,
    } = opt;
    const res = { username, status: 'ok', pages: 0, scanned: 0, emitted: 0, newestId: null, nextLastId: lastId, truncated: false, stoppedByLimit: false, channel: null, probes: 0 };

    let first = await loadPage(fetcher, username, null);
    if (first.kind !== 'ok') {
        const prof = await fetcher.get(`/${username}`).catch(() => null);
        const cls = prof && prof.status === 200 ? classifyProfile(prof.body) : { kind: first.kind === 'notfound' ? 'not_found' : 'unavailable' };
        res.status = cls.kind;
        res.detail = cls.title ? `${cls.title} (${cls.extra})` : undefined;
        return res;
    }
    res.pages = 1;
    let parsed = first.parsed;
    if (!parsed.messages.length) {
        res.status = parsed.restricted ? 'restricted' : 'empty';
        res.channel = parsed.channel;
        return res;
    }
    res.channel = parsed.channel;
    res.newestId = newest(parsed.messages);

    // Jump straight to the end of the requested date window instead of walking from the newest message.
    if (dateTo != null) {
        const top = parsed.messages.reduce((a, m) => (m.messageId > a.messageId ? m : a));
        if (top.date && Date.parse(top.date) > dateTo) {
            const { before, probes } = await locateBefore(fetcher, username, res.newestId, dateTo);
            res.probes = probes;
            const r = await loadPage(fetcher, username, before);
            if (r.kind !== 'ok' || !r.parsed.messages.length) { res.status = 'empty'; return res; }
            parsed = r.parsed;
            res.pages += 1;
        }
    }

    const useLast = incremental && lastId != null;
    const stream = !useLast; // newest-first streaming; incremental follow-ups are buffered then emitted oldest-first
    const seen = new Set();
    const buffer = [];
    let maxConsidered = lastId ?? 0;
    let stop = false;

    const emitOne = async (m) => {
        const ok = await sink.emit(decorate(m, parsed.channel));
        if (!ok) { res.stoppedByLimit = true; return false; }
        res.emitted += 1;
        return true;
    };

    for (;;) {
        const msgs = [...parsed.messages].sort((a, b) => b.messageId - a.messageId);
        let reachedOld = false;
        for (const m of msgs) {
            if (seen.has(m.messageId)) continue;
            seen.add(m.messageId);
            res.scanned += 1;
            if (useLast && m.messageId <= lastId) { reachedOld = true; continue; }
            const t = m.date ? Date.parse(m.date) : null;
            if (dateTo != null && t != null && t > dateTo) continue;
            if (dateFrom != null && t != null && t < dateFrom) { reachedOld = true; continue; }
            if (m.messageId > maxConsidered) maxConsidered = m.messageId;
            if (m.isService && !includeService) continue;
            if (!filter.test(m)) continue;
            if (stream) {
                if (!(await emitOne(m))) { stop = true; break; }
                if (res.emitted >= maxMessages) { stop = true; break; }
            } else {
                buffer.push(m);
            }
        }
        if (stop || reachedOld) break;
        const before = parsed.moreBefore ?? (oldest(parsed.messages) > 1 ? oldest(parsed.messages) : null);
        if (!before || before <= 1) break;
        if (res.pages >= maxPages) { res.truncated = true; break; }
        const r = await loadPage(fetcher, username, before);
        if (r.kind !== 'ok' || !r.parsed.messages.length) break;
        if (oldest(r.parsed.messages) >= oldest(parsed.messages)) break; // no progress
        parsed = r.parsed;
        res.pages += 1;
    }

    if (stream) {
        // First incremental run (no state yet) or a normal run: remember the newest message seen.
        if (incremental) res.nextLastId = Math.max(maxConsidered, lastId ?? 0) || null;
        return res;
    }

    // Incremental follow-up: oldest first, so a cut-off run resumes exactly after the last emitted message.
    buffer.sort((a, b) => a.messageId - b.messageId);
    let lastEmitted = null;
    let truncatedByMax = false;
    for (const m of buffer) {
        if (res.emitted >= maxMessages) { truncatedByMax = true; break; }
        if (!(await emitOne(m))) break;
        lastEmitted = m.messageId;
    }
    if (truncatedByMax || res.stoppedByLimit) {
        if (lastEmitted != null) res.nextLastId = lastEmitted;
        res.carryOver = true;
    } else {
        res.nextLastId = Math.max(maxConsidered, lastId);
    }
    return res;
}
