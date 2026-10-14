import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isoDate, makeRecord, nextBusinessDay, nextOccurrence, toIso } from '../src/canonical.js';
import { diffRecords, snapshotKey, snapshotOf } from '../src/diff.js';
import { makeFetchJson, SourceError } from '../src/http.js';
import { coreName, normalizeName, rankCandidates, scoreMatch, singleExactMatch } from '../src/match.js';
import { loadRegistry, normalizeState, Registry, validateAdapter } from '../src/registry.js';
import { inList, likeTerm, sodaUrl, sq } from '../src/socrata.js';

// ---------- canonical ----------

test('isoDate understands every format the sources use', () => {
    assert.equal(isoDate('2026-01-16T00:00:00.000'), '2026-01-16');
    assert.equal(isoDate('04/01/2027'), '2027-04-01');
    assert.equal(isoDate('June 1, 2022'), '2022-06-01');
    assert.equal(isoDate(1773785948000), '2026-03-17');
    assert.equal(isoDate(new Date('2026-05-15T00:00:00Z')), '2026-05-15');
    assert.equal(isoDate('0001-01-01T00:00:00.000'), null); // CT placeholder
    assert.equal(isoDate(''), null);
    assert.equal(isoDate(null), null);
    assert.equal(isoDate('N/A'), null);
});

test('makeRecord fills every key and refuses invented vocabulary', () => {
    const base = { state: 'TX', entityId: '1', status: 'active', goodStanding: true, source: 's', checkedAt: '2026-10-14T00:00:00.000Z' };
    const rec = makeRecord(base);
    assert.equal(rec.annualReportDue, null);
    assert.equal(rec.annualReportDueBasis, null);
    assert.equal(rec.registeredAgent, null);
    assert.equal(makeRecord({ ...base, annualReportDue: '04/01/2027' }).annualReportDueBasis, 'source');
    assert.equal(makeRecord({ ...base, annualReportDue: '2027-05-17', annualReportDueBasis: 'statutory-rule' }).annualReportDueBasis, 'statutory-rule');
    assert.throws(() => makeRecord({ ...base, status: 'good standing' }), /not canonical/);
    assert.throws(() => makeRecord({ ...base, goodStanding: 'yes' }), /goodStanding/);
    assert.throws(() => makeRecord({ ...base, entityId: '' }), /entityId/);
    assert.throws(() => makeRecord({ ...base, state: 'Texas' }), /2-letter/);
    assert.equal(makeRecord({ ...base, goodStanding: undefined }).goodStanding, null);
});

test('date helpers', () => {
    assert.equal(toIso(nextBusinessDay(new Date('2027-05-15T00:00:00Z'))), '2027-05-17'); // Saturday
    assert.equal(toIso(nextBusinessDay(new Date('2026-05-15T00:00:00Z'))), '2026-05-15'); // Friday
    assert.equal(toIso(nextOccurrence(5, 15, new Date('2026-10-14T00:00:00Z'))), '2027-05-15');
    assert.equal(toIso(nextOccurrence(5, 15, new Date('2026-05-15T00:00:00Z'), { inclusive: true })), '2026-05-15');
});

// ---------- diff ----------

const snap = (over = {}) => ({
    state: 'CO', entityId: '1', name: 'ACME LLC', entityType: null, statusRaw: 'Good Standing', statusDetail: null, status: 'active',
    goodStanding: true, annualReportDue: null, annualReportDueBasis: null, lastReportFiled: null, registeredAgent: null,
    dataFreshness: null, checkedAt: '2026-10-01T00:00:00.000Z', ...over,
});

test('diff: no previous snapshot means no events', () => {
    assert.deepEqual(diffRecords(undefined, snap()), []);
    assert.deepEqual(diffRecords(snap(), snap({ checkedAt: '2026-10-14T00:00:00.000Z', dataFreshness: 'x' })), []);
});

test('diff: active to delinquent raises statusChanged, goodStandingChanged and newlyDelinquent', () => {
    const events = diffRecords(snap(), snap({ status: 'delinquent', statusRaw: 'Delinquent', goodStanding: false }));
    assert.deepEqual(events.map((e) => e.type), ['statusChanged', 'goodStandingChanged', 'newlyDelinquent']);
    assert.equal(events[0].before, 'active');
    assert.equal(events[0].after, 'delinquent');
    assert.equal(events[0].afterRaw, 'Delinquent');
    assert.equal(events[2].severity, 'high');
});

