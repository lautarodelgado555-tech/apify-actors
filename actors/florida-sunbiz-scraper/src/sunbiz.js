import * as cheerio from 'cheerio';

export const BASE = 'https://search.sunbiz.org';

/** Sunbiz inquiry types, keyed by the Actor's searchType input. */
export const INQUIRY_TYPES = {
    entityName: 'EntityName',
    officerOrRegisteredAgent: 'OfficerRegisteredAgentName',
    registeredAgent: 'RegisteredAgentName',
    documentNumber: 'DocumentNumber',
    feiEin: 'FeiNumber',
};

const NAME_SEARCH_TYPES = new Set(['entityName', 'officerOrRegisteredAgent', 'registeredAgent']);

export const isNameSearch = (searchType) => NAME_SEARCH_TYPES.has(searchType);

/** Sunbiz orders names by their letters and digits only, upper-cased, ignoring a leading "THE". */
export const nameOrder = (term) =>
    term.toUpperCase().replace(/^\s*THE\s+/, '').replace(/[^A-Z0-9]/g, '');

const SUFFIXES = /\b(L\.?L\.?C\.?|INC\.?|CORP\.?|CORPORATION|CO\.?|LTD\.?|L\.?P\.?|L\.?L\.?P\.?|P\.?A\.?|P\.?L\.?L\.?C\.?|P\.?L\.?|COMPANY|INCORPORATED|LIMITED)\b\.?/g;

/** Comparable form of an entity name: upper-case, no leading THE, no corporate suffixes, no punctuation. */
export const comparableName = (name) =>
    (name || '')
        .toUpperCase()
        .replace(/^\s*THE\s+/, '')
        .replace(SUFFIXES, ' ')
        .replace(/[^A-Z0-9]/g, '');

export function buildSearchUrl(searchType, term) {
    const inquiryType = INQUIRY_TYPES[searchType];
    if (!inquiryType) throw new Error(`Unknown searchType: ${searchType}`);
    const params = new URLSearchParams({
        InquiryType: inquiryType,
        inquiryDirectionType: 'ForwardList',
        searchNameOrder: isNameSearch(searchType) ? nameOrder(term) : term.replace(/[^A-Za-z0-9]/g, '').toUpperCase(),
        SearchTerm: term,
    });
    return `${BASE}/Inquiry/CorporationSearch/SearchResults?${params}`;
}

export const absolute = (href) => (href ? new URL(href, BASE).toString() : null);

