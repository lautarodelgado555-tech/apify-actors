# Florida Sunbiz Business Search & Annual Report Checker

Search the Florida Division of Corporations registry (**Sunbiz**) and get clean, structured records: entity status, addresses, registered agent, officers and managers, FEI/EIN, the full annual report history, links to every filed PDF, and a verdict on whether **this year's annual report is filed, due, or late**.

Built for KYB and due diligence, accounting and compliance firms, registered agents, lead generation, and AI agents that need Florida business data without a browser.

## What you can search

| Search by | Example | Notes |
| --- | --- | --- |
| Entity name | `Acme` | Alphabetical list from the term, like Sunbiz. Filter with *starts with* (default), *exact*, or *all*. |
| Officer or registered agent name | `Smith John` | Last name first, as Sunbiz indexes it. |
| Registered agent name | `Registered Agents Inc` | Agents only. |
| Document number | `L15000160389` | Opens the entity directly. |
| FEI/EIN number | `47-5125953` | Opens the entity directly. |

Give the Actor one term or a list of hundreds; it handles pagination, deduplication and retries.

## What you get

One record per entity:

```json
{
  "entityName": "ACME LLC",
  "entityType": "Florida Limited Liability Company",
  "documentNumber": "L15000160389",
  "feiEin": "47-5125953",
  "dateFiled": "09/21/2015",
  "effectiveDate": "09/23/2015",
  "state": "FL",
  "status": "ACTIVE",
  "lastEvent": "REINSTATEMENT",
  "eventDateFiled": "10/24/2016",
  "principalAddress": "7705 MOWRY ST., JACKSONVILLE, FL 32256",
  "mailingAddress": "7705 MOWRY ST., JACKSONVILLE, FL 32256",
  "registeredAgentName": "BALLARD, GLEN A",
  "registeredAgentAddress": "7705 MOWRY ST., JACKSONVILLE, FL 32256",
  "registeredAgentNotes": ["Name Changed: 10/24/2016"],
  "officerSectionTitle": "Authorized Person(s) Detail",
  "officers": [
    { "title": "MGR", "name": "BALLARD, GLEN A", "address": "7705 MOWRY ST., JACKSONVILLE, FL 32256" }
  ],
  "annualReports": [
    { "reportYear": 2024, "filedDate": "01/17/2024" },
    { "reportYear": 2025, "filedDate": "01/03/2025" },
    { "reportYear": 2026, "filedDate": "01/26/2026" }
  ],
  "documents": [
    { "date": "01/26/2026", "documentType": "ANNUAL REPORT", "url": "https://search.sunbiz.org/Inquiry/CorporationSearch/GetDocument?..." }
  ],
  "lastAnnualReportYear": 2026,
  "annualReportCurrent": true,
  "annualReportStatus": "filed",
  "annualReportDueDate": null,
  "lateFeeApplies": false,
  "dissolutionDeadline": null,
  "nextAnnualReportWindow": "2027-01-01",
  "eventHistoryUrl": "https://search.sunbiz.org/Inquiry/CorporationSearch/EventHistory?...",
  "sunbizUrl": "https://search.sunbiz.org/Inquiry/CorporationSearch/SearchResultDetail?...",
  "searchType": "entityName",
  "searchTerm": "Acme",
  "scrapedAt": "2026-10-13T21:30:00.000Z"
}
```

### Annual report status, explained

Florida requires every active entity to file an annual report between **January 1 and May 1**, starting the year after it was formed. Filing after May 1 adds a **$400 late fee**, and entities that still have not filed by the **third Friday of September** are administratively dissolved.

`annualReportStatus` is one of:

- `filed` — this year's report is on file.
- `due` — not filed yet, and it is before May 1.
- `late_fee_applies` — not filed, after May 1, before the September dissolution date.
- `past_dissolution_deadline` — not filed and past the dissolution date.
- `not_yet_required` — the entity was formed this year.
- `not_applicable_inactive` — the entity is not active.

Use it to flag clients who are about to miss the deadline, verify that a counterparty is in good standing, or build a compliance calendar.

## Pricing

You pay per entity record returned. Searches that return nothing cost nothing beyond platform usage. Set **Max results per search term** to keep runs predictable.

## Tips

- **Officer names** go last name first: `Smith John`, not `John Smith`.
- Turn off **Fetch full details** for a fast, cheap list of name, document number and status only.
- Use **Active entities only** to skip dissolved and cross-referenced records.
- Sunbiz is protected by Cloudflare, so the Actor uses a real browser. Keep the default Apify proxy on.

## Integrations and API

Run it from the Apify API, schedule it, or call it from an AI agent through Apify's MCP server. Results land in a dataset you can export as JSON, CSV or Excel, or push to Google Sheets, webhooks and Zapier.

## Legal

This Actor reads public records published by the Florida Department of State. It does not log in, bypass paywalls, or collect anything that is not shown to every visitor of search.sunbiz.org. Use the data in line with Florida public records law and your local regulations.
