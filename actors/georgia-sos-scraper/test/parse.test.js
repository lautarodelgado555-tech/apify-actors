import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    annualRegistrations,
    buildPageBody,
    buildSearchBody,
    isChallengePage,
    isDetailPage,
    isoDate,
    normalizeStatus,
    parseDetail,
    parseFilings,
    parseResults,
} from '../src/georgia.js';
import { annualReportStatus } from '../src/compliance.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(dir, 'fixtures', name), 'utf8');

test('search body matches the portal form', () => {
    assert.deepEqual(buildSearchBody('businessName', 'Delta', 'contains'), {
        'search.SearchType': 'BusinessName',
        'search.SearchValue': 'Delta',
        'search.SearchCriteria': 'Contains',
    });
    assert.equal(buildSearchBody('controlNumber', 'H853425')['search.SearchType'], 'ControlNo');
    assert.equal(buildSearchBody('registeredAgent', 'x')['search.SearchType'], 'AgentName');
    assert.equal(buildSearchBody('officer', 'x', 'exact')['search.SearchCriteria'], 'ExactMatch');
    assert.throws(() => buildSearchBody('nope', 'x'));
    assert.deepEqual(buildPageBody(3), { sortby: '', stype: 'a', pidx: '3' });
});

test('name search results', () => {
    const r = parseResults(fixture('results-delta-starts.html'));
    assert.equal(r.rows.length, 2);
    assert.equal(r.totalPages, 1);
    assert.equal(r.totalRecords, 2);
    assert.deepEqual(r.rows[1], {
        businessId: '567669',
        businessType: 'Foreign Profit Corporation',
        name: 'DELTA AIR LINES, INC.',
        controlNumber: 'H853425',
        entityType: 'Foreign Profit Corporation',
        principalAddress: '1030 Delta Blvd, Dept 982, Atlanta, GA, 30354, USA',
        registeredAgentName: 'Corporation Service Company',
        status: 'Active/Compliance',
    });
    assert.equal(r.rows[0].status, 'Dissolved');
});

test('paged results report page and totals', () => {
    const p1 = parseResults(fixture('results-delta-contains-p1.html'));
    assert.equal(p1.rows.length, 25);
    assert.equal(p1.page, 1);
    assert.equal(p1.totalPages, 76);
    assert.equal(p1.totalRecords, 1895);
    const p2 = parseResults(fixture('results-delta-contains-p2.html'));
    assert.equal(p2.rows.length, 25);
    assert.equal(p2.page, 2);
    assert.notEqual(p1.rows[0].businessId, p2.rows[0].businessId);
});

test('control number, agent, officer and llc results', () => {
    assert.equal(parseResults(fixture('results-control.html')).rows[0].controlNumber, 'H853425');
    const agent = parseResults(fixture('results-agent.html'));
    assert.equal(agent.rows.length, 25);
    assert.equal(agent.totalRecords, 59197);
    const officer = parseResults(fixture('results-officer.html'));
    assert.equal(officer.rows.length, 25);
    assert.equal(officer.totalPages, 15);
    const llc = parseResults(fixture('results-llc.html'));
    assert.equal(llc.rows.length, 3);
    assert.ok(llc.rows.every((x) => /Peach Holdings/i.test(x.name)));
});

test('no results', () => {
    const r = parseResults(fixture('results-none.html'));
    assert.equal(r.rows.length, 0);
    assert.equal(r.noData, true);
    assert.equal(r.error, 'No data found.');
});

test('challenge page is recognised', () => {
    assert.equal(isChallengePage('<html><head><title>Just a moment...</title>'), true);
    assert.equal(isChallengePage(fixture('results-delta-starts.html')), false);
    assert.equal(isDetailPage(fixture('detail-delta-id-only.html')), true);
    assert.equal(isDetailPage(fixture('results-delta-starts.html')), false);
});

test('detail page of a foreign corporation with officers', () => {
    const d = parseDetail(fixture('detail-delta-id-only.html'));
    assert.equal(d.name, 'DELTA AIR LINES, INC.');
    assert.equal(d.controlNumber, 'H853425');
    assert.equal(d.entityType, 'Foreign Profit Corporation');
    assert.equal(d.status, 'Active/Compliance');
    assert.equal(d.purpose, null);
    assert.equal(d.principalAddress, '1030 Delta Blvd, Dept 982, Atlanta, GA, 30354, USA');
    assert.equal(d.formationDate, '5/10/1967');
    assert.equal(d.formationDateIso, '1967-05-10');
    assert.equal(d.jurisdiction, 'Delaware');
    assert.equal(d.lastAnnualReportYear, 2026);
    assert.equal(d.registeredAgentName, 'Corporation Service Company');
    assert.equal(d.registeredAgentAddress, '2 SUN COURT, SUITE 400, PEACHTREE CORNERS, GA, 30092, USA');
    assert.equal(d.registeredAgentCounty, 'Gwinnett');
    assert.deepEqual(d.officers.map((o) => [o.name, o.title]), [
        ['Daniel C. Janki', 'CFO'],
        ['Edward H. Bastian', 'CEO'],
        ['Peter W. Carter', 'Secretary'],
    ]);
    assert.equal(d.officers[1].address, '1030 Delta Blvd, Dept 982, Atlanta, GA, 30354, USA');
});

test('detail page of a new LLC has no officers and no annual registration yet', () => {
    const d = parseDetail(fixture('detail-domestic-llc-new.html'));
    assert.equal(d.entityType, 'Domestic Limited Liability Company');
    assert.equal(d.jurisdiction, 'Georgia');
    assert.equal(d.naicsCode, 'Real Estate and Rental and Leasing');
    assert.equal(d.lastAnnualReportYear, null);
    assert.deepEqual(d.officers, []);
    assert.equal(d.registeredAgentName, 'Vinay Patel');
});

