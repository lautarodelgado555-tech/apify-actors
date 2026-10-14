/**
 * New York Department of State, via data.ny.gov (Socrata):
 *   n9v6-gdp6  Active Corporations: Beginning 1800        (entities that are active; name, type, agent)
 *   3gg2-jgnp  All Filings - Entity Status History         (status after every filing; latest row = current)
 *   ekwr-p59j  All Filings - Name Status History           (entity names, used for entities no longer active)
 * Verified live from a GitHub runner on 2026-10-14.
 *
 * New York publishes Active / Inactive / Suspended / Discontinued but no good-standing flag and no annual
 * (biennial statement) due date, so goodStanding is null for active entities and annualReportDue is always null.
 */
import { makeRecord } from '../canonical.js';
import { SourceError } from '../http.js';
import { datasetUpdatedAt, likeTerm, soda, sodaUrl } from '../socrata.js';
import { candidateWindow, digitsOnly, mapLimit, preRank } from './_util.js';

const DOMAIN = 'data.ny.gov';
const ACTIVE = 'n9v6-gdp6';
const STATUS_HISTORY = '3gg2-jgnp';
const NAME_HISTORY = 'ekwr-p59j';
const SOURCE = 'New York Department of State via data.ny.gov (Active Corporations + Entity Status History)';

export const STATUS_MAP = {
    active: { status: 'active', goodStanding: null },
    inactive: { status: 'inactive', goodStanding: false },
    suspended: { status: 'suspended', goodStanding: false },
    discontinued: { status: 'inactive', goodStanding: false },
};

export const mapStatus = (raw) => STATUS_MAP[String(raw ?? '').trim().toLowerCase()] ?? { status: 'unknown', goodStanding: null };

const lines = (...p) => p.filter(Boolean).join(', ');

async function latestStatus(ctx, id) {
    const rows = await soda(ctx, DOMAIN, STATUS_HISTORY, { corpid_num: id, $order: 'date_filed desc,film_num desc', $limit: 1 });
    return rows[0] ?? null;
}

function agentOf(row) {
    const registeredAgent = row.registered_agent_name ?? null;
    const registeredAgentAddress = registeredAgent
        ? lines(row.registered_agent_address_1, row.registered_agent_address_2, row.registered_agent_city, `${row.registered_agent_state ?? ''} ${row.registered_agent_zip ?? ''}`.trim())
        : null;
    return { registeredAgent, registeredAgentAddress };
}

export function toRecord({ active, history, nameRow, id }, { freshness, now }) {
    // The status history is the authority; an entity listed as active with no history row is plain "Active".
    const statusRaw = history?.status ?? (active ? 'Active' : null);
    const mapped = mapStatus(statusRaw);
    const { registeredAgent, registeredAgentAddress } = active ? agentOf(active) : {};
    return makeRecord({
        state: 'NY',
        entityId: id,
        name: active?.current_entity_name ?? nameRow?.corp_name ?? null,
        entityType: active?.entity_type ?? null,
        statusRaw,
        statusDetail: history?.mod_cert_code ? `last filing code ${String(history.mod_cert_code).trim()}` : null,
        status: mapped.status,
        goodStanding: mapped.goodStanding,
        formationDate: active?.initial_dos_filing_date ?? null,
        statusDate: history?.date_filed ?? null,
        annualReportDue: null,
        annualReportDueNote: 'New York files a biennial statement; the open data does not publish its due date.',
        lastReportFiled: null,
        registeredAgent,
        registeredAgentAddress,
        source: SOURCE,
        sourceUrl: sodaUrl(DOMAIN, STATUS_HISTORY, { corpid_num: id, $order: 'date_filed desc,film_num desc', $limit: 1 }),
        mode: 'opendata',
        dataFreshness: freshness,
        checkedAt: now.toISOString(),
        details: {
            jurisdiction: active?.jurisdiction ?? null,
            county: active?.county ?? null,
            dosProcessName: active?.dos_process_name ?? null,
            listedAsActive: Boolean(active),
        },
    });
}

export const adapter = {
    state: 'NY',
    stateName: 'New York',
    mode: 'opendata',
    activeListOnly: false,
    source: SOURCE,
    sourceUrl: 'https://data.ny.gov/d/n9v6-gdp6',
    officialSearchUrl: 'https://apps.dos.ny.gov/publicInquiry/',
    supports: { annualReportDue: false, lastReportFiled: false, registeredAgent: true },

    async lookup({ id, name, limit, activeOnly }, ctx) {
        const freshness = await datasetUpdatedAt(ctx, DOMAIN, STATUS_HISTORY);

        if (id) {
            const digits = digitsOnly(id);
            if (!digits || digits.length > 10) throw new SourceError(`"${id}" is not a New York DOS ID`);
            const [activeRows, history] = await Promise.all([
                soda(ctx, DOMAIN, ACTIVE, { dos_id: digits, $limit: 1 }),
                latestStatus(ctx, digits),
            ]);
            const active = activeRows[0] ?? null;
            if (!active && !history) return [];
            let nameRow = null;
            if (!active) {
                nameRow = (await soda(ctx, DOMAIN, NAME_HISTORY, { corpid_num: digits, $order: 'date_filed desc', $limit: 1 }))[0] ?? null;
            }
            return [toRecord({ active, history, nameRow, id: digits }, { freshness, now: ctx.now })];
        }

        const term = likeTerm(name);
        if (term.length < 2) throw new SourceError('Name must have at least 2 characters');
        // Active entities by name, then their current status. With activeOnly=false, entities that are no longer
        // active are found through the name history.
        const [activeRows, nameRows] = await Promise.all([
            soda(ctx, DOMAIN, ACTIVE, { $where: `upper(current_entity_name) like '${term}%'`, $order: 'current_entity_name', $limit: candidateWindow(limit) }),
            activeOnly
                ? []
                : soda(ctx, DOMAIN, NAME_HISTORY, { $where: `upper(corp_name) like '${term}%'`, $order: 'corp_name', $limit: candidateWindow(limit) }),
        ]);
        const byId = new Map();
        for (const a of activeRows) byId.set(String(a.dos_id), { active: a, name: a.current_entity_name });
        for (const n of nameRows) if (!byId.has(String(n.corpid_num))) byId.set(String(n.corpid_num), { active: null, nameRow: n, name: n.corp_name });
        const picked = preRank(name, [...byId.entries()], ([, v]) => v.name, limit);
        const out = await mapLimit(picked, 4, async ([cid, v]) => {
            const history = await latestStatus(ctx, cid);
            return toRecord({ active: v.active, history, nameRow: v.nameRow ?? null, id: cid }, { freshness, now: ctx.now });
        });
        return activeOnly ? out.filter((r) => r.status === 'active') : out;
    },
};

export default adapter;
