import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDetail, parseSearchResults, buildSearchUrl, comparableName, nameOrder } from '../src/sunbiz.js';
import { annualReportStatus } from '../src/compliance.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(dir, 'fixtures', name), 'utf8');

test('search results list', () => {
    const { rows, nextUrl } = parseSearchResults(fixture('results-name.html'), 'entityName');
    assert.ok(rows.length >= 15, `expected many rows, got ${rows.length}`);
    assert.deepEqual(rows[0], {
        entityName: 'ACME CORPORATION',
        documentNumber: '112545',
        status: 'INACT',
        detailUrl: 'https://search.sunbiz.org/Inquiry/CorporationSearch/SearchResultDetail?inquirytype=EntityName&directionType=ForwardList&searchNameOrder=ACME%201125450&aggregateId=domp-112545-918af59c-789e-4606-9371-b8ff8235acb2&searchTerm=acme&listNameOrder=ACME%201125450',
    });
    assert.ok(rows.some((r) => r.entityName === 'ACME LLC' && r.status === 'Active'));
    assert.match(nextUrl, /inquiryDirectionType=ForwardList/);
    assert.match(nextUrl, /searchNameOrder=ACME230/);
});

test('detail page', () => {
    const d = parseDetail(fixture('detail-llc.html'), 'https://example.test/detail');
    assert.equal(d.entityType, 'Florida Limited Liability Company');
    assert.equal(d.entityName, 'ACME LLC');
    assert.equal(d.documentNumber, 'L15000160389');
    assert.equal(d.feiEin, '47-5125953');
    assert.equal(d.dateFiled, '09/21/2015');
    assert.equal(d.effectiveDate, '09/23/2015');
    assert.equal(d.state, 'FL');
    assert.equal(d.status, 'ACTIVE');
    assert.equal(d.lastEvent, 'REINSTATEMENT');
    assert.equal(d.eventDateFiled, '10/24/2016');
    assert.equal(d.principalAddress, '7705 MOWRY ST., JACKSONVILLE, FL 32256');
    assert.equal(d.mailingAddress, '7705 MOWRY ST., JACKSONVILLE, FL 32256');
    assert.equal(d.registeredAgentName, 'BALLARD, GLEN A');
    assert.equal(d.registeredAgentAddress, '7705 MOWRY ST., JACKSONVILLE, FL 32256');
    assert.deepEqual(d.registeredAgentNotes, ['Name Changed: 10/24/2016']);
    assert.equal(d.officerSectionTitle, 'Authorized Person(s) Detail');
    assert.deepEqual(d.officers, [{ title: 'MGR', name: 'BALLARD, GLEN A', address: '7705 MOWRY ST., JACKSONVILLE, FL 32256' }]);
    assert.deepEqual(d.annualReports, [
        { reportYear: 2024, filedDate: '01/17/2024' },
        { reportYear: 2025, filedDate: '01/03/2025' },
        { reportYear: 2026, filedDate: '01/26/2026' },
    ]);
    assert.equal(d.documents.length, 12);
    assert.deepEqual(d.documents[0], {
        date: '01/26/2026',
        documentType: 'ANNUAL REPORT',
        url: 'https://search.sunbiz.org/Inquiry/CorporationSearch/GetDocument?aggregateId=flal-l15000160389-49cf3f35-cde9-42e2-8bf2-837fe4d81017&transactionId=l15000160389-56889d17-8346-43ae-89f1-fde96b7043a0&formatType=PDF',
    });
    assert.equal(d.documents.at(-1).documentType, 'Florida Limited Liability');
    assert.match(d.eventHistoryUrl, /EventHistory\?aggregateId=flal-l15000160389/);
});

test('annual report status', () => {
    const d = parseDetail(fixture('detail-llc.html'), 'x');
    const filed = annualReportStatus(d, new Date('2026-10-13T00:00:00Z'));
    assert.equal(filed.lastAnnualReportYear, 2026);
    assert.equal(filed.annualReportCurrent, true);
    assert.equal(filed.annualReportStatus, 'filed');
    assert.equal(filed.annualReportDueDate, null);
    assert.equal(filed.nextAnnualReportWindow, '2027-01-01');

    const notFiled = { ...d, annualReports: d.annualReports.filter((r) => r.reportYear < 2026) };
    assert.equal(annualReportStatus(notFiled, new Date('2026-03-01T00:00:00Z')).annualReportStatus, 'due');
    const late = annualReportStatus(notFiled, new Date('2026-06-01T00:00:00Z'));
    assert.equal(late.annualReportStatus, 'late_fee_applies');
    assert.equal(late.annualReportDueDate, '2026-05-01');
    assert.equal(late.dissolutionDeadline, '2026-09-18');
    assert.equal(annualReportStatus(notFiled, new Date('2026-10-01T00:00:00Z')).annualReportStatus, 'past_dissolution_deadline');

    const brandNew = { ...d, dateFiled: '02/02/2026', annualReports: [] };
    assert.equal(annualReportStatus(brandNew, new Date('2026-06-01T00:00:00Z')).annualReportStatus, 'not_yet_required');
    const inactive = { ...d, status: 'INACTIVE' };
    assert.equal(annualReportStatus(inactive, new Date('2026-06-01T00:00:00Z')).annualReportStatus, 'not_applicable_inactive');
});

test('helpers', () => {
    assert.equal(nameOrder('The Acme Company, LLC'), 'ACMECOMPANYLLC');
    assert.equal(comparableName('THE ACME COMPANY, LLC'), 'ACME');
    assert.equal(comparableName('A.C.M.E., INC.'), 'ACME');
    assert.equal(comparableName('ACME113 HOLDINGS LLC'), 'ACME113HOLDINGS');
    assert.equal(
        buildSearchUrl('entityName', 'acme'),
        'https://search.sunbiz.org/Inquiry/CorporationSearch/SearchResults?InquiryType=EntityName&inquiryDirectionType=ForwardList&searchNameOrder=ACME&SearchTerm=acme',
    );
    assert.match(buildSearchUrl('officerOrRegisteredAgent', 'Smith John'), /InquiryType=OfficerRegisteredAgentName.*searchNameOrder=SMITHJOHN/);
    assert.match(buildSearchUrl('feiEin', '47-5125953'), /InquiryType=FeiNumber.*searchNameOrder=475125953&SearchTerm=47-5125953/);
});