test('detail page of an administratively dissolved corporation', () => {
    const d = parseDetail(fixture('detail-admin-dissolved.html'));
    assert.equal(d.status, 'Admin. Dissolved');
    assert.equal(d.dissolvedDate, '07/09/2005');
    assert.equal(d.name, 'A-LINE MODEL & TALENT MARKETING, INC.');
    assert.equal(d.lastAnnualReportYear, 2002);
    assert.equal(d.officers[0].address, null);
});

test('other entity types parse', () => {
    assert.equal(parseDetail(fixture('detail-foreign-llc.html')).jurisdiction, 'Florida');
    assert.equal(parseDetail(fixture('detail-foreign-withdrawn.html')).status, 'Withdrawn');
    assert.equal(parseDetail(fixture('detail-merged-credit-union.html')).entityType, 'Domestic Credit Union');
    assert.equal(parseDetail(fixture('detail-domestic-nonprofit-new.html')).name, "44 SHADES OF DARKNESS, DELTA NU W'96, Inc.");
});

test('filing history and annual registrations', () => {
    const p1 = parseFilings(fixture('filings-delta-p1.html'));
    assert.equal(p1.filings.length, 25);
    assert.equal(p1.totalPages, 2);
    assert.deepEqual(p1.filings[0], { filingNumber: '00769727', filedDate: '1967-05-10', effectiveDate: null, type: 'Business Formation' });
    const p2 = parseFilings(fixture('filings-delta-p2.html'));
    assert.equal(p2.page, 2);
    assert.equal(p2.filings.length, 8);
    const ar = annualRegistrations([...p1.filings, ...p2.filings]);
    assert.deepEqual(ar.at(-1), { year: 2026, filedDate: '2026-02-06', amended: false });
    assert.ok(ar.some((a) => a.amended));
    const llc = parseFilings(fixture('filings-llc.html'));
    assert.equal(llc.filings.length, 1);
    assert.deepEqual(annualRegistrations(llc.filings), []);
});

test('status vocabulary', () => {
    assert.deepEqual(normalizeStatus('Active/Compliance'), { active: true, goodStanding: true, statusNormalized: 'active_good_standing' });
    assert.deepEqual(normalizeStatus('Active/Owes AR'), { active: true, goodStanding: false, statusNormalized: 'active_owes_annual_registration' });
    assert.equal(normalizeStatus('Admin. Dissolved').statusNormalized, 'administratively_dissolved');
    assert.equal(normalizeStatus('Dissolved').active, false);
    assert.equal(normalizeStatus('Revoked').statusNormalized, 'revoked');
    assert.equal(normalizeStatus('Withdrawn').statusNormalized, 'withdrawn');
    assert.equal(normalizeStatus('Merged').statusNormalized, 'merged_or_converted');
    assert.equal(normalizeStatus('').statusNormalized, 'unknown');
    assert.equal(isoDate('5/10/1967'), '1967-05-10');
    assert.equal(isoDate('nonsense'), null);
});

test('annual report status', () => {
    const at = (iso) => new Date(`${iso}T12:00:00Z`);
    const active = { status: 'Active/Compliance', formationDate: '5/10/1967' };
    assert.deepEqual(annualReportStatus({ ...active, lastAnnualReportYear: 2026 }, at('2026-10-13')), {
        lastAnnualReportYear: 2026,
        annualReportCurrent: true,
        annualReportStatus: 'filed',
        annualReportDueDate: null,
        lateFeeApplies: false,
        lateFeeUsd: null,
        portalOwesAnnualRegistration: false,
        nextAnnualReportWindow: '2027-01-01',
    });
    // not filed yet, inside the Jan 1 - Apr 1 window
    const due = annualReportStatus({ ...active, lastAnnualReportYear: 2025 }, at('2026-02-10'));
    assert.equal(due.annualReportStatus, 'due');
    assert.equal(due.annualReportDueDate, '2026-04-01');
    assert.equal(due.lateFeeApplies, false);
    assert.equal(due.annualReportCurrent, false);
    assert.equal(due.nextAnnualReportWindow, '2026-01-01');
    // not filed, after April 1
    const late = annualReportStatus({ status: 'Active/Owes AR', formationDate: '1/1/2010', lastAnnualReportYear: 2024 }, at('2026-10-13'));
    assert.equal(late.annualReportStatus, 'late_fee_applies');
    assert.equal(late.lateFeeApplies, true);
    assert.equal(late.lateFeeUsd, 25);
    assert.equal(late.portalOwesAnnualRegistration, true);
    // formed this year: first registration is due next year
    const fresh = annualReportStatus({ status: 'Active/Compliance', formationDate: '5/13/2026', lastAnnualReportYear: null }, at('2026-10-13'));
    assert.equal(fresh.annualReportStatus, 'not_yet_required');
    assert.equal(fresh.annualReportCurrent, true);
    assert.equal(fresh.nextAnnualReportWindow, '2027-01-01');
    // filed in advance for a later year counts for this year
    assert.equal(annualReportStatus({ ...active, lastAnnualReportYear: 2027 }, at('2026-10-13')).annualReportStatus, 'filed');
    // inactive
    const gone = annualReportStatus({ status: 'Admin. Dissolved', formationDate: '12/4/1997', lastAnnualReportYear: 2002 }, at('2026-10-13'));
    assert.equal(gone.annualReportStatus, 'not_applicable_inactive');
    assert.equal(gone.annualReportCurrent, null);
    assert.equal(gone.nextAnnualReportWindow, null);
});
