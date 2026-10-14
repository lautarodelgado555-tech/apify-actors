import * as cheerio from 'cheerio';

export const BASE = 'https://ecorp.sos.ga.gov';
export const HOME_URL = `${BASE}/BusinessSearch`;

/** Georgia eCorp search types, keyed by the Actor's searchType input. */
export const SEARCH_TYPES = {
    businessName: 'BusinessName',
    controlNumber: 'ControlNo',
    registeredAgent: 'AgentName',
    officer: 'PrincipalName',
};

export const MATCH_MODES = {
    startsWith: 'StartsWith',
    contains: 'Contains',
    exact: 'ExactMatch',
};

export const clean = (s) => (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

/** Form fields eCorp expects for a search POST (the portal's own jQuery code sends exactly these). */
export function buildSearchBody(searchType, term, nameMatch = 'startsWith') {
    const type = SEARCH_TYPES[searchType];
    if (!type) throw new Error(`Unknown searchType: ${searchType}`);
    return {
        'search.SearchType': type,
        'search.SearchValue': term,
        'search.SearchCriteria': MATCH_MODES[nameMatch] ?? 'StartsWith',
    };
}

/** Paging goes through the same URL; the server remembers the last search in the session. */
export const buildPageBody = (pageIndex) => ({ sortby: '', stype: 'a', pidx: String(pageIndex) });

export const isChallengePage = (html) => /<title>\s*Just a moment/i.test(html || '');

/**
 * Parse an eCorp results list (search POST or a later page).
 * Columns: business name (with detail link), control number, type, principal office address,
 * registered/designated agent name, status.
 */
export function parseResults(html) {
    const $ = cheerio.load(html || '');
    const rows = [];
    $('#grid_businessList tbody tr').each((_, tr) => {
        const tds = $(tr).children('td');
        if (tds.length < 6) return;
        const onclick = $(tds[0]).find('a').attr('onclick') || '';
        const m = onclick.match(/navigateToBusinessInfo\(\s*(\d+)\s*,\s*'([^']*)'\s*\)/);
        if (!m) return;
        rows.push({
            businessId: m[1],
            businessType: m[2],
            name: clean($(tds[0]).text()),
            controlNumber: clean($(tds[1]).text()),
            entityType: clean($(tds[2]).text()),
            principalAddress: clean($(tds[3]).text()),
            registeredAgentName: clean($(tds[4]).text()) || null,
            status: clean($(tds[5]).text()),
        });
    });
    const info = clean($('li.pageinfo').first().text());
    const pm = info.match(/Page\s+(\d+)\s+of\s+(\d+)(?:,\s*records\s+(\d+)\s+to\s+(\d+)\s+of\s+(\d+))?/i);
    const error = clean($('#_errorElement_').attr('value'));
    return {
        rows,
        page: pm ? Number(pm[1]) : rows.length ? 1 : 0,
        totalPages: pm ? Number(pm[2]) : rows.length ? 1 : 0,
        totalRecords: pm && pm[5] ? Number(pm[5]) : rows.length,
        error: error || null,
        noData: /no data found/i.test(error),
    };
}

/** Normalised good-standing value, using the same vocabulary as the Sunbiz Actor's statuses. */
export function normalizeStatus(status) {
    const s = clean(status).toLowerCase();
    if (!s) return { active: null, goodStanding: null, statusNormalized: 'unknown' };
    if (/^active/.test(s)) {
        if (/owes/.test(s)) return { active: true, goodStanding: false, statusNormalized: 'active_owes_annual_registration' };
        if (/good standing|compliance/.test(s)) return { active: true, goodStanding: true, statusNormalized: 'active_good_standing' };
        return { active: true, goodStanding: null, statusNormalized: 'active' };
    }
    if (/admin.*dissol/.test(s)) return { active: false, goodStanding: false, statusNormalized: 'administratively_dissolved' };
    if (/dissolved/.test(s)) return { active: false, goodStanding: false, statusNormalized: 'dissolved' };
    if (/revoked/.test(s)) return { active: false, goodStanding: false, statusNormalized: 'revoked' };
    if (/withdrawn/.test(s)) return { active: false, goodStanding: false, statusNormalized: 'withdrawn' };
    if (/terminated|cancel/.test(s)) return { active: false, goodStanding: false, statusNormalized: 'terminated' };
    if (/merged|converted/.test(s)) return { active: false, goodStanding: false, statusNormalized: 'merged_or_converted' };
    return { active: null, goodStanding: null, statusNormalized: 'other' };
}

/** "5/10/1967" -> "1967-05-10" (null when it is not a date). */
export function isoDate(mdy) {
    const m = (mdy || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}

export const isDetailPage = (html) => /Business Information/.test(html || '') && /Control Number:/.test(html || '');

/**
 * Parse an eCorp business detail page.
 * Layout: label/value cells (label cell is right-aligned and ends with ":"), a "Registered Agent Information"
 * block and, for corporations and partnerships, an "Officer Information" grid.
 */
export function parseDetail(html) {
    const $ = cheerio.load(html || '');
    const fields = {};
    let section = '';
    $('td').each((_, td) => {
        const $td = $(td);
        if ($td.hasClass('inner_databg')) {
            section = clean($td.text());
            return;
        }
        if ($td.attr('align') !== 'right') return;
        const label = clean($td.text()).replace(/:$/, '');
        if (!label) return;
        const value = clean($td.next('td').text());
        const key = section.startsWith('Registered Agent') ? `agent:${label}` : label;
        if (!(key in fields)) fields[key] = value;
    });

    const officers = [];
    $('#grid_principalList tbody tr').each((_, tr) => {
        const tds = $(tr).children('td');
        if (tds.length < 3) return;
        const address = clean($(tds[2]).text());
        officers.push({
            name: clean($(tds[0]).text()),
            title: clean($(tds[1]).text()) || null,
            address: /^[,\s]*(USA)?$/i.test(address) ? null : address,
        });
    });

    const orNull = (v) => (v && !/^none$/i.test(v) ? v : null);
    const lastYearText = fields['Last Annual Registration Year'] || '';
    const formation = fields['Date of Formation / Registration Date'] || null;
    return {
        name: fields['Business Name'] || null,
        controlNumber: fields['Control Number'] || null,
        entityType: fields['Business Type'] || null,
        status: fields['Business Status'] || null,
        purpose: orNull(fields['Business Purpose']),
        naicsCode: fields['NAICS Code'] || null,
        naicsSubCode: fields['NAICS Sub Code'] || null,
        principalAddress: fields['Principal Office Address'] || null,
        formationDate: formation,
        formationDateIso: isoDate(formation),
        jurisdiction: fields['State of Formation'] || fields.Jurisdiction || null,
        lastAnnualReportYear: /^\d{4}$/.test(lastYearText) ? Number(lastYearText) : null,
        dissolvedDate: fields['Dissolved Date'] || null,
        registeredAgentName: fields['agent:Registered Agent Name'] || null,
        registeredAgentAddress: fields['agent:Physical Address'] || null,
        registeredAgentCounty: fields['agent:County'] || null,
        officers,
    };
}

/** Parse a filing history page or page fragment (all filings plus the paging info). */
export function parseFilings(html) {
    const $ = cheerio.load(html || '');
    const filings = [];
    $('#xhtml_grid tbody tr').each((_, tr) => {
        const tds = $(tr).children('td');
        if (tds.length < 4) return;
        filings.push({
            filingNumber: clean($(tds[0]).text()),
            filedDate: isoDate(clean($(tds[1]).text())),
            effectiveDate: isoDate(clean($(tds[2]).text())),
            type: clean($(tds[3]).text()),
        });
    });
    const info = clean($('li.pageinfo').first().text());
    const pm = info.match(/Page\s+(\d+)\s+of\s+(\d+)/i);
    return { filings, page: pm ? Number(pm[1]) : 1, totalPages: pm ? Number(pm[2]) : 1 };
}

/** Annual registration filings (year from the filing type; amended ones flagged), sorted by filing date. */
export function annualRegistrations(filings) {
    return filings
        .filter((f) => /annual registration/i.test(f.type))
        .map((f) => {
            const y = f.type.match(/\((\d{4})\)/);
            return { year: y ? Number(y[1]) : null, filedDate: f.filedDate, amended: /amended/i.test(f.type) };
        })
        .sort((a, b) => (a.filedDate || '').localeCompare(b.filedDate || ''));
}
