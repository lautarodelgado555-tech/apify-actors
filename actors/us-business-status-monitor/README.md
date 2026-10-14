# US Business Entity Status & Good Standing Monitor

Check whether a US company is **in good standing** and **when its annual report is due**, with one normalized answer across states, and get a **change alert** the day an entity becomes delinquent, suspended or dissolved. The Actor reads official state open data (no login, no CAPTCHA, no proxy) and returns the same fields whatever the state calls its statuses.

Most business-entity Actors do point-in-time lookups and hand you the state's raw status text ("Forfeited existence", "Delinquent", "Active - In Good Standing"). This one maps every state to the same canonical vocabulary, adds the annual report due date whenever the source states it, and remembers the last snapshot of every entity so a scheduled run tells you **what changed**.

Built for accounting and compliance teams (annual report tracking for client portfolios), registered agents, KYB / vendor due diligence, lenders, and AI agents that need "is this entity OK?" as a single boolean plus evidence.

## What you get

For every check you receive one row with:

| Field | Meaning |
| --- | --- |
| `state`, `entityId`, `name`, `entityType` | Identity as published by the state |
| `statusRaw` | The state's own status text, untouched |
| `status` | Canonical: `active`, `delinquent`, `suspended`, `dissolved`, `inactive`, `unknown` |
| `goodStanding` | `true`, `false`, or `null` when the source cannot tell (never a guess) |
| `annualReportDue` | ISO date, only when the source states it (`annualReportDueBasis: "source"`) or the state's rule is verified and cited (`"statutory-rule"`); otherwise `null` |
| `lastReportFiled` | Last annual/periodic report date when the source publishes filings |
| `registeredAgent`, `registeredAgentAddress` | When the dataset has them |
| `source`, `sourceUrl` | Dataset and the exact API record the row came from |
| `dataFreshness` | When that open dataset was last updated (open data lags the live register) |
| `checkedAt` | When this check ran |

### Canonical status

| `status` | Meaning | Examples of raw values mapped to it |
| --- | --- | --- |
| `active` | Registered and in effect | CO "Good Standing", DC "Active - In Good Standing", CT "Active", TX right to transact "Active" |
| `delinquent` | Registered but behind on a required filing (curable) | CO "Delinquent"/"Noncompliant", CT "Active" + "Annual report past due"/"Ready for dissolution", DC "Active - Not in Good Standing" |
| `suspended` | Authority forfeited or suspended by the state (curable by reinstatement) | TX franchise tax "Forfeited" (the "forfeited existence" case), NY "Suspended" |
| `dissolved` | Ended for good | CO "Administratively Dissolved"/"Revoked", CT "Dissolved"/"Forfeited"/"Revoked", DC "Dissolved"/"Revoked", TX SOS "Dissolved" |
| `inactive` | No longer registered for another reason | Withdrawn, merged, converted, cancelled; NY "Inactive"; Oregon entity that left the active list |
| `unknown` | Source value not recognised (name reservations, new codes) | |

## Jurisdiction coverage

All six are **official open-data feeds read through their query APIs** (Socrata SODA or the DC ArcGIS service); nothing is scraped. Each was verified live from a cloud runner with no key and no login.