test('diff: delinquent to dissolved is dissolved but not newlyDelinquent', () => {
    const events = diffRecords(snap({ status: 'delinquent', goodStanding: false }), snap({ status: 'dissolved', statusRaw: 'Administratively Dissolved', goodStanding: false }));
    assert.deepEqual(events.map((e) => e.type), ['statusChanged', 'dissolved']);
});

test('diff: active to suspended counts as newly delinquent; reinstatement does not', () => {
    const down = diffRecords(snap(), snap({ status: 'suspended', goodStanding: false }));
    assert.ok(down.some((e) => e.type === 'newlyDelinquent'));
    const up = diffRecords(snap({ status: 'suspended', goodStanding: false }), snap());
    assert.deepEqual(up.map((e) => e.type), ['statusChanged', 'goodStandingChanged']);
    assert.equal(up[1].severity, 'info');
});

test('diff: losing good standing with an unchanged status is newly delinquent', () => {
    const events = diffRecords(snap(), snap({ goodStanding: false }));
    assert.deepEqual(events.map((e) => e.type), ['goodStandingChanged', 'newlyDelinquent']);
});

test('diff: null good standing never triggers goodStandingChanged', () => {
    assert.deepEqual(diffRecords(snap({ goodStanding: null }), snap({ goodStanding: true })), []);
    assert.deepEqual(diffRecords(snap({ goodStanding: true }), snap({ goodStanding: null })), []);
});

test('diff: source-stated due dates alert, statutory-rule dates never do', () => {
    const stated = diffRecords(
        snap({ annualReportDue: '2026-11-06', annualReportDueBasis: 'source' }),
        snap({ annualReportDue: '2027-11-06', annualReportDueBasis: 'source' }),
    );
    assert.deepEqual(stated.map((e) => e.type), ['annualReportDueChanged']);
    assert.equal(stated[0].before, '2026-11-06');
    assert.equal(stated[0].after, '2027-11-06');
    const rule = diffRecords(
        snap({ annualReportDue: '2026-05-15', annualReportDueBasis: 'statutory-rule' }),
        snap({ annualReportDue: '2027-05-17', annualReportDueBasis: 'statutory-rule' }),
    );
    assert.deepEqual(rule, []);
});

test('snapshotOf keeps only the monitored fields and keys are KVS-safe', () => {
    const rec = makeRecord({ state: 'CT', entityId: '0074441', status: 'active', goodStanding: true, source: 's', checkedAt: '2026-10-14T00:00:00.000Z', details: { big: 'x' } });
    const s = snapshotOf(rec);
    assert.equal(s.details, undefined);
    assert.equal(s.entityId, '0074441');
    assert.equal(snapshotKey('CT', '0074441'), 'CT_0074441');
    assert.equal(snapshotKey('NY', 'a/b c?'), 'NY_a_b_c_');
});

// ---------- match ----------

test('name normalization and scoring', () => {
    assert.equal(normalizeName('Smith & Wesson, Inc.'), 'SMITH AND WESSON INC');
    assert.equal(coreName('The Acme Company, LLC'), 'ACME');
    assert.equal(scoreMatch('Acme LLC', 'ACME, LLC').type, 'exact');
    assert.equal(scoreMatch('Acme', 'ACME, LLC').type, 'exact-ignoring-legal-suffix');
    assert.equal(scoreMatch('Acme', 'ACME LOGISTICS LLC').type, 'starts-with');
    assert.equal(scoreMatch('logistics acme', 'ACME LOGISTICS LLC').type, 'contains-all-words');
    assert.equal(scoreMatch('Zebra', 'ACME LOGISTICS LLC').score, 0);
    assert.ok(scoreMatch('Acme', 'ACME LOGISTICS LLC').score < scoreMatch('Acme', 'ACME, LLC').score);
});

