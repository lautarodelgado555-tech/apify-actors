// Prints the change-alert row the monitor emits for a seeded scenario (used to write the README example).
// Run: node test/example-alert.mjs
import colorado from '../src/adapters/colorado.js';
import { snapshotKey } from '../src/diff.js';
import { processWatchlist } from '../src/monitor.js';
import { Registry } from '../src/registry.js';
import { makeCtx, memoryStore, metaRoutes } from './helpers.js';

const previous = {
    state: 'CO', entityId: '20191893002', name: 'LRicheauxCMP, LLC', entityType: 'Domestic limited liability company',
    statusRaw: 'Good Standing', statusDetail: null, status: 'active', goodStanding: true, annualReportDue: null,
    annualReportDueBasis: null, lastReportFiled: '2021-01-29', registeredAgent: 'Lindsey Noel Richeaux',
    dataFreshness: '2022-05-01T11:00:00.000Z', checkedAt: '2022-05-01T12:00:00.000Z',
};
const store = memoryStore({ [snapshotKey('CO', '20191893002')]: previous });
const ctx = makeCtx([
    ['resource/4ykn-tg5h.json?entityid=20191893002', 'co-id'],
    ['resource/casm-dbbj', 'co-hist-agg'],
    ...metaRoutes,
]);
const rows = [];
await processWatchlist({
    watchlist: [{ state: 'CO', id: '20191893002' }], mode: 'monitor', registry: new Registry([colorado]), store,
    charge: async () => ({ ok: true, limitReached: false }), emit: async (r) => { rows.push(r); }, ctx, options: {},
});
console.log(JSON.stringify(rows.find((r) => r.recordType === 'change-alert'), null, 2));
