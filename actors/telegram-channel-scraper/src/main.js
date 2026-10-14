import { Actor, log } from 'apify';
import { normalizeChannel, buildFilter } from './telegram.js';
import { scrapeChannel } from './scraper.js';
import { TelegramFetcher } from './http.js';
import { parseDateInput } from './dates.js';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    channels = [],
    maxMessages = 100,
    dateFrom,
    dateTo,
    incremental = false,
    stateStoreName = 'telegram-channel-scraper-state',
    includeKeywords = [],
    excludeKeywords = [],
    includeRegex,
    excludeRegex,
    extractLinks = true,
    includeHtml = true,
    includeServiceMessages = false,
    maxConcurrency = 5,
    maxPagesPerChannel = 1000,
    proxyConfiguration,
} = input;

const isPaying = process.env.APIFY_USER_IS_PAYING === '1' || !process.env.APIFY_IS_AT_HOME;
// Free plan on the platform: 10 messages per channel and 10 channels per run (see README). Local runs are not capped.
const FREE_MAX_MESSAGES = 10;
const FREE_MAX_CHANNELS = 10;
const capped = !isPaying;

// ---- validate input ----------------------------------------------------------------------------------------------
const fail = async (msg) => { log.error(msg); await Actor.fail(msg); };

const rawChannels = (Array.isArray(channels) ? channels : String(channels).split(/[\s,]+/)).map((c) => (typeof c === 'object' && c ? c.url ?? c.username ?? '' : c));
const accepted = []; const rejected = [];
const seenNames = new Set();
for (const raw of rawChannels) {
    if (!String(raw ?? '').trim()) continue;
    const n = normalizeChannel(raw);
    if (n.error) { rejected.push({ input: String(raw), status: n.error }); continue; }
    if (seenNames.has(n.username.toLowerCase())) continue;
    seenNames.add(n.username.toLowerCase());
    accepted.push(n.username);
}
if (!accepted.length && !rejected.length) {
    await fail('Input "channels" must contain at least one public channel username or t.me link, for example "telegram" or "https://t.me/durov".');
}

let from; let to;
try {
    from = parseDateInput(dateFrom, 'start');
    to = parseDateInput(dateTo, 'end');
} catch (e) {
    await fail(e.message);
}
if (from != null && to != null && from > to) await fail('"dateFrom" must not be later than "dateTo".');

let filter;
try {
    filter = buildFilter({ includeKeywords, excludeKeywords, includeRegex, excludeRegex });
} catch (e) {
    await fail(`Invalid regular expression: ${e.message}`);
}

let toScrape = accepted;
if (capped && accepted.length > FREE_MAX_CHANNELS) {
    log.warning(`Free plan: only the first ${FREE_MAX_CHANNELS} channels are scraped per run (${accepted.length - FREE_MAX_CHANNELS} skipped). Upgrade to remove this limit.`);
    toScrape = accepted.slice(0, FREE_MAX_CHANNELS);
}
const perChannelMax = capped ? Math.min(maxMessages, FREE_MAX_MESSAGES) : maxMessages;
if (capped && maxMessages > FREE_MAX_MESSAGES) {
    log.warning(`Free plan: results are capped at ${FREE_MAX_MESSAGES} messages per channel (requested ${maxMessages}). Upgrade to remove this limit.`);
}

const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration(proxyConfiguration) : undefined;
const isPayPerEvent = Actor.getChargingManager().getPricingInfo().isPayPerEvent;
const fetcher = new TelegramFetcher({ proxyConfiguration: proxyConf, log: (m) => log.warning(m) });
const stateStore = incremental ? await Actor.openKeyValueStore(stateStoreName) : null;
const stateKey = (u) => `last_${u.toLowerCase()}`;

// ---- output ------------------------------------------------------------------------------------------------------
let chargeLimitReached = false;
let pushed = 0;

async function emit(item) {
    if (chargeLimitReached) return false;
    if (isPayPerEvent) {
        const r = await Actor.charge({ eventName: 'message' });
        if (r.chargedCount === 0) {
            chargeLimitReached = true;
            log.warning('Reached the maximum charge for this run. Stopping; raise the limit to get more messages.');
            return false;
        }
        if (r.eventChargeLimitReached) {
            chargeLimitReached = true;
            log.warning('Next message would exceed the charge limit; this is the last one.');
        }
    }
    await Actor.pushData(item);
    pushed += 1;
    return true;
}