test('rankCandidates sorts by score then live-before-dissolved and keeps the best N', () => {
    const recs = [
        { name: 'ACME OLD INC', status: 'dissolved', entityId: '3' },
        { name: 'ACME LLC', status: 'dissolved', entityId: '1' },
        { name: 'ACME INC', status: 'active', entityId: '2' },
        { name: 'ZEBRA CO', status: 'active', entityId: '4' },
    ];
    const ranked = rankCandidates('Acme', recs, 3);
    assert.deepEqual(ranked.map((r) => r.entityId), ['2', '1', '3']);
    assert.ok(ranked.every((r) => r.matchScore > 0 && r.matchType));
    assert.equal(singleExactMatch(rankCandidates('Acme LLC', [{ name: 'ACME LLC', status: 'active' }, { name: 'ACME LOGISTICS', status: 'active' }], 5)).name, 'ACME LLC');
    assert.equal(singleExactMatch(rankCandidates('Acme LLC', [{ name: 'ACME LLC', status: 'active' }, { name: 'ACME INC', status: 'active' }], 5)), null);
});

// ---------- socrata helpers ----------

test('SoQL helpers escape quotes and wildcards', () => {
    assert.equal(sq("O'Brien"), "O''Brien");
    assert.equal(likeTerm("o'brien 100%_"), "O''BRIEN 100");
    assert.equal(inList(['a', "b'c"]), "'a','b''c'");
    assert.equal(sodaUrl('data.x.gov', 'abcd-1234', { $limit: 1, a: undefined, b: 'x y' }), 'https://data.x.gov/resource/abcd-1234.json?$limit=1&b=x%20y');
});

// ---------- http ----------

const resp = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

test('fetchJson retries on 5xx and returns JSON', async () => {
    let n = 0;
    const fetchJson = makeFetchJson({ fetchImpl: async () => (++n < 3 ? resp(503, 'busy') : resp(200, [{ ok: 1 }])), backoffMs: 1 });
    assert.deepEqual(await fetchJson('https://x'), [{ ok: 1 }]);
    assert.equal(n, 3);
});

test('fetchJson fails closed on blocks and challenge pages without retrying', async () => {
    let n = 0;
    const blocked = makeFetchJson({ fetchImpl: async () => { n += 1; return resp(403, 'nope'); }, backoffMs: 1 });
    await assert.rejects(blocked('https://x'), (e) => e instanceof SourceError && e.blocked);
    assert.equal(n, 1);
    const challenge = makeFetchJson({ fetchImpl: async () => resp(200, '<html><title>Security Check</title></html>'), backoffMs: 1 });
    await assert.rejects(challenge('https://x'), (e) => e.blocked === true && /challenge/.test(e.message));
});

test('fetchJson gives up after the retry budget', async () => {
    const fetchJson = makeFetchJson({ fetchImpl: async () => resp(500, 'x'), retries: 1, backoffMs: 1 });
    await assert.rejects(fetchJson('https://x'), /HTTP 500/);
});

// ---------- registry ----------

test('registry discovers the shipped adapters and validates the contract', async () => {
    const registry = await loadRegistry();
    assert.deepEqual(registry.states(), ['CO', 'CT', 'DC', 'NY', 'OR', 'TX']);
    for (const a of registry.list()) {
        assert.equal(a.mode, 'opendata');
        assert.ok(a.sourceUrl && a.officialSearchUrl && a.supports);
        validateAdapter(a);
    }
    assert.equal(registry.get('tx').stateName, 'Texas');
    assert.equal(registry.get('FL'), null);
});

test('registry rejects duplicate states and malformed adapters', () => {
    const ok = { state: 'ZZ', stateName: 'Test', mode: 'live', source: 's', lookup: async () => [] };
    const reg = new Registry([ok]);
    assert.throws(() => reg.register({ ...ok }), /Two adapters/);
    assert.throws(() => validateAdapter({ ...ok, mode: 'scrape' }), /mode/);
    assert.throws(() => validateAdapter({ ...ok, state: 'zz' }), /2-letter/);
    assert.throws(() => validateAdapter({ state: 'ZZ' }), /missing/);
});

test('normalizeState accepts codes and a few names', () => {
    assert.equal(normalizeState('tx'), 'TX');
    assert.equal(normalizeState(' Texas '), 'TX');
    assert.equal(normalizeState('District of Columbia'), 'DC');
    assert.equal(normalizeState('Delaware'), null);
    assert.equal(normalizeState(''), null);
});
