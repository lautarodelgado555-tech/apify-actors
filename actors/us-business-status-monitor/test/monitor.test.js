import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeRecord } from '../src/canonical.js';
import { snapshotKey, snapshotOf } from '../src/diff.js';
import { SourceError } from '../src/http.js';
import { processWatchlist } from '../src/monitor.js';
import { Registry } from '../src/registry.js';
import connecticut from '../src/adapters/connecticut.js';
import { fixture, makeCtx, memoryStore, metaRoutes } from './helpers.js';

const NOW = '2026-10-14T12:00:00.000Z';

function rec(over = {}) {
    return makeRecord({
        state: 'ZZ', entityId: '100', name: 'ACME LLC', status: 'active', goodStanding: true, statusRaw: 'Good Standing',
        source: 'fake', checkedAt: NOW, ...over,
    });
}

/** A scripted adapter. `db` is mutated between runs to simulate the state changing its data. */
function fakeAdapter({ db, state = 'ZZ', activeListOnly = false, failWith = null } = {}) {
    return {
        state, stateName: 'Zzland', mode: 'opendata', activeListOnly, source: 'fake',
        async lookup({ id, name }) {
            if (failWith) throw failWith;
            if (id) return db.filter((r) => r.entityId === id);
            return db.filter((r) => r.name.toUpperCase().includes(name.toUpperCase()));
        },
    };
}

function harness({ adapters, store = memoryStore(), chargeBudget = Infinity, now = NOW } = {}) {
    const rows = [];
    const charges = [];
    let budget = chargeBudget;
    const charge = async (event) => {
        if (budget <= 0) return { ok: false, limitReached: true };
        budget -= 1;
        charges.push(event);
        return { ok: true, limitReached: budget === 0 };
    };
    const ctx = { fetchJson: async () => { throw new Error('no network in this test'); }, now: new Date(now), cache: new Map(), log: { info() {}, debug() {}, warning() {} } };
    const run = (watchlist, mode, options = {}) =>
        processWatchlist({
            watchlist, mode, registry: new Registry(adapters), store, charge, emit: async (r) => { rows.push(r); }, ctx, options,
        });
    return { rows, charges, store, run, ctx };
}

const byType = (rows, t) => rows.filter((r) => r.recordType === t);

test('check mode: one id lookup is one charged check, no snapshot is written', async () => {
    const db = [rec()];
    const h = harness({ adapters: [fakeAdapter({ db })] });
    const summary = await h.run([{ state: 'ZZ', id: '100' }], 'check');
    assert.equal(h.rows.length, 1);
    assert.equal(h.rows[0].recordType, 'entity-check');
    assert.equal(h.rows[0].entityId, '100');
    assert.equal(h.rows[0].monitored, false);
    assert.deepEqual(h.charges, ['entity-check']);
    assert.equal(h.store.data.size, 0);
    assert.equal(summary.entityChecks, 1);
});

test('monitor mode: baseline on first run, change-alert when status changes, quiet when nothing changes', async () => {
    const db = [rec()];
    const h = harness({ adapters: [fakeAdapter({ db })] });
    const watch = [{ state: 'ZZ', id: '100' }];

    // Run 1: baseline, no alert.
    let s = await h.run(watch, 'monitor');
    assert.equal(s.newBaselines, 1);
    assert.equal(h.rows[0].firstSeen, true);
    assert.equal(h.rows[0].changed, false);
    assert.deepEqual(h.charges, ['entity-check']);
    assert.equal(h.store.data.get(snapshotKey('ZZ', '100')).status, 'active');

    // Run 2: the state marks the entity delinquent.
    h.rows.length = 0; h.charges.length = 0;
    db[0] = rec({ status: 'delinquent', goodStanding: false, statusRaw: 'Delinquent', checkedAt: '2026-10-15T12:00:00.000Z' });
    s = await h.run(watch, 'monitor');
    assert.deepEqual(h.charges, ['entity-check', 'change-alert']);
    const [check, alert] = h.rows;
    assert.equal(check.recordType, 'entity-check');
    assert.equal(check.firstSeen, false);
    assert.equal(check.changed, true);
    assert.deepEqual(check.changeTypes, ['statusChanged', 'goodStandingChanged', 'newlyDelinquent']);
    assert.equal(alert.recordType, 'change-alert');
    assert.deepEqual(alert.eventTypes, ['statusChanged', 'goodStandingChanged', 'newlyDelinquent']);
    assert.equal(alert.previous.status, 'active');
    assert.equal(alert.current.status, 'delinquent');
    assert.equal(alert.events[0].before, 'active');
    assert.equal(alert.events[0].after, 'delinquent');
    assert.match(alert.summary, /ACME LLC \(ZZ\)/);
    assert.equal(s.changeAlerts, 1);
    assert.equal(s.changedEntities, 1);
    assert.equal(s.changeEvents.length, 3);
    assert.equal(h.store.data.get(snapshotKey('ZZ', '100')).status, 'delinquent');

    // Run 3: same data, nothing to report, only the check is charged.
    h.rows.length = 0; h.charges.length = 0;
    s = await h.run(watch, 'monitor');
    assert.deepEqual(h.charges, ['entity-check']);
    assert.equal(h.rows[0].changed, false);
    assert.equal(s.changeAlerts, 0);
});

