import assert from 'node:assert/strict';
import { test } from 'node:test';
import colorado, { mapStatus as coMap, splitName } from '../src/adapters/colorado.js';
import connecticut, { mapStatus as ctMap } from '../src/adapters/connecticut.js';
import dc, { mapStatus as dcMap } from '../src/adapters/dc.js';
import newyork from '../src/adapters/newyork.js';
import oregon from '../src/adapters/oregon.js';
import texas, { franchiseReportDue, mapStatus as txMap } from '../src/adapters/texas.js';
import { STATUSES } from '../src/canonical.js';
import { fixture, makeCtx, metaRoutes } from './helpers.js';

const NOW = '2026-10-14T12:00:00.000Z';
const ALL_KEYS = [
    'state', 'entityId', 'name', 'entityType', 'statusRaw', 'statusDetail', 'status', 'goodStanding', 'formationDate',
    'statusDate', 'annualReportDue', 'annualReportDueBasis', 'annualReportDueNote', 'lastReportFiled', 'registeredAgent',
    'registeredAgentAddress', 'source', 'sourceUrl', 'mode', 'dataFreshness', 'checkedAt', 'details',
];

function assertContract(rec) {
    for (const k of ALL_KEYS) assert.ok(k in rec, `missing key ${k}`);
    assert.ok(STATUSES.includes(rec.status));
    assert.ok([true, false, null].includes(rec.goodStanding));
    assert.equal(rec.checkedAt, NOW);
    if (rec.annualReportDue) assert.match(rec.annualReportDue, /^\d{4}-\d{2}-\d{2}$/);
    if (rec.annualReportDue) assert.ok(['source', 'statutory-rule'].includes(rec.annualReportDueBasis));
    else assert.equal(rec.annualReportDueBasis, null);
}

// ---------- Colorado ----------

test('Colorado: strips the status suffix Colorado appends to names', () => {
    assert.deepEqual(splitName('LRicheauxCMP, LLC, Delinquent June 1, 2022'), {
        name: 'LRicheauxCMP, LLC', statusNote: 'Delinquent', statusDate: '2022-06-01',
    });
    assert.equal(splitName('Zayo Bandwidth, LLC, Colorado Authority Relinquished February 10, 2012').name, 'Zayo Bandwidth, LLC');
    assert.equal(splitName('DENVER GAS COMPANY, Dissolved November 30, 1874').statusDate, '1874-11-30');
});

test('Colorado: delinquent entity looked up by id', async () => {
    const ctx = makeCtx([
        ['resource/4ykn-tg5h.json?entityid=20191893002', 'co-id'],
        ['resource/casm-dbbj', 'co-hist-agg'],
        ...metaRoutes,
    ]);
    const [rec] = await colorado.lookup({ id: '20191893002', limit: 1 }, ctx);
    assertContract(rec);
    assert.equal(rec.state, 'CO');
    assert.equal(rec.name, 'LRicheauxCMP, LLC');
    assert.equal(rec.statusRaw, 'Delinquent');
    assert.equal(rec.status, 'delinquent');
    assert.equal(rec.goodStanding, false);
    assert.equal(rec.statusDate, '2022-06-01');
    assert.equal(rec.lastReportFiled, '2021-01-29');
    assert.equal(rec.entityType, 'Domestic limited liability company');
    assert.equal(rec.registeredAgent, 'Lindsey Noel Richeaux');
    assert.equal(rec.annualReportDue, null);
    assert.equal(rec.dataFreshness, '2026-10-13T11:24:11.000Z');
    assert.match(rec.sourceUrl, /data\.colorado\.gov\/resource\/4ykn-tg5h\.json\?entityid=20191893002/);
});

test('Colorado: status mapping covers every value seen live', () => {
    const seen = ['Delinquent', 'Good Standing', 'Voluntarily Dissolved', 'Administratively Dissolved', 'Withdrawn', 'Noncompliant',
        'Revoked', 'Judicially Dissolved', 'Exists', 'Merged', 'Converted', 'Registered Agent Resigned', 'Effectiveness Prevented',
        'Dissolved (Term Expired)', 'Consolidated'];
    for (const raw of seen) assert.notEqual(coMap(raw).status, 'unknown', raw);
    assert.deepEqual(coMap('Good Standing'), { status: 'active', goodStanding: true });
    assert.deepEqual(coMap('Exists'), { status: 'active', goodStanding: null });
    assert.deepEqual(coMap('Something new'), { status: 'unknown', goodStanding: null });
});