| State | Source | Freshness (seen) | Annual report due | How status maps |
| --- | --- | --- | --- | --- |
| **CO** | CO Secretary of State, data.colorado.gov "Business Entities in Colorado" + transaction history | 2026-10-13 | No (not published); `lastReportFiled` yes | Good Standing: active/true. Exists: active/null. Delinquent, Noncompliant, Registered Agent Resigned: delinquent/false. Dissolved (any kind), Revoked: dissolved. Withdrawn, Merged, Converted, Consolidated: inactive. |
| **CT** | CT Secretary of the State, data.ct.gov Business Master + Filing History + Agents | 2026-10-13 | **Yes, stated by the registry**; `lastReportFiled` yes | Active: active/true unless sub-status says past due / ready for dissolution / no agent (delinquent/false). Forfeited, Dissolved, Revoked: dissolved. Withdrawn, Cancelled, Merged and others: inactive. Name reservations: unknown. |
| **DC** | DC Dept. of Licensing and Consumer Protection, Open Data DC "Corporate Registration" | 2026-10-13 | **Yes, stated by the register** (biennial); `lastReportFiled` yes | "Active - In Good Standing": active/true. "Active - Not in Good Standing": delinquent/false. Dissolved, Revoked, Terminated: dissolved. Withdrawn, Merged, Converted, Cancelled: inactive. |
| **NY** | NY Department of State, data.ny.gov Active Corporations + Entity Status History | 2026-10-13 | No (biennial statement date not published) | Active: active/**null** (NY publishes no good-standing flag). Suspended: suspended/false. Inactive, Discontinued: inactive/false. |
| **OR** | OR Secretary of State, data.oregon.gov Active Businesses (ALL + County Data) | 2026-10-13 (anniversary data: 2026-08-14) | **Yes where published** (renewal anniversary, only for entities with an Oregon principal place of business) | Listed: active/**null**. The dataset lists active entities only: an entity that was monitored and then disappears is reported as `inactive`. |
| **TX** | TX Comptroller, data.texas.gov "Active Franchise Taxpayers" (record layout used for every code) | 2026-10-10 | **Statutory rule**: May 15 (next business day on weekends), first report the year after becoming liable. Only for non-exempt entities in good standing | Right to transact "Active": active/true. SOS or franchise "Forfeited": suspended/false. Dissolved/expired/terminated: dissolved. Withdrawn/merged/converted: inactive. |

Open data can lag the live register by up to a day or more; `dataFreshness` shows exactly how stale the dataset was. **Always verify on the official source before acting** (Colorado, Connecticut, DC, New York, Oregon and Texas links are in the FAQ).

Not covered, and why: **Delaware and New Jersey** (status only in paid reports), **South Carolina, Wisconsin, Arkansas** (CAPTCHA), **Pennsylvania** (the state portal answers datacenter traffic with a security-check page, and its open data carries no status), **Wyoming** (human-verification CAPTCHA), **California** (needs an API key; planned as an optional user-supplied key). More states are on the roadmap below.

## Modes

### Check (point in time)

```json
{
  "mode": "check",
  "watchlist": [
    { "state": "TX", "id": "32070357671" },
    { "state": "CO", "name": "Zayo Education" }
  ]
}
```

An entry with an `id` returns exactly one row. An entry with a `name` returns up to `maxCandidates` best matches, each with `matchScore` (0 to 1) and `matchType` (`exact`, `exact-ignoring-legal-suffix`, `starts-with`...). Names are not unique identifiers, so use the ids from a name search for anything you monitor.

### Monitor (check + change detection)

```json
{
  "mode": "monitor",
  "snapshotStoreName": "my-clients-watchlist",
  "watchlist": [
    { "state": "CO", "id": "20191893002", "label": "Client A" },
    { "state": "CT", "id": "0074441", "label": "Client B" }
  ]
}
```

The first run stores a baseline snapshot per entity in a **named key-value store** (it survives between runs). Every later run compares and emits one `change-alert` row per entity that changed, with before/after. Events:

| Event | Fires when |
| --- | --- |
| `statusChanged` | canonical status differs |
| `goodStandingChanged` | good standing flips between `true` and `false` |
| `annualReportDueChanged` | a **source-stated** due date moves, appears or disappears (for example after a report is filed). Dates derived from a statutory rule never alert |
| `newlyDelinquent` | entity became delinquent or suspended, or lost good standing |
| `dissolved` | entity became dissolved |

Name-only entries are never silently monitored. In monitor mode they return candidates with `needsEntityId: true` and a hint with the id to add (turn on `autoResolveExactName` to monitor a name only when exactly one candidate matches exactly).

Example `change-alert` row (illustrative: produced by the test suite from a real Colorado record and a seeded earlier snapshot):

```json
{
  "recordType": "change-alert",
  "state": "CO",
  "entityId": "20191893002",
  "name": "LRicheauxCMP, LLC",
  "summary": "LRicheauxCMP, LLC (CO): Status changed from active (Good Standing) to delinquent (Delinquent); Entity is no longer in good standing; Entity is newly delinquent (Delinquent)",
  "eventTypes": ["statusChanged", "goodStandingChanged", "newlyDelinquent"],
  "events": [
    { "type": "statusChanged", "before": "active", "after": "delinquent", "beforeRaw": "Good Standing", "afterRaw": "Delinquent", "severity": "info" },
    { "type": "goodStandingChanged", "before": true, "after": false, "severity": "high" },
    { "type": "newlyDelinquent", "before": "active", "after": "delinquent", "severity": "high" }
  ],
  "previous": { "status": "active", "goodStanding": true, "checkedAt": "2022-05-01T12:00:00.000Z" },
  "current": { "status": "delinquent", "goodStanding": false, "checkedAt": "2026-10-14T12:00:00.000Z" },
  "sourceUrl": "https://data.colorado.gov/resource/4ykn-tg5h.json?entityid=20191893002"
}
```

### Schedules and webhooks

Run in monitor mode on an Apify **schedule** (daily is plenty: the sources update at most daily) and add a **webhook** on run success. The run's key-value store record `OUTPUT` is a compact summary with counts and a flat `changeEvents` array (state, entityId, name, type, before, after), ideal as a webhook payload or for a Zapier/Make step; the dataset holds the full `change-alert` rows. If `changeEvents` is empty, nothing changed.

## Example output (real, from a CI run)

```json
{
  "recordType": "entity-check",
  "state": "CT",
  "entityId": "0074441",
  "name": "STANLEY BLACK & DECKER, INC.",
  "entityType": "Domestic stock corporation",
  "statusRaw": "Active",
  "status": "active",
  "goodStanding": true,
  "formationDate": "1901-06-04",
  "annualReportDue": "2027-06-04",
  "annualReportDueBasis": "source",
  "lastReportFiled": "2026-06-12",
  "registeredAgent": "CORPORATION SERVICE COMPANY",
  "source": "Connecticut Secretary of the State via data.ct.gov (Business Registry - Business Master)",
  "sourceUrl": "https://data.ct.gov/resource/n7gp-d28j.json?accountnumber=0074441",
  "mode": "opendata",
  "dataFreshness": "2026-10-13T09:30:34.000Z",
  "checkedAt": "2026-10-14T01:54:20.813Z",
  "changed": false
}
```

Entries that cannot be answered return an explanatory row and are **never charged**: `not-found` (unknown id or name) and `lookup-error` (`UNSUPPORTED_STATE`, `INVALID_ENTRY`, `SOURCE_BLOCKED`, `SOURCE_ERROR`).

## Input

| Field | Description |
| --- | --- |
| `mode` | `check` (default) or `monitor` |
| `watchlist` | Array of `{ "state": "TX", "id": "..." }` or `{ "state": "CO", "name": "..." }`, optional `label` |
| `maxCandidates` | Candidates returned per name entry (default 3, max 10); each is a charged check |
| `activeOnly` | For name searches, skip dissolved / withdrawn / inactive entities |
| `autoResolveExactName` | Monitor mode: monitor a name entry when exactly one candidate matches exactly |
| `maxChecks` | Safety limit of charged checks per run (default 500) |
| `snapshotStoreName` | Named key-value store for snapshots (default `us-business-status-snapshots`); use different names for separate watchlists |

Free-plan runs are limited to **10 checks per run**.

## Pricing

Pay per event, no subscription and no per-entity monthly fee. Prices drop with your Apify plan:

| Event | FREE / BRONZE | SILVER | GOLD and above |
| --- | --- | --- | --- |
| `entity-check` (one normalized entity row) | $0.02 | $0.015 | $0.01 |
| `change-alert` (one alert per changed entity per run) | $0.01 | $0.0075 | $0.005 |

Monitoring 100 entities every day costs about $2.00 per day in checks on the base tier ($1.00 on GOLD), plus $0.01 or less per change that actually happens. For comparison, other monitors on the Store charge per record without alerts or add a monthly fee per monitored company. Not-found entries, errors and blocked lookups are never charged, and the Actor respects the run's maximum cost.

## FAQ

**Is this legal advice or a certificate of good standing?** No. It is a convenience layer over public open data. Statuses can lag the live register. Verify on the official source before relying on a result, and request an official certificate where one is required.

**Where do I verify a result?** Colorado: coloradosos.gov business search. Connecticut: service.ct.gov/business business search. DC: dlcp.dc.gov/page/corporations. New York: apps.dos.ny.gov/publicInquiry. Oregon: sos.oregon.gov/business/pages/find.aspx. Texas: mycpa.cpa.state.tx.us/coa (Franchise Tax Account Status).

**Why is `annualReportDue` null for a state?** Because the source does not state it and no verified, documented rule exists. A null is better than a guess. Colorado and New York do not publish due dates in their open data. Texas uses the published May 15 franchise tax date and says so in `annualReportDueBasis` and `annualReportDueNote`.

**Why is `goodStanding` null for New York or Oregon?** Those states publish active-or-not lists but no good-standing flag, so we do not invent one.

**Why did a monitored Oregon entity become `inactive`?** The Oregon feed lists active businesses only. When an entity you monitor disappears from it, the Actor reports it as inactive (status text "Absent from the state's list of active entities").

**How current is the data?** See `dataFreshness` on each row: it is the update time of the underlying open dataset.

**What does the Actor collect?** Only public registry data the states publish as open data. No logins, no CAPTCHAs, no proxies. Not affiliated with or endorsed by any state agency or open-data portal mentioned here.

## Roadmap

Live adapters being added to the same framework (each state is one file implementing the same interface): **Florida** (Sunbiz), **Washington**, **Georgia**, **Arizona**. California through a free, optional user-supplied API key. More open-data states as feeds are verified.

## More Actors by this developer

[Florida Sunbiz Business Search & Annual Report Checker](https://apify.com/lautarodelgado/florida-sunbiz-scraper)

## En espanol (resumen)

Este Actor responde "esta empresa estadounidense esta al dia con el estado y cuando vence su annual report?" con un formato unico para todos los estados (CO, CT, DC, NY, OR, TX): `status` canonico, `goodStanding` (verdadero, falso o nulo si la fuente no lo dice), `annualReportDue` solo cuando la fuente lo declara o la regla del estado esta documentada, y fecha de actualizacion del dataset. En modo `monitor` guarda una foto de cada entidad y genera una alerta (`change-alert`) cuando cambia el estado, deja de estar en regla, se disuelve o se mueve la fecha del annual report. Usa datos abiertos oficiales, sin login ni CAPTCHA. No es asesoramiento legal: verifique siempre en la fuente oficial. Precio por evento desde $0.02 por chequeo y $0.01 por alerta (baja con el plan de Apify).
