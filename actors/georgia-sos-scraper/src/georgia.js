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
