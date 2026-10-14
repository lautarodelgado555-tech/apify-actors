# Tiendanube / Nuvemshop Product & Store Scraper

**Tiendanube Scraper** (called **Nuvemshop** in Brazil) turns any Tiendanube / Nuvemshop online store into clean data: every product with its price, compare-at price, installments, variants (SKU, price, stock, size/color), images, categories, tags and availability. Paste the store URLs, get one row per product. It also has a **store profile** mode that returns the store's country, currency and the contact details the store shows publicly (e-mail, phone, WhatsApp, Instagram, Facebook...). It works with `*.mitiendanube.com`, `*.lojavirtualnuvem.com.br` and stores on their own domain, in Argentina, Mexico, Chile, Colombia, Brazil and the rest of Latin America.

Built by a developer based in Argentina. Spanish and Portuguese keywords work (see the Spanish section below).

> Not affiliated with or endorsed by Tiendanube or Nuvemshop. The Actor only reads pages that any visitor can open in a browser: no login, no private data, no checkout.

## What you can do with it

- **Catalog and price monitoring.** Track competitors' prices, discounts and stock. Schedule the Actor and turn on *incremental mode* so each run returns only **new or changed** products (price, compare-at price, stock or availability) and you only pay for those.
- **Marketplace and dropshipping research.** Export a whole store, or just one category, with variants and stock to CSV, Excel or JSON.
- **Agency prospecting.** Use *store profile* mode on a list of stores to get country, platform, product count, last catalog update, and public contacts and social profiles.
- **Feeds and migrations.** Pull a store's catalog (names, descriptions, images, SKUs, variants) into your own system.

## Modes

| Mode | Returns | Event charged |
|---|---|---|
| **Product catalog** (`catalog`) | One row per product | `product` |
| **Store profile** (`storeProfile`) | One row per store | `store` |

### How the catalog is discovered

For each store the Actor reads the store's own sitemap (the gzipped sitemap that Tiendanube publishes in `robots.txt`, with `/sitemap.xml` as fallback), keeps the product pages and opens them. If a store has no usable sitemap it walks the catalog pages (`/productos/?page=2`...). A category URL reads only that category, a product URL reads only that product. Most recently modified products come first, so a small limit still gives you the freshest items.

## Input

| Field | What it does |
|---|---|
| `mode` | `catalog` (products) or `storeProfile` (one row per store). |
| `stores` | Store URLs or domains, e.g. `https://name.mitiendanube.com`, `shop.mybrand.com`, a category URL or a single product URL. |
| `maxProductsPerStore` | Products examined per store (default 100). |
| `onlyInStock` | Skip products with nothing available. |
| `keywords` | Keep only products whose name, brand, category, tags or URL contain one of these words. |
| `since` | Date (`2026-10-01`) or period (`7 days`). Products last modified earlier, according to the store sitemap, are not opened at all. |
| `incrementalStoreName` | Name of a snapshot. With it, runs return only new or changed products. Use the same name on every run of the same watchlist. |
| `includeDescriptionHtml` | Also return the description with its HTML. |
| `requestsPerSecond` | Starting speed for all requests together (default 3). See the FAQ on rate limits. |
| `maxConcurrency`, `maxConcurrencyPerStore` | Requests in flight at once (defaults 8 and 4). |
| `proxyConfiguration` | Optional. Plain requests work; add a proxy only if a store blocks you. |

Example input:

```json
{
  "mode": "catalog",
  "stores": ["https://tallertextildoscoyotes.mitiendanube.com", "peek-store.com"],
  "maxProductsPerStore": 20,
  "onlyInStock": true,
  "incrementalStoreName": "my-watchlist"
}
```

## Output

Real product record (Peek Store, a Tiendanube store in Mexico; description shortened):

```json
{
  "url": "https://peek-store.com/productos/tisha-bendiceme",
  "productId": 321284040,
  "name": "Tisha Bendíceme",
  "brand": null,
  "description": "Icónica canción de Charles Ans ft Juaninacka perteneciente a su disco LADO A. Esta pieza f...",
  "categories": ["By Charles Ans"],
  "tags": [],
  "price": 600,
  "compareAtPrice": null,
  "promotionalPrice": null,
  "onSale": false,
  "discountPercent": null,
  "priceMin": 600,
  "priceMax": 600,
  "currency": "MXN",
  "installments": null,
  "availability": "InStock",
  "inStock": true,
  "stockTotal": 1,
  "stockUnlimited": false,
  "sku": null,
  "variantCount": 2,
  "variants": [
    { "id": 1424187492, "sku": null, "price": 600, "compareAtPrice": null, "promotionalPrice": null, "stock": 0, "available": false, "attributes": { "Color": "NEGRA" }, "image": "https://acdn-us.mitiendanube.com/stores/003/780/562/products/11-tisha-bendiceme-negra-3a26b8dc286167dc9d17699004798242-1024-1024.jpg" },
    { "id": 1424187508, "sku": null, "price": 600, "compareAtPrice": null, "promotionalPrice": null, "stock": 1, "available": true, "attributes": { "Color": "BLANCA" }, "image": "https://acdn-us.mitiendanube.com/stores/003/780/562/products/10-tisha-bendiceme-blanca-853285ae7d6f34e83517699004830053-1024-1024.jpg" }
  ],
  "images": ["https://acdn-us.mitiendanube.com/stores/003/780/562/products/10-11-tisha-bendiceme-978ab1007c165652a417699004860046-1024-1024.jpg"],
  "image": "https://acdn-us.mitiendanube.com/stores/003/780/562/products/10-11-tisha-bendiceme-978ab1007c165652a417699004860046-1024-1024.jpg",
  "weightKg": null,
  "storeName": "Peek Store",
  "storeDomain": "peek-store.com",
  "country": "MX",
  "language": "es",
  "platform": "tiendanube",
  "engine": "next",
  "lastModified": "2026-10-11T19:09:55.000Z",
  "scrapedAt": "2026-10-14T01:49:26.123Z"
}
```

