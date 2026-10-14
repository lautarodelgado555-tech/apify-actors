/**
 * Name matching for watchlist entries given by name. Registries do not guarantee unique names across
 * entity types, so name searches only ever return scored candidates; monitoring requires an entity id.
 */

const SUFFIXES = new Set([
    'LLC', 'L L C', 'INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'LIMITED',
    'LP', 'LLP', 'LLLP', 'PC', 'PLLC', 'PA', 'NA', 'THE',
]);

/** Uppercase, "&" to AND, punctuation removed, whitespace collapsed. */
export function normalizeName(name) {
    return String(name ?? '')
        .toUpperCase()
        .replace(/&/g, ' AND ')
        .replace(/[^A-Z0-9 ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Normalized name without legal-form words (LLC, INC, CORP ...) and the leading "THE". */
export function coreName(name) {
    return normalizeName(name)
        .split(' ')
        .filter((t) => t && !SUFFIXES.has(t))
        .join(' ');
}

/** Score 0..1 and a label for how well `candidate` matches `query`. */
export function scoreMatch(query, candidate) {
    const q = normalizeName(query);
    const c = normalizeName(candidate);
    if (!q || !c) return { score: 0, type: 'none' };
    if (q === c) return { score: 1, type: 'exact' };
    const qc = coreName(query);
    const cc = coreName(candidate);
    if (qc && qc === cc) return { score: 0.95, type: 'exact-ignoring-legal-suffix' };
    if (qc && cc.startsWith(`${qc} `)) return { score: Math.min(0.9, 0.7 + 0.2 * (qc.length / cc.length)), type: 'starts-with' };
    if (qc && cc.startsWith(qc)) return { score: Math.min(0.85, 0.6 + 0.25 * (qc.length / cc.length)), type: 'starts-with' };
    const qt = new Set(qc.split(' ').filter(Boolean));
    const ct = new Set(cc.split(' ').filter(Boolean));
    if (!qt.size || !ct.size) return { score: 0, type: 'none' };
    const shared = [...qt].filter((t) => ct.has(t)).length;
    if (shared === qt.size) return { score: 0.5 + 0.2 * (shared / ct.size), type: 'contains-all-words' };
    const jaccard = shared / (qt.size + ct.size - shared);
    return { score: Math.round(jaccard * 40) / 100, type: jaccard > 0 ? 'partial' : 'none' };
}

const ACTIVE_FIRST = { active: 0, delinquent: 1, suspended: 2, unknown: 3, inactive: 4, dissolved: 5 };

/**
 * Attach matchScore/matchType to candidate records and sort best first (score, then live entities
 * before dissolved ones, then name). Returns at most `max` records.
 */
export function rankCandidates(query, records, max) {
    return records
        .map((r) => {
            const { score, type } = scoreMatch(query, r.name);
            return { ...r, matchScore: Math.round(score * 100) / 100, matchType: type };
        })
        .sort((a, b) =>
            b.matchScore - a.matchScore ||
            (ACTIVE_FIRST[a.status] ?? 9) - (ACTIVE_FIRST[b.status] ?? 9) ||
            String(a.name).localeCompare(String(b.name)))
        .slice(0, max);
}

/**
 * Decide whether a ranked candidate list contains exactly one unambiguous exact match that can be
 * monitored without the user choosing an id (only used when autoResolveExactName is on).
 */
export function singleExactMatch(ranked) {
    const strong = ranked.filter((r) => r.matchScore >= 0.95);
    return strong.length === 1 && strong[0].matchType === 'exact' ? strong[0] : null;
}
