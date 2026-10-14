# mercadolibre-monitor (NO-GO, dormant)

Planned Actor: "Mercado Libre Price Monitor & Seller Scraper" (watchlist price/stock diffs, seller catalogs, best sellers).
Status on 2026-10-14: **not buildable with public data**. There is no `store.json`, so nothing is listed, priced or public.
The code that remains is a diagnostics-only `probe` mode (no charges) so the question can be re-tested cheaply if Mercado Libre changes its rules.

## Evidence (all measured, from GitHub runner IPs and from Apify runs)

Raw outputs: `recon/mercadolibre-monitor/out/` (runner recon, rounds 1-4) and `ci/mercadolibre-monitor/` (Apify platform run, `apify-dataset.json`).

| Surface | Datacenter IP (GitHub runner, Apify datacenter proxy) | Apify residential proxy (AR) | Real Firefox |
| --- | --- | --- | --- |
| Item pages (`/p/MLA..`, `/up/MLAU..`, `articulo.`) | 40/40 redirected to `/gz/account-verification` ("Para continuar, ingresa a tu cuenta") | HTTP: 9/9 served a proof-of-work bot-challenge shell (about 4-6 KB, no data) | 3/3 end on the same login wall after the challenge |
| Listings (`listado.`, `/tienda/<slug>/` catalog) | 100% login wall | 3/4 challenge shells, 1 login wall | 2/2 login wall |
| Best sellers (`/mas-vendidos`, `/mas-vendidos/MLA1055`) | 100% login wall | login wall / challenge shell | 2/2 login wall |
| Click-through from an open store page to one of its cards | n/a | n/a | login wall (Firefox, runner IP) |
| `api.mercadolibre.com` `/items`, `/items?ids=`, `/products`, `/sites/MLA/search`, `/users` | 403 (PolicyAgent) or 401 `unspecified_token` | same | n/a |
| `api.mercadolibre.com` `/categories/{id}`, `/sites/MLA/domain_discovery/search` | 200 (category metadata only, no prices or items) | n/a | n/a |
| Official-store pages `/tienda/<slug>`, `/tiendas-oficiales`, home pages of MLA/MLM/MLB/MLC/MCO, `/ofertas/supermercado` | open, 10 of 11 tested (66 to 117 KB compressed) | open | open |

Block rate for the data this Actor needs (item, listing, best-seller, seller-catalog pages and the item API): **100%** on every route tried, 0 usable pages out of about 100. Playbook rule 6 forbids logins, CAPTCHA services and paid unblockers, so the run fails closed.

## Economics (the GATE)

- Apify residential proxy is billed at USD 8.0/GB (measured: 0.000529 GB cost USD 0.00423 on the platform run).
- The only real pages that came back were the open store/home pages: 66 KB (store home) to 117 KB (offers page) compressed. Assuming an item page is similar (not measurable, it is walled), proxy cost is USD 0.0005-0.0010 per page, plus about 0.00007 Cheerio compute.
- At the research prices `0.8 x price >= 2 x cost` gives: FREE/BRONZE USD 0.0024 vs 2 x 0.0006-0.0011: marginal or failing. GOLD USD 0.0012 vs 0.0012-0.0022: fails. So even if the wall could be passed, the residential route would not leave the required margin at GOLD.
- Open pages cost only compute (about USD 0.07 per 1,000 Cheerio pages, no proxy), but they expose a few curated cards per official store (price, previous price, discount, installments, shipping label), not stock, sold quantity, seller, catalog winner or Full/Flex, so they do not support the watchlist product.

## What would reopen this

- Mercado Libre lets anonymous automated visitors reach item/listing pages again, or
- an API credential flow that is public-data-only and acceptable under the playbook (the item API needs an OAuth token; not used here), or
- verification that another residential pool or a headful browser passes without a login (not verified; only Apify residential AR and headless Firefox/Chromium were tried).

## Roadmap if reopened

1. `watchlist` (named key-value store snapshots, diffs, `item-check` / `change-alert` events)
2. `seller` (catalog and reputation), 3. `bestsellers` (ranking per category and site)
4. Follow-ups, out of scope so far: Q&A scraping, Argentina classifieds (cars, real estate).

## Probe mode

Input `{ "mode": "probe", "probeUrls": [...], "probeRoutes": [{ "label": "x", "proxyConfiguration": {...} }] }`. It reports status, compressed bytes and whether the response is a login wall or challenge. It never charges.

Not affiliated with or endorsed by Mercado Libre.
