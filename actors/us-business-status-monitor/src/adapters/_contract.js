/**
 * ADAPTER CONTRACT (read this before vendoring a new state).
 *
 * To add a state, drop a file `src/adapters/<state>.js` (lowercase state name, e.g. `florida.js`) that
 * default-exports (or exports as `adapter`) an object of this shape. The registry (src/registry.js) discovers it
 * automatically; the orchestrator, normalization checks, change detection, charging and output need no changes.
 *
 *   export default {
 *     state: 'FL',                  // 2-letter code, upper case, unique
 *     stateName: 'Florida',
 *     mode: 'opendata' | 'live',    // 'opendata' = official dataset/API read over HTTP; 'live' = state portal lookup
 *     activeListOnly: false,        // true if the source lists only ACTIVE entities (absence is then informative)
 *     source: 'Human readable source name',
 *     sourceUrl: 'https://...',     // dataset / portal landing page
 *     officialSearchUrl: 'https://...',  // where a human verifies the record
 *     supports: { annualReportDue: boolean, lastReportFiled: boolean, registeredAgent: boolean },
 *     async lookup(query, ctx) { ... return NormalizedRecord[] }
 *   };
 *
 * query = { id?: string, name?: string, limit: number, activeOnly: boolean }
 *   - exactly one of id / name is set. `id` is the state's entity number; return at most one record for it.
 *   - for `name`, return up to `limit` best candidates (the orchestrator scores and ranks them again).
 *   - return [] when nothing is found. Throw `SourceError` (src/http.js) when the source fails or blocks;
 *     set `blocked: true` for challenges/captchas (the run then fails closed and charges nothing).
 *
 * ctx = {
 *   fetchJson(url, opts) -> parsed JSON (retries built in, throws SourceError),
 *   now: Date,                    // use this instead of new Date() so tests are deterministic
 *   cache: Map,                   // per-run cache (dataset freshness, etc.)
 *   log: { info, debug, warning }
 * }
 *
 * Build every record with makeRecord() from src/canonical.js: it fills all keys, validates the canonical
 * `status` and `goodStanding`, and refuses invented values. Rules:
 *   - status is one of active | inactive | dissolved | delinquent | suspended | unknown.
 *   - goodStanding is true / false / null; null when the source cannot tell.
 *   - annualReportDue only when the source states it (basis "source") or the state's rule is verified and the
 *     code cites the rule's URL (basis "statutory-rule"); otherwise null.
 *   - dataFreshness is when the underlying dataset was last updated (ISO), or null if unknown.
 *   - checkedAt is ctx.now.toISOString().
 *
 * Live (browser) adapters may import their own dependencies (crawlee/playwright); remember to add them to
 * package.json and switch the Dockerfile base image accordingly when vendoring.
 */
export {};
