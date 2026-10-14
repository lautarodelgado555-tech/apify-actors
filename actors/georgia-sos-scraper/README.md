# Georgia Secretary of State Business Search Scraper

Search the Georgia Secretary of State Corporations Division registry (**eCorp**) and get clean, structured records: entity status with a normalized **good standing** flag, formation date, jurisdiction, principal office address, registered agent and address, officers, and the **annual registration status** (filed, due, or late).

Built for KYB and due diligence, accounting and compliance firms, registered agents, lead generation, and AI agents that need Georgia business data without clicking through the portal.

## What you can search

| Search by | Example | Notes |
| --- | --- | --- |
| Business name | `Delta Air Lines` | *Starts with* (default), *contains* or *exact match*, as in eCorp. |
| Control number | `H853425` | The entity's Georgia control number. |
| Registered agent name | `Corporation Service Company` | Lists every entity that agent serves. |
| Officer name | `Bastian` | Lists entities where the person is a recorded officer. |

Give the Actor one term or a list of them; it handles paging, deduplication and retries. eCorp ignores punctuation and spaces when matching.

## What you get

One record per entity (output example from a real run is below):

- **Identity**: control number, name, entity type (domestic or foreign profit corporation, LLC, nonprofit, limited partnership and so on), jurisdiction.
- **Status**: the portal's status text (`Active/Compliance`, `Active/Owes AR`, `Admin. Dissolved`, `Dissolved`, `Revoked`, `Withdrawn`, `Merged` ...) plus normalized `active`, `goodStanding` and `statusNormalized`.
- **Dates**: formation or registration date (ISO), dissolved date when shown.
- **Addresses**: principal office address, registered agent name, address and county.
- **Officers**: name, title and address for corporations and partnerships (LLCs normally list none; Georgia only updates officers when the entity files its annual registration).
- **Annual registration**: last annual registration year as published by the portal, and a derived status.
- **Filing history** (optional): every annual registration with its filing date, plus all other filings.

### Annual registration status, explained

Georgia requires every active entity to file an annual registration. It can be filed from **January 1** and is due by **April 1**; filing after April 1 adds a **$25 late fee**, and entities that do not file may be administratively dissolved or have their authority revoked (the state does not publish a date for that, so none is reported). The first registration is due the year after the entity was formed.

The portal publishes the **last annual registration year** but not a next-due date. This Actor combines that year with the rule above:

- `filed`: the current year's registration (or a later one) is on file.
- `due`: not filed yet and it is before April 1.
- `late_fee_applies`: not filed and it is after April 1.
- `not_yet_required`: the entity was formed this year.
- `not_applicable_inactive`: the entity is not active.

`annualReportDueDate` is April 1 of the current year and only appears when the current year's registration is missing. `portalOwesAnnualRegistration` is true when Georgia itself shows the status `Active/Owes AR`. This is derived information, not an official determination: confirm with the Secretary of State before relying on it.

## Output example

```json
{
  "controlNumber": "H853425",
  "name": "DELTA AIR LINES, INC.",
  "entityType": "Foreign Profit Corporation",
  "status": "Active/Compliance",
  "active": true,
  "goodStanding": true,
  "statusNormalized": "active_good_standing",
  "formationDate": "1967-05-10",
  "jurisdiction": "Delaware",
  "principalAddress": "1030 Delta Blvd, Dept 982, Atlanta, GA, 30354, USA",
  "registeredAgentName": "Corporation Service Company",
  "registeredAgentAddress": "2 SUN COURT, SUITE 400, PEACHTREE CORNERS, GA, 30092, USA",
  "registeredAgentCounty": "Gwinnett",
  "officers": [
    { "name": "Daniel C. Janki", "title": "CFO", "address": "1030 Delta Blvd, Dept 982, Atlanta, GA, 30354, USA" },
    { "name": "Edward H. Bastian", "title": "CEO", "address": "1030 Delta Blvd, Dept 982, Atlanta, GA, 30354, USA" },
    { "name": "Peter W. Carter", "title": "Secretary", "address": "1030 Delta Blvd, Dept 982, Atlanta, GA, 30354, USA" }
  ],
  "lastAnnualReportYear": 2026,
  "annualReportCurrent": true,
  "annualReportStatus": "filed",
  "annualReportDueDate": null,
  "lateFeeApplies": false,
  "nextAnnualReportWindow": "2027-01-01",
  "sourceUrl": "https://ecorp.sos.ga.gov/BusinessSearch",
  "searchType": "businessName",
  "searchTerm": "Delta Air Lines",
  "scrapedAt": "2026-10-14T03:25:59.000Z"
}
```