test('Colorado: name search returns candidates with cleaned names', async () => {
    const ctx = makeCtx([['resource/4ykn-tg5h.json?$where', 'co-name'], ['resource/casm-dbbj', []], ...metaRoutes]);
    const recs = await colorado.lookup({ name: 'Zayo', limit: 5 }, ctx);
    assert.equal(recs.length, 5);
    recs.forEach(assertContract);
    assert.ok(recs.some((r) => r.name === 'Zayo Education, Inc.' && r.goodStanding === true));
    assert.ok(recs.filter((r) => r.statusRaw === 'Withdrawn').every((r) => r.status === 'inactive' && !/Relinquished/.test(r.name)));
});

// ---------- Texas ----------

test('Texas: active LLC gets goodStanding true and the statutory May 15 date', async () => {
    const ctx = makeCtx([['taxpayer_number=32070357671', [fixture('tx-in')[0]]], ...metaRoutes]);
    const [rec] = await texas.lookup({ id: '32070357671', limit: 1 }, ctx);
    assertContract(rec);
    assert.equal(rec.name, 'TESLA ALARM AND ELECTRICAL LLC');
    assert.equal(rec.status, 'active');
    assert.equal(rec.goodStanding, true);
    assert.equal(rec.entityType, 'Texas limited liability company');
    assert.equal(rec.annualReportDue, '2027-05-17'); // May 15, 2027 is a Saturday -> next business day
    assert.equal(rec.annualReportDueBasis, 'statutory-rule');
    assert.match(rec.annualReportDueNote, /comptroller\.texas\.gov/);
    assert.equal(rec.details.sosFileNumber, '0803287393');
    assert.match(rec.statusRaw, /Right to transact business: Active/);
});

test('Texas: forfeited franchise tax maps to suspended / not in good standing, with no due date', async () => {
    const [row] = fixture('tx-forfeited');
    const mapped = txMap(row);
    assert.deepEqual(mapped, { status: 'suspended', goodStanding: false });
    assert.equal(franchiseReportDue(row, mapped, new Date(NOW)), null);
});

test('Texas: Comptroller-assigned (type X) accounts are not claimed as suspended', () => {
    const [, tesla] = fixture('tx-in'); // type X with right-to-transact N
    assert.equal(tesla.record_type_code, 'X');
    assert.deepEqual(txMap(tesla), { status: 'inactive', goodStanding: null });
});

test('Texas: right-to-transact D is still active; first report is due the year after becoming liable', () => {
    const [row] = fixture('tx-notactive-other');
    assert.deepEqual(txMap(row), { status: 'active', goodStanding: true });
    // D = eligible for termination: no filing date is claimed
    assert.equal(franchiseReportDue(row, txMap(row), new Date(NOW)), null);
    const fresh = { ...row, right_to_transact_business_code: 'A', responsibility_beginning_date: '2026-03-01T00:00:00.000', current_exempt_reason_code: undefined };
    // Became liable in 2026 -> first report May 15, 2027 (a Saturday -> Monday the 17th)
    assert.equal(franchiseReportDue(fresh, txMap(fresh), new Date('2026-01-10T00:00:00Z')), '2027-05-17');
    // Exempt entity: no date
    assert.equal(franchiseReportDue({ ...fresh, current_exempt_reason_code: '19' }, txMap(fresh), new Date(NOW)), null);
    // Before May 15 of the same year for an older entity
    const old = { ...fresh, responsibility_beginning_date: '2015-03-01T00:00:00.000' };
    assert.equal(franchiseReportDue(old, txMap(old), new Date('2026-02-01T00:00:00Z')), '2026-05-15');
});

test('Texas: name search and file-number lookup', async () => {
    const ctx = makeCtx([['upper(taxpayer_name) like', 'tx-active-top'], ...metaRoutes]);
    const recs = await texas.lookup({ name: 'Acme', limit: 5, activeOnly: true }, ctx);
    assert.ok(recs.length > 0);
    recs.forEach(assertContract);
    assert.ok(ctx.fetchJson.calls.some((u) => u.includes("right_to_transact_business_code in('A','D')")));
    const ctx2 = makeCtx([['secretary_of_state_sos_or_coa_file_number=0803287393', [fixture('tx-in')[0]]], ...metaRoutes]);
    const [rec] = await texas.lookup({ id: '803287393', limit: 1 }, ctx2);
    assert.equal(rec.entityId, '32070357671');
});

// ---------- New York ----------

