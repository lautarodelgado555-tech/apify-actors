/**
 * Texas Comptroller "Active Franchise Taxpayers" (data.texas.gov, Socrata dataset 9cir-efmm), updated by the
 * Comptroller about weekly. It lists every entity with a franchise tax account, including those whose right to
 * transact business was forfeited. Verified live from a GitHub runner on 2026-10-14.
 *
 * Code tables come from the dataset's own record layout ("Franchise Layout.docx", captured in
 * recon/us-business-status-monitor/out/tx-layout.txt):
 *   Right to Transact Business: A Active | D Active - eligible for termination/withdrawal | N Forfeited |
 *                               I Franchise tax involuntarily ended | U Franchise tax not established | blank Ended
 *   SOS status: A Active, R Reinstated, B Consolidated, C Converted, D Dissolved, E Expired,
 *               F/K/L/N/P Forfeited (tax, agent, office, hot check, court order), M Merger, T Terminated,
 *               W Withdrawn, I Closed by FDIC, J State charter pulled, G Miscellaneous, Y/Z Dead at conversion.
 *
 * Texas "Forfeited existence" on the SOS site is the franchise tax delinquency outcome; here it shows up as
 * right-to-transact N and/or SOS status F.
 *
 * annualReportDue: the annual franchise tax report is due May 15 (next business day when May 15 is a weekend),
 * and a new entity's first report is due May 15 of the year after it became subject to the tax:
 *   https://comptroller.texas.gov/taxes/franchise/  (Due Dates)
 *   https://comptroller.texas.gov/taxes/franchise/faq/reports-payments.php/1000  (first annual report)
 * This is a statutory date, not a per-entity value from the dataset (basis "statutory-rule"), and it is only
 * emitted for non-exempt entities in good standing.
 */
import { clean, isoDate, makeRecord, nextBusinessDay, toIso } from '../canonical.js';
import { SourceError } from '../http.js';
import { datasetUpdatedAt, inList, likeTerm, soda, sodaUrl } from '../socrata.js';
import { candidateWindow, digitsOnly, preRank } from './_util.js';

const DOMAIN = 'data.texas.gov';
const DATASET = '9cir-efmm';
const SOURCE = 'Texas Comptroller of Public Accounts via data.texas.gov (Active Franchise Taxpayers)';
export const DUE_DATE_SOURCE_URL = 'https://comptroller.texas.gov/taxes/franchise/';
export const FIRST_REPORT_SOURCE_URL = 'https://comptroller.texas.gov/taxes/franchise/faq/reports-payments.php/1000';

const RIGHT_TO_TRANSACT = {
    A: 'Active',
    D: 'Active - eligible for termination/withdrawal',
    N: 'Forfeited',
    I: 'Franchise tax involuntarily ended',
    U: 'Franchise tax not established',
    '': 'Franchise tax ended',
};

const SOS_STATUS = {
    A: 'Active', B: 'Consolidated', C: 'Converted', D: 'Dissolved', E: 'Expired',
    F: 'Forfeited franchise tax', G: 'Miscellaneous', I: 'Closed by FDIC', J: 'State charter pulled',
    K: 'Forfeited registered agent', L: 'Forfeited registered office', M: 'Merger', N: 'Forfeited hot check',
    P: 'Forfeited court order', R: 'Reinstated', T: 'Terminated', W: 'Withdrawn',
    Y: 'Dead at conversion 69', Z: 'Dead at conversion 83',
};

const RECORD_TYPE = {
    U: 'Secretary of State file number',
    V: 'Secretary of State certificate of authority number',
    X: 'Comptroller-assigned number (no Secretary of State registration)',
};