test('monitor mode: dissolved entity raises the dissolved event', async () => {
    const db = [rec({ status: 'delinquent', goodStanding: false })];
    const store = memoryStore({ [snapshotKey('ZZ', '100')]: snapshotOf(db[0]) });
    const h = harness({ adapters: [fakeAdapter({ db })], store });
    db[0] = rec({ status: 'dissolved', goodStanding: false, statusRaw: 'Administratively Dissolved' });
    const s = await h.run([{ state: 'ZZ', id: '100' }], 'monitor');
    assert.deepEqual(s.changeEvents.map((e) => e.type), ['statusChanged', 'dissolved']);
});

test('invalid entries, unknown states and duplicates cost nothing', async () => {
    const h = harness({ adapters: [fakeAdapter({ db: [rec()] })] });
    const s = await h.run([
        { state: 'QQ', id: '1' },
        { state: 'ZZ' },
        { id: '5' },
        { state: 'ZZ', id: '100' },
        { state: 'zz', id: '100' },
    ], 'check');
    assert.equal(h.charges.length, 1);
    const errors = byType(h.rows, 'lookup-error');
    assert.deepEqual(errors.map((e) => e.code).sort(), ['INVALID_ENTRY', 'INVALID_ENTRY', 'UNSUPPORTED_STATE']);
    assert.match(errors.find((e) => e.code === 'UNSUPPORTED_STATE').message, /Supported: ZZ/);
    assert.ok(errors.every((e) => e.charged === false));
    assert.equal(s.errors, 3);
    assert.equal(byType(h.rows, 'entity-check').length, 1);
});

test('not found is reported, not charged', async () => {
    const h = harness({ adapters: [fakeAdapter({ db: [rec()] })] });
    const s = await h.run([{ state: 'ZZ', id: '404' }, { state: 'ZZ', name: 'No Such Company' }], 'check');
    assert.equal(h.charges.length, 0);
    assert.deepEqual(h.rows.map((r) => r.recordType), ['not-found', 'not-found']);
    assert.equal(h.rows[0].charged, false);
    assert.equal(s.notFound, 2);
});

test('blocked sources fail closed with an uncharged row', async () => {
    const h = harness({ adapters: [fakeAdapter({ db: [], failWith: new SourceError('Source refused the request (HTTP 403)', { status: 403, blocked: true }) })] });
    const s = await h.run([{ state: 'ZZ', id: '1' }], 'check');
    assert.equal(h.charges.length, 0);
    assert.equal(h.rows[0].code, 'SOURCE_BLOCKED');
    assert.equal(s.errors, 1);
    const h2 = harness({ adapters: [fakeAdapter({ db: [], failWith: new Error('boom') })] });
    await h2.run([{ state: 'ZZ', id: '1' }], 'check');
    assert.equal(h2.rows[0].code, 'SOURCE_ERROR');
});

