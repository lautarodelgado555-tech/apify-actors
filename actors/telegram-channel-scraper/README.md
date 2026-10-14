# Telegram Channel Scraper & Monitor - Public Posts

This **Telegram channel scraper** reads the public web preview of Telegram channels (`t.me/s/<channel>`) and returns every message as clean, structured data: text, formatted HTML, date, views, reactions, forwards, replies, polls, link previews, links, hashtags, mentions and media metadata. It walks the **complete channel history back to the first message**, can jump to any date range, and has an **incremental monitor mode** that returns only new messages on every scheduled run.

No Telegram account, phone number, API key or login is needed. Only **public** channels are supported: private channels, invite links, groups without a public preview and user profiles are skipped (and never charged).

Typical uses: news and crypto monitoring, brand and competitor tracking, OSINT and research datasets, trend analysis, feeding alerts and AI pipelines through webhooks.

> Not affiliated with, endorsed by or sponsored by Telegram. See [Legal](#legal-and-responsible-use).

## What you can do

### Scrape public Telegram channel messages
Give it channel usernames or links (hundreds per run). You get the newest `maxMessages` per channel, or the whole archive.

### Backfill a date range
Set `dateFrom` / `dateTo` (`2026-09-01`, ISO timestamps, or `7 days`). The Actor jumps straight to the end of the window with a binary search (a handful of requests) instead of walking from today, so old ranges of huge channels stay cheap.

### Monitor channels with incremental runs
Turn on `incremental` and schedule the Actor. It stores the last message id seen for every channel in a **named key-value store** and each run returns only newer messages, oldest first. If more new messages are waiting than `maxMessages`, the next run continues exactly where the previous one stopped, with no gaps and no duplicates.

### Filter by keyword or regex
`includeKeywords`, `excludeKeywords`, `includeRegex`, `excludeRegex` are applied while paginating, and you only pay for the messages that pass.

## Input

| Field | Type | Description |
| --- | --- | --- |
| `channels` | string list | Usernames or links: `telegram`, `@durov`, `https://t.me/bbcrussian`, `https://t.me/s/contest`. Required. |
| `maxMessages` | integer | Max messages per channel, newest first (default 100). Free plan: 10. |
| `dateFrom`, `dateTo` | string | Date window. `2026-09-01`, ISO timestamp, or relative (`7 days`, `2 weeks`). A date without time means the whole day in UTC. |
| `incremental` | boolean | Return only messages newer than the last run (state kept per channel). |
| `stateStoreName` | string | Named key-value store for the incremental pointers (default `telegram-channel-scraper-state`). Use one name per monitoring job. |
| `includeKeywords` / `excludeKeywords` | string list | Case-insensitive words or phrases. Exclusion wins. |
| `includeRegex` / `excludeRegex` | string | JavaScript regular expressions (case-insensitive). |
| `extractLinks` | boolean | Add `links`, `mentions`, `hashtags` (default on). |
| `includeHtml` | boolean | Keep formatted HTML next to plain text (default on). |
| `includeServiceMessages` | boolean | Also return "pinned a message" style system messages (default off). |
| `maxConcurrency` | integer | Channels scraped in parallel (default 5). |
| `maxPagesPerChannel` | integer | Safety cap on pages (20 messages each) when filters match rarely (default 1000). |
| `proxyConfiguration` | object | Optional. Not needed in normal use; if enabled the Actor rotates the proxy session after a rate limit. |

## Output

One dataset row per message. Real example (trimmed image URL), from `t.me/durov`:

```json
{
  "channel": "durov",
  "channelTitle": "Pavel Durov",
  "channelSubscribers": 10400000,
  "messageId": 525,
  "url": "https://t.me/durov/525",
  "date": "2026-06-12T19:15:19.000Z",
  "text": "🔄 Telegram’s new update is out. Lots of great new features.\n\n😂 But most importantly: the announcement is actually fun to read.",
  "views": 16500000,
  "reactions": [
    { "emoji": "⭐", "count": 4450, "paid": true },
    { "emoji": null, "count": 20000, "customEmojiId": "5265077361648368841" }
  ],
  "reactionsTotal": 40098,
  "forwardedFrom": null,
  "replyTo": null,
  "author": "Pavel Durov",
  "edited": false,
  "linkPreview": {
    "url": "https://telegram.org/blog/watch-apps-and-more",
    "siteName": "Telegram",
    "title": "Smartwatch Apps, Rich Text for Bots, AI Guardians for Groups, and Much More",
    "description": "Today’s update brings Telegram to Apple Watch and Android smartwatches, adds filthy rich text for bots, ...",
    "imageUrl": "https://cdn4.telesco.pe/file/..."
  },
  "media": [],
  "mediaTypes": [],
  "poll": null,
  "links": ["https://telegram.org/blog/watch-apps-and-more"],
  "mentions": [],
  "hashtags": [],
  "html": "🔄 Telegram’s <a href=\"https://telegram.org/blog/watch-apps-and-more\">new update</a> is out. ...",
  "scrapedAt": "2026-10-14T01:49:51.269Z"
}
```

Other fields you will see depending on the message:

- `forwardedFrom`: `{ name, url, author }` for forwarded posts.
- `replyTo`: `{ messageId, url, author, text }` for replies.
- `media`: list of `{ type, url, thumbnailUrl, duration, ... }` with `type` of `photo`, `video`, `round_video`, `voice`, `audio`, `document`, `sticker` or `location`. Media is **never downloaded**; URLs are Telegram CDN links, and video/voice links are signed and expire after a while.
- `poll`: `{ question, type, options: [{ text, percent }], voters }` when the poll is visible.
- `buttons`: inline buttons under the post, `{ text, url }`.
- `reactions[].customEmojiId` appears when the reaction is a custom (premium) emoji whose character the public preview does not expose; `paid: true` marks Telegram Stars reactions.

A per-channel **run summary** (status, messages, pages read, incremental pointers) is saved in the `SUMMARY` record of the run's key-value store.

## Pricing

Pay per message returned. You are never charged for channels that fail, are private, do not exist or return nothing, and not for the Actor start.

| Apify plan | Price per 1,000 messages |
| --- | --- |
| Free / Bronze | $1.00 |
| Silver | $0.80 |
| Gold and above | $0.50 |

Billing is per `message` event: USD 0.001 / 0.0008 / 0.0005 per message returned.

The Actor respects the maximum cost per run you set: it stops cleanly when the next message would exceed it.

**Free plan limits:** up to 10 messages per channel and 10 channels per run, so you can test the output on real channels. Paid plans have no cap.

**Speed and platform cost.** In our tests from a datacenter IP (GitHub runner) the Actor read 2,426 messages from 3 channels in 19 seconds with 128 requests, no rate limiting and no retries (1,000 messages from a single channel take roughly 15 to 20 seconds). Telegram's preview returned 20 messages per page of about 130 KB. A small run on Apify (30 messages, 3 channels, 2 GB) used USD 0.0006 of platform usage, which extrapolates to about USD 0.02 per 1,000 messages including start-up overhead (extrapolated from a small run; large runs are cheaper per message).

## FAQ

**Does it work for private channels or groups?** No. Only channels that have a public web preview at `t.me/s/<name>` work. Anything else is reported in the summary as `not_found`, `preview_disabled`, `not_a_channel`, `restricted` or invalid, and costs nothing.

**How far back can it go?** To the first message of the channel. The preview exposes the full history; the Actor pages backwards with `?before=<id>`.

**Does incremental mode lose messages if a run fails?** No. The pointer is saved only after a channel was read successfully, and when a run is cut short by `maxMessages` or by your maximum cost, it continues from the last message it actually returned.

**Where is the incremental state stored, and how do I reset it?** In the named key-value store `telegram-channel-scraper-state` (or the name you set in `stateStoreName`), one record per channel (`last_<username>`). Delete a record, or use a new store name, to start over from the latest messages.

**What about deleted or edited messages?** Deleted messages are not shown by Telegram. Edited messages carry `edited: true` and show their current text.

**Why is a reaction emoji `null`?** Custom emoji reactions are rendered by Telegram as animated stickers without a character; we return their `customEmojiId` and count.

**Which channels were used to test it?** Large public channels such as `telegram`, `durov`, `contest`, `tginfo`, `bbcrussian`, `rian_ru` and `tass_agency`, including full-archive walks.

**It says 429 or rate limited.** The Actor backs off automatically (honouring `Retry-After`) and slows every worker down. If it keeps happening, lower `maxConcurrency` or enable the proxy option.

**Can I get the messages of a group or the comments of a post?** No, this Actor only reads channel posts.

## Limitations

- Public channels only; no login, no private content, no phone-number lookups, no user profile scraping beyond what a public post shows (author signature, forwarded-from name).
- Channels that disabled the web preview, or that Telegram restricts for age or copyright reasons, return nothing.
- View, reaction and poll numbers are the values shown at scraping time and change later.
- Telegram may change its preview markup; the parser is covered by tests on real saved pages and the Actor is smoke-tested daily.

## Legal and responsible use

This Actor is **not affiliated with, endorsed by or sponsored by Telegram**. It reads only information that Telegram publishes openly on public web pages, without logging in. Messages can contain personal data. **You are responsible for using the data lawfully**, including GDPR and similar privacy laws, copyright, and Telegram's terms. Do not use it to harass, profile private individuals or collect data you have no lawful basis to process.

## More Actors by this developer

- [Florida Sunbiz Business Search & Annual Report Checker](https://apify.com/lautarodelgado/florida-sunbiz-scraper)

## En español

**Telegram Channel Scraper & Monitor** lee la vista previa web pública de los canales de Telegram (`t.me/s/<canal>`) y devuelve cada mensaje como dato estructurado: texto, HTML, fecha, vistas, reacciones, reenvíos, respuestas, encuestas, enlaces, hashtags, menciones y metadatos de multimedia (sin descargar archivos).

- **Solo canales públicos.** No hace falta cuenta, teléfono ni API de Telegram. Los canales privados, enlaces de invitación y canales sin vista previa se omiten y no se cobran.
- **Historial completo** hasta el primer mensaje, **rango de fechas** (`dateFrom` / `dateTo`) y **modo incremental** para monitorear: en cada ejecución programada devuelve solo los mensajes nuevos, guardando el último id por canal en un almacén con nombre.
- **Filtros** por palabras clave y expresiones regulares, y hasta cientos de canales por ejecución.
- **Precio:** USD 1,00 por cada 1.000 mensajes (Silver 0,80, Gold o superior 0,50). Plan gratis: 10 mensajes por canal y 10 canales por ejecución.
- **Aviso legal:** no está afiliado a Telegram ni cuenta con su respaldo. Los mensajes pueden contener datos personales; el usuario es responsable de usarlos conforme a la ley (por ejemplo GDPR y la ley argentina de protección de datos personales).
