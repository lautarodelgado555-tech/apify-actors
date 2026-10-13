/**
 * Florida annual report rules (Fla. Stat. 605.0212 / 607.1622):
 * - Every active entity must file an annual report between January 1 and May 1 each year,
 *   starting the calendar year AFTER the year it was formed or registered.
 * - Filing after May 1 adds a $400 late fee (not for non-profits).
 * - Entities that still have not filed by the third Friday of September are
 *   administratively dissolved or revoked.
 */

const toDate = (mmddyyyy) => {
    const m = (mmddyyyy || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    return m ? new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]))) : null;
};

const iso = (d) => d.toISOString().slice(0, 10);

function thirdFridayOfSeptember(year) {
    const first = new Date(Date.UTC(year, 8, 1));
    const offset = (5 - first.getUTCDay() + 7) % 7; // days until first Friday
    return new Date(Date.UTC(year, 8, 1 + offset + 14));
}

export function annualReportStatus(detail, now = new Date()) {
    const year = now.getUTCFullYear();
    const filedYears = (detail.annualReports || []).map((r) => r.reportYear).filter(Boolean);
    const lastAnnualReportYear = filedYears.length ? Math.max(...filedYears) : null;
    const formed = toDate(detail.dateFiled);
    const formedYear = formed ? formed.getUTCFullYear() : null;
    const isActive = /^ACTIVE/i.test(detail.status || '');

    // First annual report is due the year after formation.
    const reportRequiredThisYear = isActive && formedYear !== null && formedYear < year;
    const filedThisYear = filedYears.includes(year);
    const dueDate = new Date(Date.UTC(year, 4, 1)); // May 1
    const dissolutionDate = thirdFridayOfSeptember(year);

    let annualReportStatusText;
    if (!isActive) annualReportStatusText = 'not_applicable_inactive';
    else if (!reportRequiredThisYear) annualReportStatusText = 'not_yet_required';
    else if (filedThisYear) annualReportStatusText = 'filed';
    else if (now < dueDate) annualReportStatusText = 'due';
    else if (now < dissolutionDate) annualReportStatusText = 'late_fee_applies';
    else annualReportStatusText = 'past_dissolution_deadline';

    return {
        lastAnnualReportYear,
        annualReportCurrent: isActive ? (reportRequiredThisYear ? filedThisYear : true) : null,
        annualReportStatus: annualReportStatusText,
        annualReportDueDate: reportRequiredThisYear && !filedThisYear ? iso(dueDate) : null,
        lateFeeApplies: annualReportStatusText === 'late_fee_applies' || annualReportStatusText === 'past_dissolution_deadline',
        dissolutionDeadline: reportRequiredThisYear && !filedThisYear ? iso(dissolutionDate) : null,
        nextAnnualReportWindow: isActive ? `${filedThisYear || !reportRequiredThisYear ? year + 1 : year}-01-01` : null,
    };
}