test('name search returns scored candidates; monitor mode requires an id unless one exact match is auto-resolved', async () => {
    const db = [rec({ entityId: '1', name: 'ACME LLC' }), rec({ entityId: '2', name: 'ACME LOGISTICS INC' }), rec({ entityId: '3', name: 'ACMEX CORP' })];
    const h = harness({ adapters: [fakeAdapter({ db })] });
    await h.run([{ state: 'ZZ', name: 'Acme' }], 'monitor', { maxCandidates: 2 });
    assert.equal(h.rows.length, 2);
    assert.equal(h.charges.length, 2);
    assert.ok(h.rows.every((r) => r.matchScore > 0 && r.monitored === false && r.needsEntityId === true));
    assert.match(h.rows[0].hint, /"id":"/);
    assert.equal(h.store.data.size, 0);
    assert.equal(h.rows[0].entityId, '1'); // exact-ignoring-suffix beats starts-with

    const h2 = harness({ adapters: [fakeAdapter({ db })] });
    await h2.run([{ state: 'ZZ', name: 'Acme LLC' }], 'monitor', { maxCandidates: 3, autoResolveExactName: true });
    const resolved = h2.rows.find((r) => r.resolvedFromName);
    assert.equal(resolved.entityId, '1');
    assert.equal(resolved.monitored, true);
    assert.equal(h2.store.data.size, 1);

    const h3 = harness({ adapters: [fakeAdapter({ db })] });
    await h3.run([{ state: 'ZZ', name: 'Acme' }], 'monitor', { maxCandidates: 3, autoResolveExactName: true });
    assert.equal(h3.store.data.size, 0); // not an exact match, so nothing is monitored
});

test('active-list-only sources: a vanished entity becomes an inactive change; never-seen ids are not found', async () => {
    const db = [rec({ entityId: '9' })];
    const adapter = fakeAdapter({ db, activeListOnly: true });
    const h = harness({ adapters: [adapter] });
    await h.run([{ state: 'ZZ', id: '9' }], 'monitor');
    h.rows.length = 0; h.charges.length = 0;
    db.length = 0; // entity disappears from the active dataset
    const s = await h.run([{ state: 'ZZ', id: '9' }], 'monitor');
    const check = h.rows[0];
    assert.equal(check.recordType, 'entity-check');
    assert.equal(check.status, 'inactive');
    assert.equal(check.goodStanding, false);
    assert.match(check.statusRaw, /Absent from/);
    assert.deepEqual(check.changeTypes, ['statusChanged', 'goodStandingChanged']);
    assert.equal(s.changeAlerts, 1);

    const h2 = harness({ adapters: [adapter] });
    await h2.run([{ state: 'ZZ', id: '12345' }], 'monitor');
    assert.equal(h2.rows[0].recordType, 'not-found');
    assert.equal(h2.charges.length, 0);
});

test('maxChecks caps the run and says so', async () => {
    const db = [rec({ entityId: '1' }), rec({ entityId: '2' }), rec({ entityId: '3' })];
    const h = harness({ adapters: [fakeAdapter({ db })] });
    const s = await h.run(db.map((r) => ({ state: 'ZZ', id: r.entityId })), 'check', { maxChecks: 2 });
    assert.equal(s.entityChecks, 2);
    assert.equal(s.truncated, true);
    assert.match(s.truncatedReason, /limit of 2 checks/);
    assert.equal(byType(h.rows, 'entity-check').length, 2);
});

test('a refused charge stops the run and does not update that entity\'s snapshot', async () => {
    const db = [rec({ entityId: '1' }), rec({ entityId: '2' })];
    const h = harness({ adapters: [fakeAdapter({ db })], chargeBudget: 1 });
    const s = await h.run([{ state: 'ZZ', id: '1' }, { state: 'ZZ', id: '2' }], 'monitor');
    assert.equal(s.truncated, true);
    assert.equal(byType(h.rows, 'entity-check').length, 1);
    assert.equal(h.store.data.size, 1);
    assert.ok(h.store.data.has(snapshotKey('ZZ', '1')));
});

test('end to end with the Connecticut adapter: a source-stated due date moving after a filing is reported', async () => {
    const [sbd] = fixture('ct-sbd');
    const previous = snapshotOf({
        ...makeRecord({
            state: 'CT', entityId: '0074441', name: 'STANLEY BLACK & DECKER, INC.', status: 'active', goodStanding: true, statusRaw: 'Active',
            annualReportDue: '2026-06-04', annualReportDueBasis: 'source', lastReportFiled: '2025-06-13', source: 's', checkedAt: '2026-05-01T00:00:00.000Z',
        }),
    });
    const store = memoryStore({ [snapshotKey('CT', '0074441')]: previous });
    const ctx = makeCtx([
        ['resource/n7gp-d28j.json?accountnumber=0074441', [sbd]],
        ['resource/ah3s-bes7', 'ct-hist-agg'],
        ['resource/qh2m-n44y', 'ct-agent-by-id'],
        ...metaRoutes,
    ]);
    const rows = [];
    const charges = [];
    const summary = await processWatchlist({
        watchlist: [{ state: 'CT', id: '0074441', label: 'SBD' }],
        mode: 'monitor',
        registry: new Registry([connecticut]),
        store,
        charge: async (e) => { charges.push(e); return { ok: true, limitReached: false }; },
        emit: async (r) => { rows.push(r); },
        ctx,
        options: {},
    });
    assert.deepEqual(charges, ['entity-check', 'change-alert']);
    const alert = rows.find((r) => r.recordType === 'change-alert');
    assert.deepEqual(alert.eventTypes, ['annualReportDueChanged']);
    assert.equal(alert.events[0].before, '2026-06-04');
    assert.equal(alert.events[0].after, '2027-06-04');
    assert.equal(rows[0].query.label, 'SBD');
    assert.equal(summary.changeEvents[0].entityId, '0074441');
    assert.equal(store.data.get(snapshotKey('CT', '0074441')).lastReportFiled, '2026-06-12');
});
