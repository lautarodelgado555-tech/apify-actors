/**
 * Connecticut Secretary of the State business registry, via data.ct.gov (Socrata, updated daily):
 *   n7gp-d28j  Business Master   (status, sub_status, annual_report_due_date, dissolution_date)
 *   ah3s-bes7  Business Filing History   (annual report filing dates; `account` = Master.id)
 *   qh2m-n44y  Agents            (registered agent; `business_id` = Master.accountnumber)
 * Verified live from a GitHub runner on 2026-10-14.
 *
 * Connecticut is the best-covered state: the registry itself states the annual report due date and a sub-status
 * ("Annual report past due", "Ready for dissolution"...). entityId is the public Business ID (accountnumber).
 */
import { clean, joinParts, makeRecord } from '../canonical.js';
import { SourceError } from '../http.js';
import { datasetUpdatedAt, inList, likeTerm, soda, sodaUrl } from '../socrata.js';
import { candidateWindow, digitsOnly, preRank } from './_util.js';

const DOMAIN = 'data.ct.gov';
const MASTER = 'n7gp-d28j';
const FILINGS = 'ah3s-bes7';
const AGENTS = 'qh2m-n44y';
const SOURCE = 'Connecticut Secretary of the State via data.ct.gov (Business Registry - Business Master)';

/** Master.status values (lower case) -> canonical. Observed live on 2026-10-14. */
const STATUS = {
    active: { status: 'active', goodStanding: true },
    forfeited: { status: 'dissolved', goodStanding: false },
    dissolved: { status: 'dissolved', goodStanding: false },
    revoked: { status: 'dissolved', goodStanding: false },
    withdrawn: { status: 'inactive', goodStanding: false },
    cancelled: { status: 'inactive', goodStanding: false },
    merged: { status: 'inactive', goodStanding: false },
    expired: { status: 'inactive', goodStanding: false },
    renunciated: { status: 'inactive', goodStanding: false },
    redomesticated: { status: 'inactive', goodStanding: false },
    domesticated: { status: 'inactive', goodStanding: false },
    consolidation: { status: 'inactive', goodStanding: false },
    converted: { status: 'inactive', goodStanding: false },
    'converted out': { status: 'inactive', goodStanding: false },
    removed: { status: 'inactive', goodStanding: false },
};
/** Name reservations and unfinished filings are not entities. */
const NOT_AN_ENTITY = ['Reserved', 'Expired Reservation', 'Reserved Cancel', 'Rejected', 'Pending Filing', 'Pending Merger', 'Pending Withdrawal', 'Recorded', 'Registered'];

/** Active-status sub-statuses that mean the entity is behind with the state. */
const BEHIND = /past due|ready for|admin dissolution initiated|no agent/i;

export function mapStatus(status, subStatus) {
    const base = STATUS[String(status ?? '').trim().toLowerCase()];
    if (!base) return { status: 'unknown', goodStanding: null };
    if (base.status === 'active') {
        if (BEHIND.test(subStatus ?? '')) return { status: 'delinquent', goodStanding: false };
        if (/fraudulent/i.test(subStatus ?? '')) return { status: 'active', goodStanding: null };
    }
    return base;
}

const TYPE = {
    stock: 'stock corporation',
    'non-stock': 'non-stock corporation',
    llc: 'limited liability company',
    'limited partnership': 'limited partnership',
    llp: 'limited liability partnership',
    'statutory trust': 'statutory trust',
    religious: 'religious corporation',
    'b corp': 'benefit corporation',
};

export function toRecord(row, { lastReportFiled, agent, freshness, now }) {
    const mapped = mapStatus(row.status, row.sub_status);
    const type = TYPE[String(row.business_type ?? '').toLowerCase()] ?? clean(row.business_type);
    const entityType = joinParts([row.citizenship, type], ' ');
    const stillRegistered = mapped.status === 'active' || mapped.status === 'delinquent';
    return makeRecord({
        state: 'CT',
        entityId: row.accountnumber,
        name: row.name,
        entityType,
        statusRaw: row.status,
        statusDetail: clean(row.sub_status) ?? clean(row.reason_for_administrative),
        status: mapped.status,
        goodStanding: mapped.goodStanding,
        formationDate: row.date_registration,
        statusDate: row.dissolution_date ?? null,
        annualReportDue: stillRegistered ? row.annual_report_due_date : null,
        annualReportDueNote: stillRegistered ? 'Stated by the Connecticut registry (Annual_Report_Due_Date).' : null,
        lastReportFiled,
        registeredAgent: agent?.name__c ?? null,
        registeredAgentAddress: agent?.business_address ?? null,
        source: SOURCE,
        sourceUrl: sodaUrl(DOMAIN, MASTER, { accountnumber: row.accountnumber }),
        mode: 'opendata',
        dataFreshness: freshness,
        checkedAt: now.toISOString(),
        details: {
            registryRecordId: row.id,
            businessTypeCode: row.business_type ?? null,
            formationPlace: row.formation_place ?? null,
            reasonForAdministrativeAction: clean(row.reason_for_administrative),
            naics: clean(row.naics_code),
        },
    });
}

async function enrich(ctx, rows) {
    const keys = rows.map((r) => r.id);
    const numbers = rows.map((r) => r.accountnumber);
    const [filings, agents] = await Promise.all([
        soda(ctx, DOMAIN, FILINGS, {
            $select: 'account,max(filing_date) as last',
            $group: 'account',
            $where: `account in(${inList(keys)}) and filing_type in('Annual Report','Organization and First Report') and filing_date is not null`,
        }),
        soda(ctx, DOMAIN, AGENTS, { $where: `business_id in(${inList(numbers)})`, $limit: 200 }),
    ]);
    return {
        last: new Map(filings.map((f) => [f.account, f.last])),
        agents: new Map(agents.map((a) => [String(a.business_id), a])),
    };
}

export const adapter = {
    state: 'CT',
    stateName: 'Connecticut',
    mode: 'opendata',
    activeListOnly: false,
    source: SOURCE,
    sourceUrl: 'https://data.ct.gov/d/n7gp-d28j',
    officialSearchUrl: 'https://service.ct.gov/business/s/onlinebusinesssearch',
    supports: { annualReportDue: true, lastReportFiled: true, registeredAgent: true },

    async lookup({ id, name, limit, activeOnly }, ctx) {
        let rows;
        if (id) {
            const digits = digitsOnly(id);
            if (!digits || digits.length > 10) throw new SourceError(`"${id}" is not a Connecticut Business ID`);
            rows = await soda(ctx, DOMAIN, MASTER, { accountnumber: digits.padStart(7, '0'), $limit: 1 });
        } else {
            const term = likeTerm(name);
            if (term.length < 2) throw new SourceError('Name must have at least 2 characters');
            let where = `upper(name) like '${term}%' and status not in(${inList(NOT_AN_ENTITY)})`;
            if (activeOnly) where += " and status='Active'";
            rows = await soda(ctx, DOMAIN, MASTER, { $where: where, $order: 'name', $limit: candidateWindow(limit) });
            rows = preRank(name, rows, (r) => r.name, limit);
        }
        if (!rows.length) return [];
        const [freshness, extra] = await Promise.all([datasetUpdatedAt(ctx, DOMAIN, MASTER), enrich(ctx, rows)]);
        return rows.map((row) =>
            toRecord(row, {
                lastReportFiled: extra.last.get(row.id) ?? null,
                agent: extra.agents.get(String(row.accountnumber)),
                freshness,
                now: ctx.now,
            }));
    },
};

export default adapter;