- `price` is the price a customer pays today for the default (first available) variant. `compareAtPrice` is the crossed-out price when there is one; `discountPercent` is computed from both.
- `stock` is `null` when the store sells without stock control; `stockUnlimited` tells you so and `stockTotal` is then `null`.
- `installments` (stores on the classic storefront) gives the maximum number of installments, the maximum number without interest and the value of that interest-free installment.
- In incremental mode every row has `changeType`: `new` or `changed`.
- A run also saves an `OUTPUT` record with the status of each input store (`ok`, `not_tiendanube`, `store_not_found`, `blocked`, `invalid_input`).

Store profile rows contain: `name`, `domain`, `platform` (`tiendanube` or `nuvemshop`), `country`, `currency`, `language`, `description`, `logo`, `emails`, `phones`, `whatsapp`, `instagram`, `facebook`, `tiktok`, `youtube`, `twitter`, `pinterest`, `linkedin`, `productCount`, `lastProductUpdate` and (newer storefronts) `createdAt`.

## Pricing

Pay per event, no extra platform usage:

| Event | FREE / Bronze | Silver | Gold |
|---|---|---|---|
| `product` (one product row) | $0.001 | $0.0008 | $0.0005 |
| `store` (one store profile) | $0.005 | $0.004 | $0.003 |

That is about **$1 per 1,000 products** on the free/bronze tier and **$0.50 per 1,000** on Gold. In incremental mode, unchanged products cost nothing. Failed pages, deleted products, stores that are not on Tiendanube and blocked stores are never charged. Free Apify plans return at most 10 results per run.

Platform cost of a run (the Actor uses plain HTTP, no browser): a test run on the Apify platform with 10 products from 3 stores took 8 seconds and used USD 0.0010 of platform usage at 2 GB, start-up included. At the default speed (about 3 pages per second) that extrapolates to roughly USD 0.05 per 1,000 products. It is an estimate from a small run.

## FAQ

**Does it need proxies?** No. Tiendanube / Nuvemshop storefronts answer normal requests and the runs in testing never needed a proxy. The proxy field is there in case a particular store blocks you or you want to go faster than the default speed.

**How fast is it, and what are the rate limits?** Tiendanube / Nuvemshop rate-limit each IP address across all stores: in tests from datacenter IPs, about 2 uncached pages per second were always fine and about 4 per second triggered short rate-limit answers (HTTP 429, a few seconds). The Actor therefore starts at 3 requests per second for the whole run, halves its speed and pauses after every 429, and speeds up again while everything works. Expect roughly 150-200 products per minute; stores whose pages are served from the edge cache are often faster. A 5,000-product store takes about half an hour. With a proxy that rotates IPs you can raise `requestsPerSecond`.

**Are there two kinds of storefronts?** Yes. Most stores use the classic theme engine; newer stores use a Next.js storefront. The Actor reads both (the `engine` field tells you which one).

**Why did a product from the sitemap not show up?** Stores sometimes leave deleted or hidden products in the sitemap and the store answers with a 404 template. Those are skipped and not charged.

**Can it find stores by niche or country?** Not yet. The honest state: stores can be listed from public archives (Common Crawl and the Internet Archive index hundreds to thousands of `*.mitiendanube.com` / `*.lojavirtualnuvem.com.br` hosts), but those archives hold no category or country data, many of the hosts are closed stores, and stores on their own domain do not show up. A real "find me stores that sell X in Argentina" needs a homepage fetch per candidate and returns a small, biased sample, so it is on the roadmap rather than half-built. Today you bring the list of stores (from your CRM, ad libraries, a directory) and the *store profile* mode enriches it.

**What about reviews, or the customer's cart?** Not collected: only the public catalog data shown to every visitor.

## Limits

- Public pages only; prices are shown as the store shows them to a visitor in its default country and currency.
- E-mail addresses are only returned when the store shows one publicly (newer storefronts expose the store e-mail; many classic stores show only WhatsApp and social links).
- If a store serves a bot-check or HTTP 403 page, the Actor stops for that store and charges nothing (it fails the run if that happens for every store).
- Stores can change their markup; the Actor is checked daily against live stores.

## Spanish / Portugués

**Scraper de Tiendanube / Nuvemshop**: pegá las URLs o dominios de las tiendas y obtené un registro por producto: precio, precio tachado, cuotas, variantes (SKU, precio, stock, talle/color), imágenes, categorías, etiquetas y disponibilidad. El modo *Perfil de tienda* devuelve país, moneda y los datos de contacto que la tienda muestra públicamente (WhatsApp, e-mail, teléfono, Instagram, Facebook).

- Funciona con `*.mitiendanube.com`, `*.lojavirtualnuvem.com.br` y tiendas con dominio propio.
- **Modo incremental**: poné un nombre en `incrementalStoreName` y programá el Actor; cada corrida devuelve solo los productos **nuevos o con cambios** de precio o stock, y solo pagás esos.
- `keywords` acepta palabras en español o portugués ("zapatillas", "tênis").
- Hecho por un desarrollador de Argentina. No está afiliado a Tiendanube ni Nuvemshop.

**Em português:** o Actor lê lojas Nuvemshop (`*.lojavirtualnuvem.com.br` ou domínio próprio) e devolve produtos, preços, parcelas, variações e estoque; no modo incremental só devolve o que é novo ou mudou.

## More Actors by this developer

- [Florida Sunbiz Scraper](https://apify.com/lautarodelgado/florida-sunbiz-scraper): Florida business entities, status and annual report checks.
