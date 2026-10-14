/**
 * Colorado Secretary of State "Business Entities in Colorado" (data.colorado.gov, Socrata dataset 4ykn-tg5h),
 * refreshed daily, plus "Business Entity Transaction History" (casm-dbbj) for the last periodic report.
 * Verified live from a GitHub runner on 2026-10-14 (no key, no login).
 *
 * The dataset has no due date, so annualReportDue is always null for Colorado (its periodic report window
 * depends on the entity's anniversary month and is not published as a date).
 */
import { clean, isoDate, joinParts, makeRecord } from '../canonical.js';
import { SourceError } from '../http.js';
import { datasetUpdatedAt, inList, likeTerm, sodaUrl, soda } from '../socrata.js';
import { candidateWindow, preRank } from './_util.js';

const DOMAIN = 'data.colorado.gov';
const MAIN = '4ykn-tg5h';
const HISTORY = 'casm-dbbj';
const SOURCE = 'Colorado Secretary of State via data.colorado.gov (Business Entities in Colorado)';

/** raw entitystatus (lower case) -> canonical. Values observed in the live dataset on 2026-10-14. */
export const STATUS_MAP = {
    'good standing': { status: 'active', goodStanding: true },
    exists: { status: 'active', goodStanding: null },
    delinquent: { status: 'delinquent', goodStanding: false },
    noncompliant: { status: 'delinquent', goodStanding: false },
    'registered agent resigned': { status: 'delinquent', goodStanding: false },
    'voluntarily dissolved': { status: 'dissolved', goodStanding: false },
    'administratively dissolved': { status: 'dissolved', goodStanding: false },
    'judicially dissolved': { status: 'dissolved', goodStanding: false },
    'dissolved (term expired)': { status: 'dissolved', goodStanding: false },
    revoked: { status: 'dissolved', goodStanding: false },
    withdrawn: { status: 'inactive', goodStanding: false },
    merged: { status: 'inactive', goodStanding: false },
    converted: { status: 'inactive', goodStanding: false },
    consolidated: { status: 'inactive', goodStanding: false },
    'effectiveness prevented': { status: 'inactive', goodStanding: null },
};

/** Entity type abbreviations used by the Colorado SOS (only the ones we are sure about are decoded). */
const TYPE_NAMES = {
    DLLC: 'Domestic limited liability company',
    FLLC: 'Foreign limited liability company',
    DPC: 'Domestic profit corporation',
    FPC: 'Foreign profit corporation',
    DNC: 'Domestic nonprofit corporation',
    FNC: 'Foreign nonprofit corporation',
    DLP: 'Domestic limited partnership',
    FLP: 'Foreign limited partnership',
    DLLP: 'Domestic limited liability partnership',
    FLLP: 'Foreign limited liability partnership',
    DLLLP: 'Domestic limited liability limited partnership',
    GP: 'General partnership',
};

const MONTH = '(?:January|February|March|April|May|June|July|August|September|October|November|December)';
const STATUS_SUFFIX = new RegExp(
    `,\\s*([A-Za-z ()\\-]*?(?:Delinquent|Dissolved|Revoked|Withdrawn|Merged|Converted|Consolidated|Relinquished|Expired|Noncompliant|Resigned|Prevented)[A-Za-z ()\\-]*?)\\s+(${MONTH}\\s+\\d{1,2},\\s*\\d{4})\\s*$`,
);

/** Colorado appends ", Delinquent June 1, 2022" style text to the name of non-good-standing entities. */
export function splitName(rawName) {
    const name = clean(rawName) ?? '';
    const m = name.match(STATUS_SUFFIX);
    if (!m) return { name, statusNote: null, statusDate: null };
    return { name: name.slice(0, m.index).trim(), statusNote: m[1].trim(), statusDate: isoDate(m[2]) };
}

export function mapStatus(raw) {
    return STATUS_MAP[String(raw ?? '').trim().toLowerCase()] ?? { status: 'unknown', goodStanding: null };
}

