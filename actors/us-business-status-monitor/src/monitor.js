/**
 * Orchestration for `check` and `monitor` runs. Pure with respect to the platform: everything it needs
 * (adapters, snapshot store, charging, dataset output, clock) is injected, so the whole flow is unit-testable
 * offline with fixtures. src/main.js wires it to the Apify SDK.
 */
import { diffRecords, snapshotKey, snapshotOf } from './diff.js';
import { makeRecord } from './canonical.js';
import { rankCandidates, singleExactMatch } from './match.js';
import { normalizeState } from './registry.js';
import { SourceError } from './http.js';

export const EVENT_CHECK = 'entity-check';
export const EVENT_ALERT = 'change-alert';

const ABSENT_RAW = "Absent from the state's list of active entities";

/** Validate and normalize one watchlist entry. Returns { entry } or { error }. */
export function normalizeEntry(raw, index) {
    const state = normalizeState(raw?.state);
    const id = raw?.entityId ?? raw?.id;
    const idStr = id === undefined || id === null ? '' : String(id).trim();
    const name = raw?.name === undefined || raw?.name === null ? '' : String(raw.name).trim();
    if (!state) return { error: { code: 'INVALID_ENTRY', message: `Entry ${index + 1}: "state" is required (2-letter code such as TX).` } };
    if (!idStr && !name) return { error: { code: 'INVALID_ENTRY', message: `Entry ${index + 1} (${state}): give an "id" (entity number) or a "name".` } };
    return { entry: { state, id: idStr || null, name: name || null, label: raw?.label ? String(raw.label) : null, index } };
}

const dedupeKey = (e) => `${e.state}|${e.id ?? `name:${e.name.toLowerCase()}`}`;

function queryOf(entry) {
    return { state: entry.state, id: entry.id, name: entry.name, label: entry.label };
}

/** Rebuild a record for an entity that vanished from an active-only list, based on its last snapshot. */
function absentRecord(prev, now) {
    return makeRecord({
        state: prev.state,
        entityId: prev.entityId,
        name: prev.name,
        entityType: prev.entityType,
        statusRaw: ABSENT_RAW,
        statusDetail: `Last seen as "${prev.statusRaw ?? prev.status}" on ${String(prev.checkedAt).slice(0, 10)}`,
        status: 'inactive',
        goodStanding: false,
        annualReportDue: null,
        lastReportFiled: prev.lastReportFiled,
        registeredAgent: prev.registeredAgent,
        source: 'Absence from the state\'s active-entities open dataset',
        mode: 'opendata',
        dataFreshness: null,
        checkedAt: now.toISOString(),
        details: { synthesizedFromAbsence: true },
    });
}

function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

/**
 * @param {object} p
 * @param {Array}  p.watchlist
 * @param {'check'|'monitor'} p.mode
 * @param {import('./registry.js').Registry} p.registry
 * @param {{get(key):Promise<object|undefined>, set(key,value):Promise<void>}} p.store snapshot store
 * @param {(event:string)=>Promise<{ok:boolean, limitReached:boolean}>} p.charge
 * @param {(row:object)=>Promise<void>} p.emit
 * @param {object} p.ctx adapter context (fetchJson, now, cache, log)
 * @param {object} p.options { maxCandidates, activeOnly, autoResolveExactName, maxChecks, concurrency }
 */
