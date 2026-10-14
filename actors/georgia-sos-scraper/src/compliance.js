/**
 * Georgia annual registration rules (O.C.G.A. 14-2-1622, 14-11-1103; Secretary of State "How to file annual registration"):
 * - Every active corporation, LLC and foreign entity authorized in Georgia files an annual registration each year.
 *   It can be filed from January 1 and is due by April 1.
 * - A $25 late fee applies to registrations filed after April 1.
 * - Entities that do not file may be administratively dissolved or have their authority revoked
 *   (the Secretary of State does not publish a fixed date for that, so this Actor does not invent one).
 * - The first registration is due the calendar year after the entity was formed or registered.
 *
 * What the portal publishes: the "Last Annual Registration Year" on the detail page and, in the filing history,
 * every "Annual Registration (YYYY)" filing with its filing date. The portal does not publish a next-due date,
 * so the due date reported here (April 1 of the current year) is derived from the rule above and only when the
 * current year's registration is missing.
 */

const toDate = (mdy) => {
    const m = (mdy || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    return m ? new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]))) : null;
};

const iso = (d) => d.toISOString().slice(0, 10);

/**
 * @param {{status?: string, formationDate?: string|null, lastAnnualReportYear?: number|null}} entity
 *   status is the portal's text (e.g. "Active/Compliance"), formationDate is M/D/YYYY.
 */
export function annualReportStatus(entity, now = new Date()) {
    const year = now.getUTCFullYear();
    const status = entity.status || '';
    const isActive = /^active/i.test(status);
    const lastYear = entity.lastAnnualReportYear ?? null;
    const formed = toDate(entity.formationDate);
    const formedYear = formed ? formed.getUTCFullYear() : null;
    // The first registration is due the year after formation. Without a formation date we assume it is required.
    const requiredThisYear = isActive && (formedYear === null || formedYear < year);
    // Registrations can be filed up to three years ahead, so a later year also covers this one.
    const filedThisYear = lastYear !== null && lastYear >= year;
    const dueDate = new Date(Date.UTC(year, 3, 1)); // April 1
    const portalSaysOwes = /owes\s*ar/i.test(status);

    let text;
    if (!isActive) text = 'not_applicable_inactive';
    else if (!requiredThisYear) text = 'not_yet_required';
    else if (filedThisYear) text = 'filed';
    else if (now <= new Date(Date.UTC(year, 3, 1, 23, 59, 59))) text = 'due';
    else text = 'late_fee_applies';

    return {
        lastAnnualReportYear: lastYear,
        annualReportCurrent: isActive ? (requiredThisYear ? filedThisYear : true) : null,
        annualReportStatus: text,
        annualReportDueDate: requiredThisYear && !filedThisYear ? iso(dueDate) : null,
        lateFeeApplies: text === 'late_fee_applies',
        lateFeeUsd: text === 'late_fee_applies' ? 25 : null,
        portalOwesAnnualRegistration: isActive ? portalSaysOwes : null,
        nextAnnualReportWindow: isActive ? `${filedThisYear || !requiredThisYear ? year + 1 : year}-01-01` : null,
    };
}