function agentOf(row) {
    const person = joinParts([row.agentfirstname, row.agentmiddlename, row.agentlastname, row.agentsuffix], ' ');
    const registeredAgent = clean(row.agentorganizationname) ?? person;
    const registeredAgentAddress = joinParts([
        row.agentprincipaladdress1, row.agentprincipaladdress2, row.agentprincipalcity,
        joinParts([row.agentprincipalstate, row.agentprincipalzipcode], ' '),
    ]);
    return { registeredAgent, registeredAgentAddress };
}

export function toRecord(row, { lastReportFiled, freshness, now }) {
    const { name, statusNote, statusDate } = splitName(row.entityname);
    const mapped = mapStatus(row.entitystatus);
    const { registeredAgent, registeredAgentAddress } = agentOf(row);
    return makeRecord({
        state: 'CO',
        entityId: row.entityid,
        name,
        entityType: TYPE_NAMES[row.entitytype] ?? row.entitytype,
        statusRaw: row.entitystatus,
        statusDetail: statusNote,
        status: mapped.status,
        goodStanding: mapped.goodStanding,
        formationDate: row.entityformdate,
        statusDate,
        annualReportDue: null,
        annualReportDueNote: 'Colorado does not publish the periodic report due date in its open data.',
        lastReportFiled,
        registeredAgent,
        registeredAgentAddress,
        source: SOURCE,
        sourceUrl: sodaUrl(DOMAIN, MAIN, { entityid: row.entityid }),
        mode: 'opendata',
        dataFreshness: freshness,
        checkedAt: now.toISOString(),
        details: {
            entityTypeCode: row.entitytype ?? null,
            jurisdictionOfFormation: row.jurisdictonofformation ?? null,
            principalAddress: joinParts([row.principaladdress1, row.principaladdress2, row.principalcity, joinParts([row.principalstate, row.principalzipcode], ' ')]),
        },
    });
}

async function lastReports(ctx, ids) {
    if (!ids.length) return new Map();
    const rows = await soda(ctx, DOMAIN, HISTORY, {
        $select: 'entityid,max(effectivedate) as last',
        $group: 'entityid',
        $where: `entityid in(${inList(ids)}) and historydes in('File Report','Statement of Older Periodic Report')`,
    });
    return new Map(rows.map((r) => [r.entityid, r.last]));
}

const ACTIVE_RAW = ['Good Standing', 'Exists', 'Delinquent', 'Noncompliant'];

export const adapter = {
    state: 'CO',
    stateName: 'Colorado',
    mode: 'opendata',
    activeListOnly: false,
    source: SOURCE,
    sourceUrl: 'https://data.colorado.gov/d/4ykn-tg5h',
    officialSearchUrl: 'https://www.coloradosos.gov/biz/BusinessEntityCriteria.do',
    supports: { annualReportDue: false, lastReportFiled: true, registeredAgent: true },

    async lookup({ id, name, limit, activeOnly }, ctx) {
        let rows;
        if (id) {
            if (!/^[A-Za-z0-9-]{3,24}$/.test(id)) throw new SourceError(`"${id}" is not a valid Colorado entity id`);
            rows = await soda(ctx, DOMAIN, MAIN, { entityid: id, $limit: 1 });
        } else {
            const term = likeTerm(name);
            if (term.length < 2) throw new SourceError('Name must have at least 2 characters');
            let where = `upper(entityname) like '${term}%'`;
            if (activeOnly) where += ` and entitystatus in(${inList(ACTIVE_RAW)})`;
            rows = await soda(ctx, DOMAIN, MAIN, { $where: where, $order: 'entityname', $limit: candidateWindow(limit) });
            rows = preRank(name, rows, (r) => splitName(r.entityname).name, limit);
        }
        if (!rows.length) return [];
        const [freshness, reports] = await Promise.all([
            datasetUpdatedAt(ctx, DOMAIN, MAIN),
            lastReports(ctx, rows.map((r) => r.entityid)),
        ]);
        return rows.map((row) => toRecord(row, { lastReportFiled: reports.get(row.entityid) ?? null, freshness, now: ctx.now }));
    },
};

export default adapter;