## Input

| Field | Description |
| --- | --- |
| `searchType` | `businessName`, `controlNumber`, `registeredAgent` or `officer`. |
| `searchTerms` | One or more names or control numbers. |
| `nameMatch` | `startsWith` (default), `contains` or `exact`. Ignored for control numbers. |
| `maxResultsPerSearch` | Stop after this many entities per term (portal pages hold 25). Default 25. |
| `activeOnly` | Skip dissolved, administratively dissolved, revoked, withdrawn and merged entities. |
| `fetchDetails` | Open each entity for formation date, agent address, officers and last annual registration year. Off = list data only. |
| `includeFilings` | Also read the filing history (annual registrations with dates and other filings). |
| `proxyFallback` | On by default: when Cloudflare challenges a connection, retry on another IP and, if needed, on Apify residential IPs. |
| `proxyConfiguration` | Optional. Leave empty (see "Connection and proxies"). |

### Connection and proxies

Georgia's portal sits behind Cloudflare. In our tests the shared Apify **datacenter** proxy pool was blocked in 4 of 4 runs, while a **direct** connection from Apify (4 of 4) and **residential** IPs (4 of 4) got through. So the Actor connects directly by default, and if a connection is challenged it retries on a fresh session and then switches to Apify residential IPs when your account has them (a typical run uses about 20 KB of residential traffic). You do not need to configure a proxy.

## Pricing

You pay per entity record returned (pay per event, **Entity record**). Searches that return nothing cost nothing beyond platform usage, and an entity the portal cannot open is never charged. Free-plan runs are capped at 10 results; paid plans have no cap other than your own `maxResultsPerSearch` and spending limit.

| Plan | Price per entity record |
| --- | --- |
| Free / Bronze | $0.005 |
| Silver | $0.0045 |
| Gold | $0.004 |

## Tips

- Search by **control number** for an exact lookup, or by **name** with *starts with* for the cleanest list.
- Officer names are stored first name first (`Edward H. Bastian`), and *contains* also matches inside longer names (`Bastian` finds `Sebastian`).
- Searching a large registered agent (for example a commercial agent with tens of thousands of entities) is slow on the portal side; set a sensible `maxResultsPerSearch`.
- Name reservations have no control number and no detail page; they are listed without details.
- eCorp has no stable per-entity web address, so `sourceUrl` points to the search page; search the `controlNumber` there to see the same record.

## FAQ

**Why do some records have no officers?** Georgia publishes officers for corporations and partnerships, usually CEO, CFO and Secretary. LLCs normally list none, and officer data only refreshes when the entity files its annual registration, so it can be up to a year old.

**Is this an official determination of good standing?** No. `goodStanding` and `annualReportStatus` are derived from what the portal shows. For legal certainty order a Certificate of Existence from the Secretary of State.

**Does it need a login or a CAPTCHA solver?** No. It reads the public search only, with a normal browser, and never solves or bypasses a CAPTCHA. If Georgia's Cloudflare protection challenges the run, the Actor retries with a fresh IP and, if it stays blocked, stops with a clear message and charges nothing.

## Limitations

- The portal has no bulk download; every record is read live, one at a time.
- No next-due date is published, so the due date is derived (April 1 of the current year) and only shown when the current year's registration is missing.
- No tax IDs, shareholders or financial data are public on eCorp.

## Integrations and API

Run it from the Apify API, schedule it, or call it from an AI agent through Apify's MCP server. Results land in a dataset you can export as JSON, CSV or Excel, or push to Google Sheets, webhooks and Zapier.

## Legal

This Actor reads public records published by the Georgia Secretary of State, Corporations Division. It does not log in, solve CAPTCHAs or collect anything that is not shown to every visitor of ecorp.sos.ga.gov. It is not affiliated with or endorsed by the Georgia Secretary of State. Use the data in line with Georgia public records law and your local regulations.

## More Actors by this developer

- [Florida Sunbiz Business Search & Annual Report Checker](https://apify.com/lautarodelgado/florida-sunbiz-scraper)

## En español

Scraper del registro de empresas de Georgia (EE. UU.): busca por nombre, número de control, agente registrado u oficial y devuelve estado, indicador de buena situación, domicilio, agente registrado, oficiales y el estado del registro anual (presentado, pendiente o con recargo). Sin login ni CAPTCHA, solo datos públicos. No está afiliado ni respaldado por la Secretaría de Estado de Georgia.
