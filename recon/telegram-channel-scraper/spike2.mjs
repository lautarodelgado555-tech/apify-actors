// Spike 2: scan more archive pages for rare message features (poll, edited, voice, location, ...) and save one real example of each.
import fs from 'node:fs';
import * as cheerio from 'cheerio';
const OUT = new URL('./out2/', import.meta.url).pathname;
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const channels = ['telegram', 'durov', 'tginfo', 'contest', 'BotNews', 'rian_ru', 'bbcrussian', 'meduzalive', 'breakingmash', 'nexta_live', 'whale_alert_io',
    'binance_announcements', 'cointelegraph', 'tass_agency', 'ntvnews', 'lentachold', 'mash', 'bloomberg', 'nytimes', 'verge', 'bitcoin', 'spacex', 'elonmusk', 'euronews',
    'cryptonews', 'forklog', 'rbc_news', 'rt_en', 'svtvnews', 'vestiisrael', 'bbcarabic', 'alarabiya', 'espn', 'goal', 'fcbarcelona', 'realmadrid', 'tonkeeper', 'notcoin', 'hamster_kombat', 'blum', 'dogs_community', 'cryptoquant', 'binancekillers', 'wallstreetbets', 'investingcom', 'tradingview'];
const classes = ['tgme_widget_message_poll', 'tgme_widget_message_edited', 'tgme_widget_message_voice', 'tgme_widget_message_roundvideo', 'tgme_widget_message_location', 'tgme_widget_message_contact',
    'tgme_widget_message_sticker', 'tgme_widget_message_document', 'tgme_widget_message_grouped', 'tgme_widget_message_reply', 'tgme_widget_message_link_preview', 'tgme_widget_message_forwarded_from',
    'tgme_widget_message_inline_button', 'tgme_widget_message_reply_markup', 'tgme_widget_message_notext', 'tgme_widget_message_invoice', 'tgme_widget_message_game', 'tgme_widget_message_photo_wrap',
    'tgme_widget_message_service', 'tgme_widget_message_tag', 'tgme_widget_message_via', 'tgme_widget_message_from_author', 'tgme_widget_message_forwarded_from_author', 'js-message_reply_text', 'tgme_widget_message_audio', 'tgme_widget_message_story', 'tgme_widget_message_giveaway', 'tgme_widget_message_channel_post'];
const found = {}; const stats = { pages: 0, messages: 0, bytes: 0, status: {} };
const pickClasses = new Set();
async function get(url) {
    const t0 = Date.now();
    try { const r = await fetch(url, { redirect: 'manual', headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' } }); const text = await r.text(); return { status: r.status, text, ms: Date.now() - t0 }; }
    catch (e) { return { status: 0, text: '', ms: 0 }; }
}
for (const ch of channels) {
    let before = null; let nPages = 0;
    const maxPages = ['telegram', 'durov', 'tginfo', 'contest', 'BotNews'].includes(ch) ? 40 : 8;
    while (nPages < maxPages) {
        const r = await get(`https://t.me/s/${ch}${before ? `?before=${before}` : ''}`);
        stats.status[r.status] = (stats.status[r.status] || 0) + 1;
        if (r.status !== 200) break;
        const $ = cheerio.load(r.text);
        $('svg').remove(); $('i.tgme_widget_message_bubble_tail').remove();
        const wraps = $('.tgme_widget_message_wrap');
        if (!wraps.length) break;
        stats.pages++; nPages++; stats.messages += wraps.length; stats.bytes += r.text.length;
        let min = Infinity;
        wraps.each((i, el) => {
            const w = $(el);
            const post = w.find('.tgme_widget_message').attr('data-post') || '';
            const id = Number(post.split('/')[1]); if (id < min) min = id;
            w.find('[class]').each((j, c) => String($(c).attr('class')).split(/\s+/).forEach((k) => { if (k.startsWith('tgme_widget_message') || k.startsWith('tgme_') || k.startsWith('message_')) pickClasses.add(k); }));
            for (const c of classes) {
                if (!found[c] && w.find('.' + c).length) {
                    found[c] = { channel: ch, post, html: $.html(w).replace(/\n\s*\n/g, '\n').slice(0, 12000) };
                }
            }
        });
        if (!isFinite(min) || min <= 1) break;
        before = min;
        await sleep(300);
    }
    log(ch, 'pages', nPages, 'features so far', Object.keys(found).length);
}
fs.writeFileSync(OUT + 'features.json', JSON.stringify(found, null, 1));
fs.writeFileSync(OUT + 'all-classes.txt', [...pickClasses].sort().join('\n'));
fs.writeFileSync(OUT + 'stats.json', JSON.stringify({ ...stats, featuresFound: Object.keys(found), featuresMissing: classes.filter((c) => !found[c]) }, null, 1));
log('done', JSON.stringify(stats));
