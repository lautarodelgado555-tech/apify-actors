/**
 * District of Columbia DLCP "Corporate Registration" (Open Data DC, ArcGIS FeatureServer, CC BY 4.0, refreshed daily).
 * Layer: https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Business_Licensing_and_Grants_WebMercator/FeatureServer/0
 * Verified live from a GitHub runner on 2026-10-14.
 *
 * The register states good standing in the status itself ("Active - In Good Standing") and publishes the next
 * report due date (NEXT_REPORTYEAR_DUE, e.g. 04/01/2027; DC reports are biennial) and the last report filed date.
 */
import { clean, isoDate, joinParts, makeRecord } from '../canonical.js';
import { SourceError } from '../http.js';
import { likeTerm, sq } from '../socrata.js';
import { candidateWindow } from './_util.js';

const LAYER = 'https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Business_Licensing_and_Grants_WebMercator/FeatureServer/0';
const SOURCE = 'DC Department of Licensing and Consumer Protection via Open Data DC (Corporate Registration)';

export function mapStatus(raw) {
    const s = String(raw ?? '').trim().toLowerCase();
    if (s.startsWith('active - not in good standing')) return { status: 'delinquent', goodStanding: false };
    if (s.startsWith('active - in good standing')) return { status: 'active', goodStanding: true };
    if (s.startsWith('active')) return { status: 'active', goodStanding: null };
    if (['dissolved', 'revoked', 'terminated', 'expired'].includes(s)) return { status: 'dissolved', goodStanding: false };
    if (['withdrawn', 'merged', 'converted', 'consolidated', 'domesticated', 'inactive - cancelled', 'cancelled'].includes(s)) {
        return { status: 'inactive', goodStanding: false };
    }
    return { status: 'unknown', goodStanding: null };
}

function queryUrl(params) {
    const qs = Object.entries({ outFields: '*', returnGeometry: 'false', f: 'json', ...params })
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&');
    return `${LAYER}/query?${qs}`;
}

export function toRecord(a, { now }) {
    const mapped = mapStatus(a.ENTITY_STATUS);
    const stillRegistered = mapped.status === 'active' || mapped.status === 'delinquent';
    const lastFiled = isoDate(a.DATE_LAST_REPORT_FILED) ?? isoDate(a.LATESTFILED_REPORTDATE);
    return makeRecord({
        state: 'DC',
        entityId: a.FILE_NUMBER,
        name: joinParts([a.BUSINESS_NAME, a.SUFFIX], ' '),
        entityType: a.MODELTYPE,
        statusRaw: a.ENTITY_STATUS,
        status: mapped.status,
        goodStanding: mapped.goodStanding,
        formationDate: a.EFFECTIVE_DATE,
        annualReportDue: stillRegistered ? a.NEXT_REPORTYEAR_DUE : null,
        annualReportDueNote: stillRegistered ? 'Stated by the DC register (NEXT_REPORTYEAR_DUE). DC entities file a biennial report.' : null,
        lastReportFiled: lastFiled,
        registeredAgent: a.RA_NAME,
        registeredAgentAddress: joinParts([a.RA_ADDRESS1, a.RA_ADDRESS2, a.RA_CITY, joinParts([a.RA_STATE, a.RA_ZIPCODE], ' ')]),
        source: SOURCE,
        sourceUrl: queryUrl({ where: `FILE_NUMBER='${sq(a.FILE_NUMBER)}'` }),
        mode: 'opendata',
        dataFreshness: a.DCS_LAST_MOD_DTTM ? new Date(a.DCS_LAST_MOD_DTTM).toISOString() : null,
        checkedAt: now.toISOString(),
        details: {
            locale: clean(a.LOCALE),
            businessAddress: joinParts([a.BUSNIESS_ADDRESS_LINE1, a.BUSNIESS_ADDRESS_LINE2, a.BUSINESS_CITY, joinParts([a.BUSINESS_STATE, a.ZIPCODE], ' ')]),
            nextReportYear: clean(a.NEXT_REPORTYEAR),
        },
    });
}

export const adapter = {
    state: 'DC',
    stateName: 'District of Columbia',
    mode: 'opendata',
    activeListOnly: false,
    source: SOURCE,
    sourceUrl: 'https://opendata.dc.gov/datasets/DCGIS::corporate-registration',
    officialSearchUrl: 'https://dlcp.dc.gov/page/corporations',
    supports: { annualReportDue: true, lastReportFiled: true, registeredAgent: true },

    async lookup({ id, name, limit, activeOnly }, ctx) {
        let where;
        let max;
        if (id) {
            if (!/^[A-Za-z0-9-]{3,30}$/.test(id)) throw new SourceError(`"${id}" is not a valid DC file number`);
            where = `FILE_NUMBER='${sq(id)}'`;
            max = 1;
        } else {
            const term = likeTerm(name);
            if (term.length < 2) throw new SourceError('Name must have at least 2 characters');
            where = `UPPER(BUSINESS_NAME) LIKE '${term}%'`;
            if (activeOnly) where += " AND ENTITY_STATUS LIKE 'Active%'";
            max = candidateWindow(limit);
        }
        const url = queryUrl({ where, orderByFields: 'BUSINESS_NAME', resultRecordCount: max });
        const body = await ctx.fetchJson(url);
        if (body?.error) throw new SourceError(`DC service error: ${body.error.message ?? JSON.stringify(body.error)}`, { url });
        const attrs = (body?.features ?? []).map((f) => f.attributes);
        return attrs.map((a) => toRecord(a, { now: ctx.now }));
    },
};

export default adapter;