/** Taxpayer organizational type codes (record layout). */
const ORG_TYPE = {
    AB: 'Texas business association', AC: 'Foreign business association', AF: 'Foreign professional association',
    AP: 'Texas professional association', AR: 'Other association', C: 'Corporation', CF: 'Foreign profit corporation',
    CI: 'Foreign LLC (out of state)', CL: 'Texas limited liability company', CM: 'Foreign nonprofit corporation (out of state)',
    CN: 'Texas nonprofit corporation', CP: 'Texas professional corporation', CR: 'Texas insurance corporation',
    CS: 'Foreign insurance corporation (out of state)', CT: 'Texas profit corporation', CU: 'Foreign professional corporation',
    CW: 'Texas railroad corporation', CX: 'Foreign railroad corporation', DC: 'Registered data center', ES: 'Estate',
    HF: 'Foreign holding company', IS: 'Individual - sole owner', J: 'Joint venture', L: 'Limited (liability) company',
    M: 'Limited (liability) partnership', O: 'Other', P: 'General partnership', PB: 'Business general partnership',
    PF: 'Foreign limited partnership', PI: 'Individual general partnership', PL: 'Texas limited partnership',
    PO: 'Oil & gas special', PV: 'Texas joint venture', PW: 'Foreign joint venture', PX: 'Texas LLP registration',
    PY: 'Foreign LLP registration', PZ: 'Individual successor partnership', S: 'Sole proprietorship',
    SF: 'Foreign joint stock company', ST: 'Texas joint stock company', TF: 'Foreign business trust',
    TH: 'Texas real estate investment trust', TI: 'Foreign real estate investment trust', TR: 'Trust',
};

const SOS_FORFEITED = new Set(['F', 'K', 'L', 'N', 'P']);
const SOS_DISSOLVED = new Set(['D', 'E', 'T', 'J', 'I', 'Y', 'Z']);
const SOS_GONE = new Set(['W', 'M', 'C', 'B']);

const code = (v) => String(v ?? '').trim().toUpperCase();

/** Combine SOS status and right-to-transact into the canonical status. Order matters: SOS facts first. */
export function mapStatus(row) {
    const sos = code(row.sos_status_code);
    const rtb = code(row.right_to_transact_business_code);
    const recordType = code(row.record_type_code);

    if (recordType !== 'X') {
        if (SOS_FORFEITED.has(sos)) return { status: 'suspended', goodStanding: false };
        if (SOS_DISSOLVED.has(sos)) return { status: 'dissolved', goodStanding: false };
        if (SOS_GONE.has(sos)) return { status: 'inactive', goodStanding: false };
        if (sos === 'G') return { status: 'unknown', goodStanding: null };
    }
    // Comptroller-assigned accounts (type X) have no SOS registration; only the franchise account tells us anything.
    if (rtb === 'A' || rtb === 'D') return { status: 'active', goodStanding: true };
    if (rtb === 'N') return recordType === 'X' ? { status: 'inactive', goodStanding: null } : { status: 'suspended', goodStanding: false };
    if (rtb === 'I') return { status: recordType === 'X' ? 'inactive' : 'dissolved', goodStanding: false };
    if (rtb === 'U') return { status: recordType === 'X' ? 'unknown' : 'active', goodStanding: null };
    // blank: franchise tax ended
    return { status: recordType === 'X' ? 'inactive' : 'active', goodStanding: null };
}

/** Next May 15 (moved off weekends) the entity must file by, or null when the rule does not apply. */
export function franchiseReportDue(row, mapped, now) {
    if (mapped.status !== 'active' || mapped.goodStanding !== true) return null;
    if (code(row.right_to_transact_business_code) !== 'A') return null;
    const exempt = code(row.current_exempt_reason_code);
    if (exempt && exempt !== '00') return null;
    if (code(row.record_type_code) === 'X') return null;
    const since = isoDate(row.responsibility_beginning_date);
    if (!since) return null;
    const firstYear = Number(since.slice(0, 4)) + 1;
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    for (let y = Math.max(firstYear, now.getUTCFullYear()); y < now.getUTCFullYear() + 3; y += 1) {
        const d = nextBusinessDay(new Date(Date.UTC(y, 4, 15)));
        if (d.getTime() >= today) return toIso(d);
    }
    return null;
}