export async function processWatchlist({ watchlist, mode, registry, store, charge, emit, ctx, options }) {
    const {
        maxCandidates = 3, activeOnly = false, autoResolveExactName = false,
        maxChecks = Infinity, concurrency = 4,
    } = options ?? {};
    const monitor = mode === 'monitor';
    const log = ctx.log ?? { info() {}, warning() {}, debug() {} };

    const summary = {
        mode,
        startedAt: ctx.now.toISOString(),
        entriesReceived: watchlist.length,
        entriesProcessed: 0,
        entityChecks: 0,
        changedEntities: 0,
        changeAlerts: 0,
        newBaselines: 0,
        notFound: 0,
        errors: 0,
        truncated: false,
        truncatedReason: null,
        changeEvents: [],
    };

    // Normalize + dedupe up front; bad entries become uncharged error rows.
    const entries = [];
    const seen = new Set();
    for (const [i, raw] of watchlist.entries()) {
        const { entry, error } = normalizeEntry(raw, i);
        if (error) {
            summary.errors += 1;
            await emit({ recordType: 'lookup-error', ...error, query: { state: raw?.state ?? null, id: raw?.id ?? raw?.entityId ?? null, name: raw?.name ?? null }, charged: false, checkedAt: ctx.now.toISOString() });
            continue;
        }
        const key = dedupeKey(entry);
        if (seen.has(key)) {
            log.info(`Skipping duplicate watchlist entry ${key}`);
            continue;
        }
        seen.add(key);
        entries.push(entry);
    }

    let stop = false;
    const stopRun = (reason) => {
        stop = true;
        summary.truncated = true;
        summary.truncatedReason ??= reason;
    };

    /** Charge one event; returns false when the run must stop before emitting. */
    const tryCharge = async (event) => {
        const res = await charge(event);
        if (!res.ok) {
            stopRun('The maximum charge for this run was reached. Raise the run\'s maximum cost to process the rest of the watchlist.');
            return false;
        }
        if (res.limitReached) stopRun('The maximum charge for this run was reached with this item.');
        return true;
    };

    async function lookupEntry(entry) {
        const adapter = registry.get(entry.state);
        if (!adapter) {
            return { entry, error: { code: 'UNSUPPORTED_STATE', message: `State ${entry.state} is not supported yet. Supported: ${registry.states().join(', ')}.` } };
        }
        try {
            const records = await adapter.lookup(
                { id: entry.id, name: entry.id ? null : entry.name, limit: entry.id ? 1 : Math.min(10, Math.max(1, maxCandidates)), activeOnly },
                ctx,
            );
            return { entry, adapter, records };
        } catch (err) {
            const blocked = err instanceof SourceError && err.blocked;
            return {
                entry,
                adapter,
                error: {
                    code: blocked ? 'SOURCE_BLOCKED' : 'SOURCE_ERROR',
                    message: blocked
                        ? `The source for ${entry.state} blocked the request (${err.message}). Nothing was charged; try again later.`
                        : `Lookup failed for ${entry.state}: ${err.message}`,
                },
            };
        }
    }

    /** Emit one entity-check row (charging first) and, in monitor mode, diff + snapshot + change-alert. */
    async function emitEntity(entry, record, { monitored, extra = {} }) {
        if (summary.entityChecks >= maxChecks) {
            stopRun(`Reached the limit of ${maxChecks} checks per run (free plan: ${maxChecks}). Upgrade to a paid Apify plan or use a smaller watchlist.`);
            return;
        }
        const key = snapshotKey(record.state, record.entityId);
        const prev = monitored ? await store.get(key) : undefined;
        const events = prev ? diffRecords(prev, record) : [];

        if (!(await tryCharge(EVENT_CHECK))) return;
        summary.entityChecks += 1;
        await emit({
            recordType: 'entity-check',
            ...record,
            query: queryOf(entry),
            monitored,
            firstSeen: monitored ? !prev : null,
            previousCheckedAt: prev?.checkedAt ?? null,
            changed: events.length > 0,
            changeTypes: events.map((e) => e.type),
            changes: events,
            ...extra,
        });

        if (monitored) {
            if (!prev) summary.newBaselines += 1;
            await store.set(key, snapshotOf(record));
        }
        if (events.length) {
            summary.changedEntities += 1;
            for (const e of events) {
                summary.changeEvents.push({ state: record.state, entityId: record.entityId, name: record.name, ...e });
            }
            // The entity row above already carries the events; the alert row is the billable, webhook-friendly copy.
            if (!stop && (await tryCharge(EVENT_ALERT))) {
                summary.changeAlerts += 1;
                await emit({
                    recordType: 'change-alert',
                    state: record.state,
                    entityId: record.entityId,
                    name: record.name,
                    summary: `${record.name ?? record.entityId} (${record.state}): ${events.map((e) => e.message).join('; ')}`,
                    eventTypes: events.map((e) => e.type),
                    events,
                    previous: prev,
                    current: snapshotOf(record),
                    previousCheckedAt: prev.checkedAt ?? null,
                    checkedAt: record.checkedAt,
                    sourceUrl: record.sourceUrl,
                    query: queryOf(entry),
                });
            }
        }
    }

    async function handleOutcome(outcome) {
        const { entry, adapter, records, error } = outcome;
        summary.entriesProcessed += 1;

        if (error) {
            summary.errors += 1;
            await emit({ recordType: 'lookup-error', ...error, query: queryOf(entry), charged: false, checkedAt: ctx.now.toISOString() });
            return;
        }

        if (entry.id) {
            let record = records.find((r) => String(r.entityId).replace(/^0+/, '') === entry.id.replace(/^0+/, '')) ?? records[0];
            if (!record && monitor && adapter.activeListOnly) {
                const prev = await store.get(snapshotKey(entry.state, entry.id));
                if (prev) record = absentRecord(prev, ctx.now);
            }
            if (!record) {
                summary.notFound += 1;
                await emit({
                    recordType: 'not-found',
                    code: 'NOT_FOUND',
                    message: `No entity with id "${entry.id}" in ${entry.state}${adapter.activeListOnly ? ' (this source lists active entities only)' : ''}. Nothing was charged.`,
                    query: queryOf(entry),
                    charged: false,
                    checkedAt: ctx.now.toISOString(),
                });
                return;
            }
            await emitEntity(entry, record, { monitored: monitor });
            return;
        }

        if (!records.length) {
            summary.notFound += 1;
            await emit({
                recordType: 'not-found',
                code: 'NOT_FOUND',
                message: `No entity matching "${entry.name}" in ${entry.state}. Nothing was charged.`,
                query: queryOf(entry),
                charged: false,
                checkedAt: ctx.now.toISOString(),
            });
            return;
        }

        const ranked = rankCandidates(entry.name, records, Math.min(10, Math.max(1, maxCandidates)));
        const exact = monitor && autoResolveExactName ? singleExactMatch(ranked) : null;
        for (const [i, cand] of ranked.entries()) {
            if (stop) return;
            const { matchScore, matchType, ...record } = cand;
            const resolved = exact && cand.entityId === exact.entityId;
            await emitEntity(entry, record, {
                monitored: Boolean(resolved),
                extra: {
                    matchScore,
                    matchType,
                    candidateRank: i + 1,
                    resolvedFromName: Boolean(resolved),
                    needsEntityId: monitor && !resolved,
                    hint: monitor && !resolved ? `Not monitored: add {"state":"${record.state}","id":"${record.entityId}"} to the watchlist to monitor this entity.` : undefined,
                },
            });
        }
    }

    for (const group of chunk(entries, concurrency)) {
        if (stop) break;
        const outcomes = await Promise.all(group.map(lookupEntry));
        for (const outcome of outcomes) {
            if (stop) break;
            await handleOutcome(outcome);
        }
    }

    summary.finishedAt = new Date().toISOString();
    summary.supportedStates = registry.states();
    return summary;
}