const scrapedAt = () => new Date().toISOString();
function decorate(m, info) {
    const {
        html, links, mentions, hashtags, ...rest
    } = m;
    const out = {
        channel: rest.channel,
        channelTitle: info?.title ?? null,
        channelSubscribers: info?.subscribers ?? null,
        ...rest,
    };
    if (includeHtml) out.html = html;
    if (extractLinks) { out.links = links; out.mentions = mentions; out.hashtags = hashtags; }
    out.scrapedAt = scrapedAt();
    return out;
}

// ---- run ---------------------------------------------------------------------------------------------------------
const summary = [];
for (const r of rejected) {
    summary.push(r);
    log.warning(`Skipped "${r.input}": ${r.status === 'private_invite' ? 'private invite links are not supported (public channels only)' : r.status === 'private_channel' ? 'private channel links are not supported (public channels only)' : 'not a valid public channel username'}.`);
}

async function runChannel(username) {
    const t0 = Date.now();
    try {
        let lastId = null;
        if (incremental) {
            const st = await stateStore.getValue(stateKey(username));
            lastId = st?.lastId ?? null;
        }
        const res = await scrapeChannel({
            username,
            fetcher,
            opt: {
                maxMessages: perChannelMax, maxPages: maxPagesPerChannel, dateFrom: from, dateTo: to, incremental, lastId, filter, includeService: includeServiceMessages, decorate,
            },
            sink: { emit },
        });
        if (incremental && res.nextLastId != null && ['ok', 'empty'].includes(res.status) && res.nextLastId !== lastId) {
            await stateStore.setValue(stateKey(username), { lastId: res.nextLastId, updatedAt: scrapedAt() });
        }
        const line = { input: username, username, status: res.status, messages: res.emitted, pages: res.pages, scanned: res.scanned, seconds: Math.round((Date.now() - t0) / 100) / 10 };
        if (res.truncated) line.note = `Stopped at maxPagesPerChannel (${maxPagesPerChannel}).`;
        if (res.carryOver) line.note = 'More new messages are waiting; the next incremental run continues from here.';
        if (res.detail) line.detail = res.detail;
        if (incremental) { line.previousLastId = lastId; line.lastId = res.nextLastId; }
        summary.push(line);
        const human = {
            ok: `${res.emitted} messages (${res.pages} pages)`,
            empty: 'no messages found',
            restricted: 'content restricted by Telegram (age or copyright), nothing returned',
            preview_disabled: 'channel exists but its public web preview is disabled, nothing returned',
            not_a_channel: 'username belongs to a user or bot, not a public channel, nothing returned',
            not_found: 'channel does not exist or has no public preview, nothing returned',
            unavailable: 'no public preview available, nothing returned',
        }[res.status] ?? res.status;
        (res.status === 'ok' ? log.info : log.warning).call(log, `@${username}: ${human}`);
    } catch (e) {
        summary.push({ input: username, username, status: 'failed', messages: 0, error: String(e.message ?? e) });
        log.error(`@${username}: failed (${e.message}). Nothing was charged for this channel's failed pages.`);
    }
}

let next = 0;
const workers = Array.from({ length: Math.max(1, Math.min(maxConcurrency, 20, toScrape.length)) }, async () => {
    while (!chargeLimitReached) {
        const i = next; next += 1;
        if (i >= toScrape.length) return;
        await runChannel(toScrape[i]);
        await Actor.setStatusMessage(`${summary.length}/${toScrape.length + rejected.length} channels done, ${pushed} messages`);
    }
});
await Promise.all(workers);

log.info(`Done: ${pushed} messages from ${summary.filter((s) => s.status === 'ok').length} channels. Requests: ${fetcher.stats.requests}, retries: ${fetcher.stats.retries}, rate-limited: ${fetcher.stats.rateLimited}, ${(fetcher.stats.bytes / 1e6).toFixed(1)} MB.`);
await Actor.setValue('SUMMARY', { generatedAt: scrapedAt(), incremental, messages: pushed, channels: summary, fetcher: fetcher.stats });

const failed = summary.filter((s) => s.status === 'failed');
const readable = summary.filter((s) => ['ok', 'empty'].includes(s.status));
if (failed.length && !readable.length) {
    await Actor.fail(`Telegram did not serve any of the requested channels (${failed.length} failed after retries). Nothing was charged. Try again later or enable a proxy. Details in the SUMMARY record.`);
} else {
    const parts = [`${pushed} messages from ${summary.filter((s) => s.status === 'ok').length} channels`];
    const bad = summary.filter((s) => !['ok', 'empty'].includes(s.status)).length;
    if (bad) parts.push(`${bad} channel(s) unavailable (see SUMMARY)`);
    if (capped) parts.push('free plan limits applied');
    await Actor.exit({ statusMessage: parts.join('; ') });
}