test('New York: active entity by id uses the status history and does not claim good standing', async () => {
    const ctx = makeCtx([
        ['resource/n9v6-gdp6.json?dos_id=4809335', 'ny-id'],
        ['resource/3gg2-jgnp.json?corpid_num=4809335', 'ny-hist-entity'],
        ...metaRoutes,
    ]);
    const [rec] = await newyork.lookup({ id: '4809335', limit: 1 }, ctx);
    assertContract(rec);
    assert.equal(rec.name, 'GOOGLE ACCESS LLC');
    assert.equal(rec.status, 'active');
    assert.equal(rec.goodStanding, null);
    assert.equal(rec.statusDate, '2025-08-05');
    assert.equal(rec.annualReportDue, null);
    assert.equal(rec.formationDate, '2015-08-24');
});

test('New York: entity missing from the active list is resolved through the histories', async () => {
    const ctx = makeCtx([
        ['resource/n9v6-gdp6.json?dos_id=4285', []],
        ['resource/3gg2-jgnp.json?corpid_num=4285', [fixture('ny-hist-suspended')[0]]],
        ['resource/ekwr-p59j', [{ corpid_num: '4285', corp_name: 'SOME OLD CORP' }]],
        ...metaRoutes,
    ]);
    const [rec] = await newyork.lookup({ id: '4285', limit: 1 }, ctx);
    assertContract(rec);
    assert.equal(rec.status, 'suspended');
    assert.equal(rec.goodStanding, false);
    assert.equal(rec.name, 'SOME OLD CORP');
    assert.equal(rec.details.listedAsActive, false);
});

test('New York: unknown id returns no records', async () => {
    const ctx = makeCtx([['resource/n9v6-gdp6', []], ['resource/3gg2-jgnp', []], ...metaRoutes]);
    assert.deepEqual(await newyork.lookup({ id: '999999999', limit: 1 }, ctx), []);
});

// ---------- Connecticut ----------

test('Connecticut: active entity with source-stated due date, last annual report and agent', async () => {
    const [sbd] = fixture('ct-sbd');
    const ctx = makeCtx([
        ['resource/n7gp-d28j.json?accountnumber=0074441', [sbd]],
        ['resource/ah3s-bes7', 'ct-hist-agg'],
        ['resource/qh2m-n44y', 'ct-agent-by-id'],
        ...metaRoutes,
    ]);
    const [rec] = await connecticut.lookup({ id: '74441', limit: 1 }, ctx);
    assertContract(rec);
    assert.equal(rec.entityId, '0074441');
    assert.equal(rec.status, 'active');
    assert.equal(rec.goodStanding, true);
    assert.equal(rec.annualReportDue, '2027-06-04');
    assert.equal(rec.annualReportDueBasis, 'source');
    assert.equal(rec.lastReportFiled, '2026-06-12');
    assert.equal(rec.registeredAgent, 'CORPORATION SERVICE COMPANY');
    assert.equal(rec.entityType, 'Domestic stock corporation');
});

test('Connecticut: sub-status drives delinquent; forfeited and dissolved are dissolved', () => {
    assert.deepEqual(ctMap('Active', 'Annual report past due'), { status: 'delinquent', goodStanding: false });
    assert.deepEqual(ctMap('Active', 'Ready for dissolution'), { status: 'delinquent', goodStanding: false });
    assert.deepEqual(ctMap('Active', 'Annual report due'), { status: 'active', goodStanding: true });
    assert.deepEqual(ctMap('Active', null), { status: 'active', goodStanding: true });
    assert.equal(ctMap('Forfeited', null).status, 'dissolved');
    assert.equal(ctMap('Dissolved', 'Annual report past due').status, 'dissolved');
    assert.equal(ctMap('Withdrawn', null).status, 'inactive');
    assert.equal(ctMap('Expired Reservation', null).status, 'unknown');
});

test('Connecticut: overdue first report is delinquent and keeps the overdue date; dissolved has no due date', async () => {
    const rows = fixture('ct-not-good');
    const ctx = makeCtx([
        ['resource/n7gp-d28j.json?accountnumber=2875280', [rows[1]]],
        ['resource/ah3s-bes7', []],
        ['resource/qh2m-n44y', []],
        ...metaRoutes,
    ]);
    const [late] = await connecticut.lookup({ id: '2875280', limit: 1 }, ctx);
    assert.equal(late.status, 'delinquent');
    assert.equal(late.statusDetail, 'First report past due');
    assert.equal(late.annualReportDue, '2024-10-17');
    assert.equal(late.lastReportFiled, null);

    const dissolved = fixture('ct-dissolved')[1];
    const ctx2 = makeCtx([
        ['resource/n7gp-d28j.json?accountnumber=2749250', [dissolved]],
        ['resource/ah3s-bes7', []],
        ['resource/qh2m-n44y', []],
        ...metaRoutes,
    ]);
    const [gone] = await connecticut.lookup({ id: '2749250', limit: 1 }, ctx2);
    assert.equal(gone.status, 'dissolved');
    assert.equal(gone.goodStanding, false);
    assert.equal(gone.annualReportDue, null);
    assert.equal(gone.statusDate, '2025-02-06');
});

