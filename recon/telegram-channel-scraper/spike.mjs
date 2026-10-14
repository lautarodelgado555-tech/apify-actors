// Spike for the Telegram public-preview scraper. Runs on a GitHub runner. Writes out/*.
import fs from 'node:fs';
const OUT = new URL('./out/', import.meta.url).pathname;
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const summary = { startedAt: new Date().toISOString(), channels: {}, pagination: {}, rate: {}, misc: {} };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function get(url, opts = {}) {
    const t0 = Date.now();
    try {
        const res = await fetch(url, { redirect: 'manual', headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', accept: 'text/html,*/*', ...(opts.headers || {}) } });
        const text = await res.text();
        return { status: res.status, ms: Date.now() - t0, bytes: Buffer.byteLength(text), text, location: res.headers.get('location'), retryAfter: res.headers.get('retry-after'), headers: Object.fromEntries(res.headers) };
    } catch (e) {
        return { status: 0, ms: Date.now() - t0, bytes: 0, text: '', error: String(e) };
    }
}
const ids = (html) => [...html.matchAll(/data-post="([^"]+)\/(\d+)"/g)].map((m) => Number(m[2]));
const save = (name, text) => fs.writeFileSync(OUT + name, text.slice(0, 600000));

const candidates = ['telegram', 'durov', 'tginfo', 'contest', 'BotNews', 'rian_ru', 'bbcrussian', 'meduzalive', 'breakingmash', 'nexta_live',
    'whale_alert_io', 'binance_announcements', 'wublockchain12', 'cointelegraph', 'coindesk', 'tass_agency', 'rt_russian', 'ntvnews', 'lentachold',
    'mash', 'bloomberg', 'reuters', 'bbcnews', 'cnn', 'nytimes', 'verge', 'techcrunch', 'hackernews', 'python', 'ethereum', 'bitcoin', 'TheBlockCrypto',
    'trading_view', 'NASA', 'spacex', 'elonmusk', 'ukraine_now', 'dwnews', 'euronews', 'AJENews', 'aljazeeraenglish', 'dw_news'];
const bad = ['nonexistent_zzqq_channel_98765', 'ab', 'a_b_c_', 'x'.repeat(40), 'telegram.org'];
const FEATURES = ['tgme_widget_message_poll', 'tgme_widget_message_forwarded_from', 'tgme_widget_message_reply', 'tgme_widget_message_link_preview', 'tgme_widget_message_photo_wrap',
    'tgme_widget_message_video', 'tgme_widget_message_reactions', 'tgme_widget_message_author', 'tgme_widget_message_edited', 'tgme_widget_message_voice', 'tgme_widget_message_document', 'tgme_widget_message_sticker', 'tgme_widget_message_roundvideo', 'message_media_not_supported', 'tgme_widget_message_location', 'tgme_widget_message_contact', 'tgme_widget_message_grouped'];

const goodChannels = [];
const savedFeature = new Set();
let savedPages = 0;
for (const ch of candidates) {
    const r = await get(`https://t.me/s/${ch}`);
    const n = ids(r.text);
    const feats = FEATURES.filter((f) => r.text.includes(f));
    summary.channels[ch] = { status: r.status, ms: r.ms, bytes: r.bytes, location: r.location, messages: n.length, minId: Math.min(...n), maxId: Math.max(...n), features: feats, title: (r.text.match(/<title>([^<]*)/) || [])[1], isWidget: r.text.includes('tgme_channel_info') };
    log(ch, r.status, r.bytes, n.length, r.location || '');
    if (r.status === 200 && n.length) {
        goodChannels.push(ch);
        const newFeats = feats.filter((f) => !savedFeature.has(f));
        if ((savedPages < 6 || newFeats.length) && savedPages < 16) { save(`page-${ch}.html`, r.text); savedPages++; newFeats.forEach((f) => savedFeature.add(f)); }
    } else {
        save(`nomsg-${ch}.${r.status}.html`, r.text.slice(0, 40000));
    }
    await sleep(700);
}
for (const ch of bad) {
    const r = await get(`https://t.me/s/${ch}`);
    summary.channels[ch] = { status: r.status, bytes: r.bytes, location: r.location, messages: ids(r.text).length, title: (r.text.match(/<title>([^<]*)/) || [])[1] };
    save(`bad-${ch.slice(0, 20)}.${r.status}.html`, r.text.slice(0, 40000));
    log('bad', ch, r.status, r.location || '');
    await sleep(700);
}
for (const u of ['BotFather', 'durov_russia', 'telegrambots']) {
    const r = await get(`https://t.me/s/${u}`);
    summary.channels[u] = { status: r.status, bytes: r.bytes, location: r.location, messages: ids(r.text).length, title: (r.text.match(/<title>([^<]*)/) || [])[1] };
    save(`other-${u}.${r.status}.html`, r.text.slice(0, 40000));
    await sleep(700);
}
summary.goodChannels = goodChannels;

async function paginate(ch, maxPages, delay) {
    let before = null; const seen = new Set(); const rows = [];
    for (let p = 1; p <= maxPages; p++) {
        const r = await get(`https://t.me/s/${ch}${before ? `?before=${before}` : ''}`);
        const n = ids(r.text);
        const newIds = n.filter((i) => !seen.has(i));
        n.forEach((i) => seen.add(i));
        rows.push({ p, status: r.status, ms: r.ms, bytes: r.bytes, n: n.length, new: newIds.length, min: Math.min(...n), max: Math.max(...n), retryAfter: r.retryAfter });
        if (p === 2 && !fs.existsSync(OUT + `before-${ch}.html`)) save(`before-${ch}.html`, r.text);
        if (r.status !== 200 || !n.length) break;
        before = Math.min(...n);
        if (before <= 1) break;
        await sleep(delay);
    }
    return { pages: rows.length, totalMessages: seen.size, lastMin: rows.at(-1)?.min, first: rows[0], rows: rows.filter((_, i) => i < 3 || i % 20 === 0 || i === rows.length - 1) };
}
const p1 = goodChannels[0], p2 = goodChannels[1] || goodChannels[0];
if (p1) summary.pagination[p1] = await paginate(p1, 120, 1200);
if (p2 && p2 !== p1) summary.pagination[p2] = await paginate(p2, 40, 1200);
log('pagination done');

if (p1) {
    const base = summary.channels[p1];
    const r1 = await get(`https://t.me/s/${p1}?after=${base.minId}`);
    summary.misc.after = { status: r1.status, n: ids(r1.text).length, min: Math.min(...ids(r1.text)), max: Math.max(...ids(r1.text)) };
    const r2 = await get(`https://t.me/s/${p1}?q=bitcoin`);
    summary.misc.q = { status: r2.status, n: ids(r2.text).length };
    const r3 = await get(`https://t.me/${p1}/${base.maxId}?embed=1&mode=tme`);
    summary.misc.embed = { status: r3.status, bytes: r3.bytes };
    save(`embed-${p1}.html`, r3.text);
    const r4 = await get(`https://t.me/s/${p1}?before=${base.maxId + 100000}`);
    summary.misc.beforeHuge = { status: r4.status, n: ids(r4.text).length, bytes: r4.bytes };
    const r5 = await get(`https://t.me/${p1}`);
    summary.misc.profilePage = { status: r5.status, bytes: r5.bytes, hasWidgetLink: r5.text.includes('/s/' + p1) };
    save(`profile-${p1}.html`, r5.text.slice(0, 60000));
    summary.misc.headersSample = (await get(`https://t.me/s/${p1}`)).headers;
}

async function burst(ch, count, concurrency) {
    const res = []; const t0 = Date.now(); let stop = false; let i = 0;
    async function worker() {
        while (!stop && i < count) {
            const k = i++;
            const r = await get(`https://t.me/s/${ch}`);
            res.push({ k, status: r.status, ms: r.ms, at: Date.now() - t0, retryAfter: r.retryAfter, bytes: r.bytes });
            if (r.status === 429 || r.status >= 500) { stop = true; }
        }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    const codes = {}; res.forEach((r) => { codes[r.status] = (codes[r.status] || 0) + 1; });
    return { requests: res.length, seconds: (Date.now() - t0) / 1000, codes, firstNon200: res.find((r) => r.status !== 200), avgMs: Math.round(res.reduce((a, r) => a + r.ms, 0) / Math.max(1, res.length)) };
}
const rc = goodChannels[2] || p1;
if (rc) {
    summary.rate.seq = await burst(rc, 150, 1); log('burst seq', JSON.stringify(summary.rate.seq));
    if (summary.rate.seq.firstNon200) {
        for (const wait of [5, 15, 30, 60]) {
            await sleep(wait * 1000);
            const r = await get(`https://t.me/s/${rc}`);
            (summary.rate.recovery ||= []).push({ afterWait: wait, status: r.status, retryAfter: r.retryAfter });
            log('recovery', wait, r.status);
            if (r.status === 200) break;
        }
    } else {
        await sleep(5000);
        summary.rate.conc = await burst(goodChannels[3] || p1, 200, 8); log('burst conc', JSON.stringify(summary.rate.conc));
    }
}
fs.writeFileSync(OUT + 'summary.json', JSON.stringify(summary, null, 2));
log('done');
