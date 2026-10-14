import { Actor, log } from 'apify';
import { makeFetchJson } from './http.js';
import { processWatchlist } from './monitor.js';
import { loadRegistry } from './registry.js';

const FREE_PLAN_CHECK_CAP = 10;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'check',
    watchlist = [],
    maxCandidates = 3,
    activeOnly = false,
    autoResolveExactName = false,
    maxChecks = 500,
    snapshotStoreName = 'us-business-status-snapshots',
} = input;

if (!['check', 'monitor'].includes(mode)) await Actor.fail('Input "mode" must be "check" or "monitor".');
if (!Array.isArray(watchlist) || watchlist.length === 0) {
    await Actor.fail('Input "watchlist" must contain at least one entry such as {"state": "TX", "id": "32070357671"} or {"state": "CO", "name": "Acme"}.');
}
if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(snapshotStoreName)) {
    await Actor.fail('Input "snapshotStoreName" must be 3-63 characters: lowercase letters, digits and hyphens.');
}

const registry = await loadRegistry();
const isPayPerEvent = Actor.getChargingManager().getPricingInfo().isPayPerEvent;

// Free plan users get a small per-run allowance so the Store listing stays healthy.
const paying = process.env.APIFY_USER_IS_PAYING === '1';
const effectiveMax = paying ? maxChecks : Math.min(maxChecks, FREE_PLAN_CHECK_CAP);
if (!paying) log.info(`Free-plan allowance: at most ${FREE_PLAN_CHECK_CAP} entity checks per run. Paid plans have no per-run cap other than "maxChecks".`);

const kvs = mode === 'monitor' ? await Actor.openKeyValueStore(snapshotStoreName) : null;
const store = {
    get: (key) => (kvs ? kvs.getValue(key) : Promise.resolve(undefined)),
    set: (key, value) => (kvs ? kvs.setValue(key, value) : Promise.resolve()),
};

const charge = async (eventName) => {
    if (!isPayPerEvent) return { ok: true, limitReached: false };
    const res = await Actor.charge({ eventName });
    return { ok: res.chargedCount > 0, limitReached: Boolean(res.eventChargeLimitReached) };
};

const ctx = {
    fetchJson: makeFetchJson(),
    now: new Date(),
    cache: new Map(),
    log,
};

log.info(`Mode "${mode}", ${watchlist.length} watchlist entr${watchlist.length === 1 ? 'y' : 'ies'}. Supported states: ${registry.states().join(', ')}.`);

const summary = await processWatchlist({
    watchlist,
    mode,
    registry,
    store,
    charge,
    emit: (row) => Actor.pushData(row),
    ctx,
    options: { maxCandidates, activeOnly, autoResolveExactName, maxChecks: effectiveMax },
});

await Actor.setValue('OUTPUT', summary);
const message = `${summary.entityChecks} check(s)${mode === 'monitor' ? `, ${summary.changedEntities} entit${summary.changedEntities === 1 ? 'y' : 'ies'} changed, ${summary.newBaselines} new baseline(s)` : ''}, ${summary.notFound} not found, ${summary.errors} error(s)${summary.truncated ? ` | stopped early: ${summary.truncatedReason}` : ''}`;
log.info(message);
await Actor.setStatusMessage(message);

if (summary.entityChecks === 0 && summary.notFound === 0 && summary.errors > 0) {
    await Actor.fail('Nothing could be checked: see the lookup-error rows in the dataset (unsupported state, invalid entry, or the source blocked the request). Nothing was charged.');
}
await Actor.exit();