const clean = (s) => (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

export const isChallengePage = (html) => /<title>\s*Just a moment/i.test(html || '');

export const isDetailPage = (html) => /class="searchResultDetail"/.test(html || '');

/**
 * Parse a Sunbiz results list.
 * Entity-name lists have columns: name, document number, status.
 * Officer/agent lists have: officer name, entity name, document number.
 */
export function parseSearchResults(html, searchType) {
    const $ = cheerio.load(html);
    const rows = [];
    $('#search-results table tbody tr, #search-results table tr').each((_, tr) => {
        const tds = $(tr).find('td');
        if (tds.length < 3) return;
        const link = $(tr).find('a[href*="SearchResultDetail"]').first();
        if (!link.length) return;
        const cells = tds.map((__, td) => clean($(td).text())).get();
        const detailUrl = absolute(link.attr('href'));
        if (rows.some((r) => r.detailUrl === detailUrl)) return;
        if (searchType === 'entityName') {
            rows.push({ entityName: cells[0], documentNumber: cells[1], status: cells[2], detailUrl });
        } else {
            rows.push({ matchedName: cells[0], entityName: cells[1], documentNumber: cells[2], status: null, detailUrl });
        }
    });
    const next = $('a[title="Next List"]').first().attr('href');
    return { rows, nextUrl: absolute(next) };
}

/** Split a block of HTML (with <br> line breaks) into trimmed text lines. */
const htmlLines = (html) => {
    const text = cheerio.load((html || '').replace(/<br\s*\/?>/gi, '\n')).root().text();
    return text.split(/\n+/).map((l) => clean(l)).filter(Boolean);
};

/**
 * Parse an entity detail page.
 * The page is a sequence of `.detailSection` blocks whose first <span> is the heading.
 */
export function parseDetail(html, detailUrl) {
    const $ = cheerio.load(html);
    const nameParagraphs = $('.detailSection.corporationName p').map((_, p) => clean($(p).text())).get();
    const out = {
        entityType: nameParagraphs[0] || null,
        entityName: nameParagraphs[1] || nameParagraphs[0] || null,
        filing: {},
        principalAddress: null,
        mailingAddress: null,
        registeredAgentName: null,
        registeredAgentAddress: null,
        registeredAgentChanges: [],
        officers: [],
        officerSectionTitle: null,
        annualReports: [],
        documents: [],
    };

    $('.detailSection').each((_, section) => {
        const $s = $(section);
        const heading = clean($s.children('span').first().text());
        if (/Filing Information/i.test(heading)) {
            $s.find('label').each((__, label) => {
                const key = clean($(label).text()).replace(/:$/, '');
                const value = clean($(label).next('span').text());
                if (key) out.filing[key] = value || null;
            });
        } else if (/^Principal Address/i.test(heading)) {
            out.principalAddress = addressFromSection($, $s);
        } else if (/^Mailing Address/i.test(heading)) {
            out.mailingAddress = addressFromSection($, $s);
        } else if (/Registered Agent Name/i.test(heading)) {
            const spans = $s.children('span');
            out.registeredAgentName = clean(spans.eq(1).text()) || null;
            const addr = addressFromSection($, $s, 2);
            out.registeredAgentAddress = addr.address;
            out.registeredAgentChanges = addr.notes;
        } else if (/Detail$/i.test(heading) && /Officer|Director|Authorized Person|Manager|Member|Partner|Trustee/i.test(heading)) {
            out.officerSectionTitle = heading;
            out.officers = officersFromSection($, $s);
        } else if (/^Annual Reports/i.test(heading)) {
            $s.find('table tr').each((__, tr) => {
                const tds = $(tr).find('td').map((___, td) => clean($(td).text())).get();
                if (tds.length >= 2 && /^\d{4}$/.test(tds[0])) {
                    out.annualReports.push({ reportYear: Number(tds[0]), filedDate: tds[1] });
                }
            });
        } else if (!heading && $s.find('a[href*="GetDocument"], a[href*="ConvertTiffToPDF"]').length) {
            $s.find('table tr').each((__, tr) => {
                const a = $(tr).find('a').first();
                if (!a.length) return;
                const text = clean(a.text());
                const m = text.match(/^(\d{2}\/\d{2}\/\d{4})\s*-+\s*(.+)$/);
                out.documents.push({
                    date: m ? m[1] : null,
                    documentType: m ? m[2] : text,
                    url: absolute(a.attr('href')),
                });
            });
        }
    });

    const f = out.filing;
    const pick = (...keys) => {
        for (const k of keys) if (f[k]) return f[k];
        return null;
    };

    const eventsHref = $('a[href*="EventHistory"]').first().attr('href');

    return {
        entityName: out.entityName,
        entityType: out.entityType,
        documentNumber: pick('Document Number'),
        feiEin: pick('FEI/EIN Number'),
        dateFiled: pick('Date Filed'),
        effectiveDate: pick('Effective Date'),
        state: pick('State'),
        status: pick('Status'),
        lastEvent: pick('Last Event'),
        eventDateFiled: pick('Event Date Filed'),
        eventEffectiveDate: pick('Event Effective Date'),
        principalAddress: out.principalAddress?.address || null,
        principalAddressNotes: out.principalAddress?.notes || [],
        mailingAddress: out.mailingAddress?.address || null,
        mailingAddressNotes: out.mailingAddress?.notes || [],
        registeredAgentName: out.registeredAgentName,
        registeredAgentAddress: out.registeredAgentAddress,
        registeredAgentNotes: out.registeredAgentChanges,
        officerSectionTitle: out.officerSectionTitle,
        officers: out.officers,
        annualReports: out.annualReports,
        documents: out.documents,
        eventHistoryUrl: absolute(eventsHref),
        sunbizUrl: detailUrl,
    };
}

function addressFromSection($, $s, startIndex = 1) {
    const spans = $s.children('span');
    const all = htmlLines(spans.eq(startIndex).html());
    const isNote = (l) => /Changed:|Updated:/i.test(l);
    const notes = all.filter(isNote);
    const addressLines = all.filter((l) => !isNote(l));
    spans.slice(startIndex + 1).each((_, s) => {
        const t = clean($(s).text());
        if (t) notes.push(t);
    });
    return { address: addressLines.join(', ') || null, notes };
}

/**
 * Officer blocks look like:
 *   <span>Title MGR</span><br><br>BALLARD, GLEN A <span><div>7705 MOWRY ST.<br>JACKSONVILLE, FL 32256</div></span><br>
 * i.e. the name is a bare text node between the title span and the address span.
 */
function officersFromSection($, $s) {
    const officers = [];
    let current = null;
    $s.contents().each((_, node) => {
        if (node.type === 'tag' && node.name === 'span') {
            const $n = $(node);
            const text = clean($n.text());
            if (/^Title\b/i.test(text)) {
                if (current) officers.push(current);
                current = { title: text.replace(/^Title\s*/i, '') || null, name: null, address: null };
            } else if (current && $n.find('div').length) {
                current.address = htmlLines($n.html()).join(', ') || null;
            } else if (current && text && !/Name & Address/i.test(text) && !current.name) {
                current.name = text;
            }
        } else if (node.type === 'text' && current) {
            const text = clean(node.data);
            if (text) current.name = current.name ? `${current.name} ${text}` : text;
        }
    });
    if (current) officers.push(current);
    return officers.filter((o) => o.name);
}