test('Connecticut: name search excludes name reservations', async () => {
    const ctx = makeCtx([['resource/n7gp-d28j.json?$where', 'ct-sbd'], ['resource/ah3s-bes7', []], ['resource/qh2m-n44y', []], ...metaRoutes]);
    await connecticut.lookup({ name: 'Stanley Black', limit: 3 }, ctx);
    assert.ok(ctx.fetchJson.calls[0].includes("status not in('Reserved','Expired Reservation'"));
});

// ---------- Oregon ----------

test('Oregon: active list gives agent and, when published, the anniversary date', async () => {
    const ctx = makeCtx([
        ['resource/tckn-sxa6.json?$select', 'or-grouped'],
        ['resource/6g49-bcrm', 'or-in'],
        ['associated_name_type=\'REGISTERED AGENT\'', 'or-agent-in'],
        ...metaRoutes,
    ]);
    const recs = await oregon.lookup({ name: 'Nike', limit: 10 }, ctx);
    recs.forEach(assertContract);
    const alpha = recs.find((r) => r.entityId === '149629495');
    assert.equal(alpha.name, 'NIKE ALPHA FORCE LLC');
    assert.equal(alpha.status, 'active');
    assert.equal(alpha.goodStanding, null);
    assert.equal(alpha.annualReportDue, '2026-11-16');
    assert.equal(alpha.registeredAgent, 'UNITED AGENT GROUP INC.');
    assert.match(alpha.annualReportDueNote, /County Data/);
    const noDate = recs.find((r) => r.entityId === '42893685');
    assert.equal(noDate.annualReportDue, null);
    assert.equal(oregon.activeListOnly, true);
});

// ---------- DC ----------

test('DC: good standing is stated by the register; due date and last report come from the source', async () => {
    const ctx = makeCtx([['FILE_NUMBER=\'620118\'', 'dc-id']]);
    const [rec] = await dc.lookup({ id: '620118', limit: 1 }, ctx);
    assertContract(rec);
    assert.equal(rec.status, 'active');
    assert.equal(rec.goodStanding, true);
    assert.equal(rec.annualReportDue, '2028-04-01');
    assert.equal(rec.lastReportFiled, '2026-03-17');
    assert.equal(rec.dataFreshness, new Date(fixture('dc-id').features[0].attributes.DCS_LAST_MOD_DTTM).toISOString());
});

test('DC: non-active statuses carry no due date', async () => {
    const ctx = makeCtx([['LIKE \'MARRIOTT%\'', 'dc-name']]);
    const recs = await dc.lookup({ name: 'Marriott', limit: 5 }, ctx);
    assert.equal(recs.length, 5);
    for (const r of recs) {
        assertContract(r);
        assert.notEqual(r.status, 'active');
        assert.equal(r.annualReportDue, null);
    }
    assert.equal(recs.find((r) => r.statusRaw === 'Dissolved').status, 'dissolved');
    assert.equal(recs.find((r) => r.statusRaw === 'Merged').status, 'inactive');
});

test('DC: status vocabulary', () => {
    assert.deepEqual(dcMap('Active - In Good Standing'), { status: 'active', goodStanding: true });
    assert.deepEqual(dcMap('Active - Not in Good Standing'), { status: 'delinquent', goodStanding: false });
    assert.deepEqual(dcMap('Active - In Good Standing - Pending Domestication'), { status: 'active', goodStanding: true });
    assert.equal(dcMap('Revoked').status, 'dissolved');
    assert.equal(dcMap('Inactive - Cancelled').status, 'inactive');
    assert.equal(dcMap('Brand new value').status, 'unknown');
});

test('adapters reject malformed ids before touching the network', async () => {
    const ctx = makeCtx([]);
    await assert.rejects(colorado.lookup({ id: "x'; drop", limit: 1 }, ctx), /not a valid/);
    await assert.rejects(texas.lookup({ id: '123', limit: 1 }, ctx), /not a Texas/);
    await assert.rejects(dc.lookup({ id: "1' OR '1'='1", limit: 1 }, ctx), /not a valid/);
    await assert.rejects(newyork.lookup({ id: 'abc', limit: 1 }, makeCtx(metaRoutes)), /not a New York/);
    assert.equal(ctx.fetchJson.calls.length, 0);
});