export function toRecord(row, { freshness, now }) {
    const mapped = mapStatus(row);
    const sos = code(row.sos_status_code);
    const rtb = code(row.right_to_transact_business_code);
    const due = franchiseReportDue(row, mapped, now);
    const statusRaw = `Right to transact business: ${RIGHT_TO_TRANSACT[rtb] ?? rtb ?? 'unknown'}${sos ? ` | SOS status: ${SOS_STATUS[sos] ?? sos}` : ''}`;
    return makeRecord({
        state: 'TX',
        entityId: row.taxpayer_number,
        name: row.taxpayer_name,
        entityType: ORG_TYPE[code(row.taxpayer_organizational_type)] ?? clean(row.taxpayer_organizational_type),
        statusRaw,
        status: mapped.status,
        goodStanding: mapped.goodStanding,
        formationDate: row.sos_charter_date,
        statusDate: row.sos_status_date,
        annualReportDue: due,
        annualReportDueBasis: 'statutory-rule',
        annualReportDueNote: due
            ? `Statutory franchise tax report date (May 15, next business day if a weekend; a new entity's first report is due May 15 of the year after it became subject to the tax). The open dataset does not say whether this year's report was already filed. Rule: ${DUE_DATE_SOURCE_URL} and ${FIRST_REPORT_SOURCE_URL}`
            : 'Texas does not publish a per-entity due date; the statutory May 15 rule is only applied to non-exempt entities in good standing.',
        lastReportFiled: null,
        source: SOURCE,
        sourceUrl: sodaUrl(DOMAIN, DATASET, { taxpayer_number: row.taxpayer_number }),
        mode: 'opendata',
        dataFreshness: freshness,
        checkedAt: now.toISOString(),
        details: {
            taxpayerNumber: row.taxpayer_number,
            sosFileNumber: clean(row.secretary_of_state_sos_or_coa_file_number),
            recordType: RECORD_TYPE[code(row.record_type_code)] ?? clean(row.record_type_code),
            organizationTypeCode: clean(row.taxpayer_organizational_type),
            rightToTransactCode: rtb || null,
            sosStatusCode: sos || null,
            exemptReasonCode: clean(row.current_exempt_reason_code),
            franchiseTaxLiableSince: isoDate(row.responsibility_beginning_date),
            mailingAddress: clean([row.taxpayer_address, row.taxpayer_city, row.taxpayer_state, row.taxpayer_zip].filter(Boolean).join(', ')),
        },
    });
}

export const adapter = {
    state: 'TX',
    stateName: 'Texas',
    mode: 'opendata',
    activeListOnly: false,
    source: SOURCE,
    sourceUrl: 'https://data.texas.gov/d/9cir-efmm',
    officialSearchUrl: 'https://mycpa.cpa.state.tx.us/coa/',
    supports: { annualReportDue: true, lastReportFiled: false, registeredAgent: false },

    async lookup({ id, name, limit, activeOnly }, ctx) {
        let rows;
        if (id) {
            const digits = digitsOnly(id);
            if (digits.length === 11) rows = await soda(ctx, DOMAIN, DATASET, { taxpayer_number: digits, $limit: 1 });
            else if (digits.length >= 8 && digits.length <= 10) {
                rows = await soda(ctx, DOMAIN, DATASET, { secretary_of_state_sos_or_coa_file_number: digits.padStart(10, '0'), $limit: 2 });
            } else throw new SourceError(`"${id}" is not a Texas taxpayer number (11 digits) or Secretary of State file number (10 digits)`);
        } else {
            const term = likeTerm(name);
            if (term.length < 2) throw new SourceError('Name must have at least 2 characters');
            let where = `upper(taxpayer_name) like '${term}%'`;
            if (activeOnly) where += ` and right_to_transact_business_code in(${inList(['A', 'D'])})`;
            rows = await soda(ctx, DOMAIN, DATASET, { $where: where, $order: 'taxpayer_name', $limit: candidateWindow(limit) });
            rows = preRank(name, rows, (r) => r.taxpayer_name, limit);
        }
        if (!rows.length) return [];
        const freshness = await datasetUpdatedAt(ctx, DOMAIN, DATASET);
        return rows.map((row) => toRecord(row, { freshness, now: ctx.now }));
    },
};

export default adapter;
