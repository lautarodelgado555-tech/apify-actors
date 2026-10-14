/**
 * Oregon Secretary of State, via data.oregon.gov (Socrata):
 *   tckn-sxa6  Active Businesses - ALL           one row per associated party (agent, mailing, principal place...)
 *   6g49-bcrm  Active Businesses - County Data   adds anniversary_date ("Date Renewal is Due"); only entities with
 *                                                an Oregon principal place of business
 * Verified live from a GitHub runner on 2026-10-14.
 *
 * Both datasets list ACTIVE businesses only. An entity that is missing from them is not active (or never existed):
 * `activeListOnly: true` lets the orchestrator turn the disappearance of a previously seen entity into an
 * "inactive" change. Oregon does not publish a good-standing flag, so goodStanding is null.
 */
import { clean, joinParts, makeRecord } from '../canonical.js';
import { SourceError } from '../http.js';
import { datasetUpdatedAt, inList, likeTerm, soda, sodaUrl } from '../socrata.js';
import { candidateWindow, digitsOnly, preRank } from './_util.js';

const DOMAIN = 'data.oregon.gov';
const ALL = 'tckn-sxa6';
const COUNTY = '6g49-bcrm';
const SOURCE = 'Oregon Secretary of State via data.oregon.gov (Active Businesses)';
const GROUP = 'registry_number,business_name,entity_type,registry_date,jurisdiction';

function agentOf(agentRow) {
    if (!agentRow) return {};
    const person = joinParts([agentRow.first_name, agentRow.middle_name, agentRow.last_name, agentRow.suffix], ' ');
    return {
        registeredAgent: clean(agentRow.entity_of_record_name) ?? person,
        registeredAgentAddress: joinParts([agentRow.address, agentRow.address_continued, agentRow.city, joinParts([agentRow.state, agentRow.zip], ' ')]),
    };
}

export function toRecord(row, { county, agentRow, freshness, countyFreshness, now }) {
    const { registeredAgent, registeredAgentAddress } = agentOf(agentRow);
    const due = county?.anniversary_date ?? null;
    return makeRecord({
        state: 'OR',
        entityId: row.registry_number,
        name: row.business_name,
        entityType: row.entity_type,
        statusRaw: 'Active',
        statusDetail: 'Listed in the Active Businesses dataset',
        status: 'active',
        goodStanding: null,
        formationDate: row.registry_date,
        annualReportDue: due,
        annualReportDueNote: due
            ? `Anniversary date from the Active Businesses - County Data dataset (updated ${countyFreshness ?? 'on an unknown date'}); renewals filed since then are not reflected.`
            : 'Oregon publishes the anniversary date only for entities with an Oregon principal place of business.',
        lastReportFiled: null,
        registeredAgent,
        registeredAgentAddress,
        source: SOURCE,
        sourceUrl: sodaUrl(DOMAIN, ALL, { registry_number: row.registry_number }),
        mode: 'opendata',
        dataFreshness: freshness,
        checkedAt: now.toISOString(),
        details: { jurisdiction: clean(row.jurisdiction), entityTypeCode: county?.e_type ?? null },
    });
}

export const adapter = {
    state: 'OR',
    stateName: 'Oregon',
    mode: 'opendata',
    activeListOnly: true,
    source: SOURCE,
    sourceUrl: 'https://data.oregon.gov/d/tckn-sxa6',
    officialSearchUrl: 'https://sos.oregon.gov/business/pages/find.aspx',
    supports: { annualReportDue: true, lastReportFiled: false, registeredAgent: true },

    async lookup({ id, name, limit }, ctx) {
        let rows;
        if (id) {
            const digits = digitsOnly(id);
            if (!digits || digits.length > 12) throw new SourceError(`"${id}" is not an Oregon registry number`);
            rows = await soda(ctx, DOMAIN, ALL, { $select: GROUP, $group: GROUP, $where: `registry_number='${digits}'`, $limit: 1 });
        } else {
            const term = likeTerm(name);
            if (term.length < 2) throw new SourceError('Name must have at least 2 characters');
            rows = await soda(ctx, DOMAIN, ALL, {
                $select: GROUP,
                $group: GROUP,
                $where: `upper(business_name) like '${term}%'`,
                $order: 'business_name',
                $limit: candidateWindow(limit),
            });
            rows = preRank(name, rows, (r) => r.business_name, limit);
        }
        if (!rows.length) return [];
        const ids = rows.map((r) => r.registry_number);
        const [freshness, countyFreshness, counties, agents] = await Promise.all([
            datasetUpdatedAt(ctx, DOMAIN, ALL),
            datasetUpdatedAt(ctx, DOMAIN, COUNTY),
            soda(ctx, DOMAIN, COUNTY, { $where: `registry_number in(${inList(ids)})`, $limit: 200 }),
            soda(ctx, DOMAIN, ALL, { $where: `registry_number in(${inList(ids)}) and associated_name_type='REGISTERED AGENT'`, $limit: 400 }),
        ]);
        const countyBy = new Map(counties.map((c) => [String(c.registry_number), c]));
        const agentBy = new Map();
        for (const a of agents) if (!agentBy.has(String(a.registry_number))) agentBy.set(String(a.registry_number), a);
        return rows.map((row) =>
            toRecord(row, {
                county: countyBy.get(String(row.registry_number)),
                agentRow: agentBy.get(String(row.registry_number)),
                freshness,
                countyFreshness,
                now: ctx.now,
            }));
    },
};

export default adapter;
