/**
 * Change detection between two normalized records of the same entity.
 *
 * Event types:
 *   statusChanged          canonical status differs
 *   goodStandingChanged    goodStanding flipped between true and false (null = unknown never triggers it)
 *   annualReportDueChanged the source-stated annual report due date moved, appeared or disappeared
 *                          (dates derived from a statutory rule are not entity changes and never alert)
 *   newlyDelinquent        entity became delinquent/suspended, or lost good standing while its status stayed
 *   dissolved              entity became dissolved
 */
import { DELINQUENT_LIKE } from './canonical.js';

export const EVENT_TYPES = ['statusChanged', 'goodStandingChanged', 'annualReportDueChanged', 'newlyDelinquent', 'dissolved'];

const SNAPSHOT_KEYS = [
    'state', 'entityId', 'name', 'entityType', 'statusRaw', 'statusDetail', 'status', 'goodStanding',
    'annualReportDue', 'annualReportDueBasis', 'lastReportFiled', 'registeredAgent', 'dataFreshness', 'checkedAt',
];

/** The compact subset of a record stored between runs. */
export function snapshotOf(record) {
    const snap = {};
    for (const k of SNAPSHOT_KEYS) snap[k] = record[k] ?? null;
    return snap;
}

export const snapshotKey = (state, entityId) =>
    `${state}_${String(entityId)}`.replace(/[^a-zA-Z0-9!\-_.'()]/g, '_').slice(0, 250);

const label = (status, raw) => (raw && raw !== status ? `${status} (${raw})` : String(status));

/** Compare two snapshots/records. Returns [] when `before` is missing or nothing relevant changed. */
export function diffRecords(before, after) {
    if (!before || !after) return [];
    const events = [];

    if (before.status !== after.status) {
        events.push({
            type: 'statusChanged',
            field: 'status',
            before: before.status,
            after: after.status,
            beforeRaw: before.statusRaw ?? null,
            afterRaw: after.statusRaw ?? null,
            severity: 'info',
            message: `Status changed from ${label(before.status, before.statusRaw)} to ${label(after.status, after.statusRaw)}`,
        });
    }

    if (before.goodStanding !== null && after.goodStanding !== null && before.goodStanding !== after.goodStanding) {
        events.push({
            type: 'goodStandingChanged',
            field: 'goodStanding',
            before: before.goodStanding,
            after: after.goodStanding,
            severity: after.goodStanding ? 'info' : 'high',
            message: after.goodStanding ? 'Entity is back in good standing' : 'Entity is no longer in good standing',
        });
    }

    const sourceStated = before.annualReportDueBasis === 'source' || after.annualReportDueBasis === 'source';
    if (sourceStated && (before.annualReportDue ?? null) !== (after.annualReportDue ?? null)) {
        events.push({
            type: 'annualReportDueChanged',
            field: 'annualReportDue',
            before: before.annualReportDue ?? null,
            after: after.annualReportDue ?? null,
            severity: 'info',
            message: `Annual report due date changed from ${before.annualReportDue ?? 'none'} to ${after.annualReportDue ?? 'none'}`,
        });
    }

    const wasBehind = DELINQUENT_LIKE.has(before.status);
    const isBehind = DELINQUENT_LIKE.has(after.status);
    const lostStanding = before.status === after.status && before.goodStanding === true && after.goodStanding === false &&
        after.status !== 'dissolved' && after.status !== 'inactive';
    if ((isBehind && !wasBehind) || lostStanding) {
        events.push({
            type: 'newlyDelinquent',
            field: 'status',
            before: before.status,
            after: after.status,
            severity: 'high',
            message: `Entity is newly ${after.status === 'suspended' ? 'suspended/forfeited' : 'delinquent'}${after.statusRaw ? ` (${after.statusRaw})` : ''}`,
        });
    }

    if (after.status === 'dissolved' && before.status !== 'dissolved') {
        events.push({
            type: 'dissolved',
            field: 'status',
            before: before.status,
            after: after.status,
            severity: 'high',
            message: `Entity is now dissolved${after.statusRaw ? ` (${after.statusRaw})` : ''}`,
        });
    }

    return events;
}
