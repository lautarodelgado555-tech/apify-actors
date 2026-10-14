// Parsers and helpers for the public Telegram web preview (https://t.me/s/<channel>).
// Everything here is pure (no network) so it can be unit-tested against real pages saved as fixtures.
import * as cheerio from 'cheerio';

export const BASE = 'https://t.me';

// ---------------------------------------------------------------- usernames

const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;

/**
 * Turn whatever the user typed (@name, name, t.me/name, https://t.me/s/name?before=5, https://t.me/name/123)
 * into { username } or { error }. Private invite links are rejected: only public channels are supported.
 */
export function normalizeChannel(raw) {
    let s = String(raw ?? '').trim();
    if (!s) return { error: 'empty' };
    s = s.replace(/^@/, '');
    if (/^tg:\/\/resolve\?domain=/i.test(s)) s = s.replace(/^tg:\/\/resolve\?domain=/i, '').split('&')[0];
    const m = s.match(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\/(.+)$/i);
    if (m) {
        let path = m[1].split(/[?#]/)[0].replace(/\/+$/, '');
        const parts = path.split('/');
        if (parts[0] === 's') parts.shift();
        const first = parts[0] ?? '';
        if (first.startsWith('+') || first.toLowerCase() === 'joinchat') return { error: 'private_invite', input: raw };
        if (first.toLowerCase() === 'c') return { error: 'private_channel', input: raw };
        s = first;
    }
    if (USERNAME_RE.test(s)) return { username: s };
    return { error: 'invalid_username', input: raw };
}

// ---------------------------------------------------------------- small helpers

/** "1.86M" -> 1860000, "37.2K" -> 37200, "1 234" -> 1234, "" -> null */
export function parseCount(text) {
    if (text == null) return null;
    const t = String(text).replace(/ |\s/g, '').replace(/,/g, '.').trim();
    const m = t.match(/^([\d.]+)([KkMmBb]?)$/);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (Number.isNaN(n)) return null;
    const mult = { '': 1, k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()];
    return Math.round(n * mult);
}

const bgUrl = (style) => {
    const m = String(style ?? '').match(/url\((['"]?)(.*?)\1\)/);
    if (!m) return null;
    const u = m[2].replace(/&amp;/g, '&');
    if (u.startsWith('data:')) return null;
    return u.startsWith('//') ? `https:${u}` : u;
};

const abs = (u) => {
    if (!u) return null;
    if (u.startsWith('//')) return `https:${u}`;
    if (u.startsWith('/')) return `${BASE}${u}`;
    return u;
};

const clean = (s) => String(s ?? '').replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/** Replace emoji wrappers with the emoji character and drop onclick noise; returns { text, html, $el } for a text element. */
function readRichText($, el) {
    const c = $(el).clone();
    c.find('tg-emoji, i.emoji').each((_, e) => {
        const ch = $(e).find('b').first().text() || $(e).text();
        $(e).replaceWith(ch);
    });
    c.find('[onclick]').removeAttr('onclick');
    c.find('a').removeAttr('target').removeAttr('rel');
    const html = (c.html() ?? '').trim();
    const t = $.load(`<div id="r">${html}</div>`, null, false);
    t('br').replaceWith('\n');
    t('blockquote, pre').each((_, e) => { t(e).append('\n'); });
    const text = clean(t('#r').text());
    return { text, html, c };
}

// ---------------------------------------------------------------- message parts

function parseReactions($, wrap) {
    const out = [];
    wrap.find('.tgme_widget_message_reactions .tgme_reaction').each((_, el) => {
        const r = $(el);
        const paid = r.hasClass('tgme_reaction_paid');
        const customId = r.find('tg-emoji').attr('emoji-id') ?? null;
        const emojiChar = r.find('i.emoji b, tg-emoji b').first().text() || null;
        const c = r.clone();
        c.find('tg-emoji, i').remove();
        const count = parseCount(c.text());
        const entry = { emoji: paid ? '⭐' : emojiChar, count };
        if (paid) entry.paid = true;
        if (!emojiChar && customId) entry.customEmojiId = customId;
        out.push(entry);
    });
    return out;
}

function parsePoll($, wrap) {
    const p = wrap.find('.tgme_widget_message_poll').first();
    if (!p.length) return null;
    const options = [];
    p.find('.tgme_widget_message_poll_option').each((_, el) => {
        const o = $(el);
        const percentText = o.find('.tgme_widget_message_poll_option_percent').first().text().trim();
        const text = o.find('.tgme_widget_message_poll_option_text').first().text().trim();
        const pct = parseFloat(percentText.replace('%', ''));
        options.push({ text, percent: Number.isNaN(pct) ? null : pct });
    });
    const votersText = wrap.find('.tgme_widget_message_voters').first().text().trim();
    return {
        question: p.find('.tgme_widget_message_poll_question').first().text().trim() || null,
        type: p.find('.tgme_widget_message_poll_type').first().text().trim() || null,
        options,
        votersText: votersText || null,
        voters: parseCount(votersText),
    };
}

function parseMedia($, wrap) {
    const media = [];
    wrap.find('.tgme_widget_message_photo_wrap').each((_, el) => {
        const a = $(el);
        media.push({ type: 'photo', url: bgUrl(a.attr('style')), messageUrl: abs(a.attr('href')) });
    });
    wrap.find('.tgme_widget_message_video_player').each((_, el) => {
        const a = $(el);
        media.push({
            type: 'video',
            url: a.find('video').attr('src') ?? null,
            thumbnailUrl: bgUrl(a.find('.tgme_widget_message_video_thumb').attr('style')),
            duration: a.find('.message_video_duration').first().text().trim() || null,
            messageUrl: abs(a.attr('href')),
        });
    });
    wrap.find('.tgme_widget_message_roundvideo_player').each((_, el) => {
        const a = $(el);
        media.push({
            type: 'round_video',
            url: a.find('video').attr('src') ?? null,
            thumbnailUrl: bgUrl(a.find('.tgme_widget_message_roundvideo_thumb').attr('style')),
            duration: a.find('.tgme_widget_message_roundvideo_duration').first().text().trim() || null,
            messageUrl: null,
        });
    });
    wrap.find('audio.tgme_widget_message_voice, .tgme_widget_message_voice').each((_, el) => {
        const v = $(el);
        if (el.tagName !== 'audio' && v.closest('audio').length) return;
        const box = v.closest('.tgme_widget_message_voice_player').length ? v.closest('.tgme_widget_message_voice_player') : v.parent();
        media.push({ type: 'voice', url: v.attr('src') ?? null, duration: box.find('.tgme_widget_message_voice_duration').first().text().trim() || null });
    });
    wrap.find('.tgme_widget_message_document_wrap').each((_, el) => {
        const d = $(el);
        media.push({
            type: d.find('.tgme_widget_message_document_icon.audio').length ? 'audio' : 'document',
            title: d.find('.tgme_widget_message_document_title').first().text().trim() || null,
            extra: d.find('.tgme_widget_message_document_extra').first().text().trim() || null,
            messageUrl: abs(d.attr('href')),
        });
    });
    wrap.find('.tgme_widget_message_sticker_wrap, .tgme_widget_message_videosticker_wrap').each((_, el) => {
        const s = $(el);
        media.push({ type: 'sticker', thumbnailUrl: bgUrl(s.find('.tgme_widget_message_sticker').attr('style')) });
    });
    wrap.find('.tgme_widget_message_location_wrap').each((_, el) => {
        media.push({ type: 'location', url: abs($(el).attr('href')) });
    });
    if (wrap.find('.tgme_widget_message_contact').length) media.push({ type: 'contact' });
    return media;
}

function parseLinkPreview($, wrap) {
    const a = wrap.find('a.tgme_widget_message_link_preview').first();
    if (!a.length) return null;
    return {
        url: a.attr('href') ?? null,
        siteName: a.find('.link_preview_site_name').first().text().trim() || null,
        title: a.find('.link_preview_title').first().text().trim() || null,
        description: clean(readRichText($, a.find('.link_preview_description').first()).text) || null,
        imageUrl: bgUrl(a.find('.link_preview_image, .link_preview_right_image').first().attr('style')),
    };
}

function parseReply($, wrap) {
    const a = wrap.find('a.tgme_widget_message_reply').first();
    if (!a.length) return null;
    const href = a.attr('href') ?? '';
    const id = Number((href.match(/\/(\d+)(?:[?#].*)?$/) || [])[1]);
    return {
        messageId: Number.isFinite(id) ? id : null,
        url: href || null,
        author: a.find('.tgme_widget_message_author_name').first().text().trim() || null,
        text: clean(readRichText($, a.find('.js-message_reply_text').first()).text) || null,
    };
}

function parseForwarded($, wrap) {
    const f = wrap.find('.tgme_widget_message_forwarded_from').first();
    if (!f.length) return null;
    const nameEl = f.find('.tgme_widget_message_forwarded_from_name').first();
    const name = (nameEl.length ? nameEl.text() : f.text().replace(/^\s*Forwarded from/i, '')).replace(/ /g, ' ').trim();
    const author = f.find('.tgme_widget_message_forwarded_from_author').first().text().trim() || null;
    return { name: name || null, url: nameEl.attr('href') ?? null, author };
}

function parseButtons($, wrap) {
    const out = [];
    wrap.find('.tgme_widget_message_inline_button').each((_, el) => {
        const b = $(el);
        out.push({ text: b.text().replace(/\s+/g, ' ').trim(), url: b.attr('href') ?? null });
    });
    return out;
}

/** Links, @mentions and #hashtags found in the rich text (anchors first, plain-text regex as a fallback). */
export function extractEntities(html, text) {
    const $ = cheerio.load(`<div>${html ?? ''}</div>`, null, false);
    const links = []; const mentions = []; const hashtags = [];
    const push = (arr, v) => { if (v && !arr.includes(v)) arr.push(v); };
    $('a').each((_, a) => {
        const href = $(a).attr('href') ?? '';
        const t = $(a).text().trim();
        if (/^#/.test(t) || /[?&]q=%23/.test(href)) { push(hashtags, t.startsWith('#') ? t : decodeURIComponent(href.split('q=')[1] ?? '')); return; }
        if (/^@[A-Za-z0-9_]{3,}$/.test(t)) { push(mentions, t); return; }
        if (/^https?:\/\//i.test(href)) push(links, href);
    });
    const plain = text ?? '';
    for (const m of plain.matchAll(/(^|[\s(])#([\p{L}\p{N}_]{2,64})/gu)) push(hashtags, `#${m[2]}`);
    for (const m of plain.matchAll(/(^|[\s(])@([A-Za-z][A-Za-z0-9_]{3,31})\b/g)) push(mentions, `@${m[2]}`);
    return { links, mentions, hashtags };
}

// ---------------------------------------------------------------- one page

/**
 * Parse one /s/<channel> page into { channel, messages, restricted }.
 * messages are in page order (ascending id). `restricted` is true when Telegram refuses to show the content (age / copyright restriction).
 */
export function parsePage(html) {
    const $ = cheerio.load(html);
    $('svg').remove();
    const info = parseChannelInfo($);
    const messages = [];
    $('.tgme_widget_message_wrap').each((_, el) => {
        const wrap = $(el);
        const msgEl = wrap.find('.tgme_widget_message[data-post]').first();
        const post = msgEl.attr('data-post');
        if (!post) return;
        const [channel, idStr] = post.split('/');
        const messageId = Number(idStr);
        if (!channel || !Number.isFinite(messageId)) return;

        const textEl = wrap.find('.tgme_widget_message_text.js-message_text, .js-message_text').first();
        const rich = textEl.length ? readRichText($, textEl) : { text: '', html: '' };
        const meta = wrap.find('.tgme_widget_message_meta').first();
        const timeEl = wrap.find('.tgme_widget_message_date time').first();
        const dateRaw = timeEl.attr('datetime');
        const dt = dateRaw ? new Date(dateRaw) : null;
        const date = dt && !Number.isNaN(dt.getTime()) ? dt.toISOString() : null;
        const poll = parsePoll($, wrap);
        const media = parseMedia($, wrap);
        const ent = extractEntities(rich.html, rich.text);
        const linkPreview = parseLinkPreview($, wrap);
        const reactions = parseReactions($, wrap);
        const buttons = parseButtons($, wrap);
        const views = parseCount(wrap.find('.tgme_widget_message_views').first().text());
        const forwardedFrom = parseForwarded($, wrap);
        const msg = {
            channel,
            messageId,
            url: `${BASE}/${channel}/${messageId}`,
            date,
            text: rich.text || null,
            html: rich.html || null,
            views,
            reactions,
            reactionsTotal: reactions.reduce((a, r) => a + (r.count ?? 0), 0),
            forwardedFrom,
            replyTo: parseReply($, wrap),
            author: wrap.find('.tgme_widget_message_from_author').first().text().trim() || null,
            viaBot: wrap.find('.tgme_widget_message_via_bot').first().text().replace(/^\s*via\s+/i, '').trim() || null,
            isService: msgEl.hasClass('service_message'),
            edited: /\bedited\b/i.test(meta.clone().find('a, time').remove().end().text()) || wrap.find('.tgme_widget_message_edited').length > 0,
            linkPreview,
            media,
            mediaTypes: [...new Set(media.map((m) => m.type))],
            poll,
            buttons: buttons.length ? buttons : undefined,
            links: ent.links,
            mentions: ent.mentions,
            hashtags: ent.hashtags,
        };
        messages.push(msg);
    });
    const moreEl = $('a.tme_messages_more[data-before]').first();
    const moreBefore = moreEl.length ? Number(moreEl.attr('data-before')) : null;
    const restricted = !messages.length && /can.t be displayed|violat|sensitive|restricted|age[- ]restrict/i.test($('body').text());
    return { channel: info, messages, restricted, moreBefore: Number.isFinite(moreBefore) ? moreBefore : null };
}

export function parseChannelInfo($) {
    const box = $('.tgme_channel_info').first();
    if (!box.length) return null;
    const counters = {};
    box.find('.tgme_channel_info_counter').each((_, el) => {
        const type = $(el).find('.counter_type').text().trim().toLowerCase();
        counters[type] = parseCount($(el).find('.counter_value').text());
    });
    const username = box.find('.tgme_channel_info_header_username a').first().text().trim().replace(/^@/, '') || null;
    return {
        username,
        title: box.find('.tgme_channel_info_header_title').first().text().trim() || null,
        verified: box.find('.verified-icon').length > 0,
        subscribers: counters.subscribers ?? counters.subscriber ?? counters.members ?? null,
        description: clean(readRichText($, box.find('.tgme_channel_info_description').first()).text) || null,
        photoUrl: box.find('.tgme_page_photo_image img').attr('src') ?? null,
    };
}

/** Classify the public profile page (https://t.me/<name>) of a username whose /s/ preview redirected. */
export function classifyProfile(html) {
    const $ = cheerio.load(html);
    const extra = $('.tgme_page_extra').first().text().trim();
    const title = $('.tgme_page_title').first().text().trim();
    if (/subscribers|members/i.test(extra)) {
        // A "Preview channel" link means the preview exists, so a redirect was transient: report as unavailable, not as disabled.
        return { kind: $('.tgme_page_context_link').length ? 'unavailable' : 'preview_disabled', title, extra };
    }
    if (/^@/.test(extra)) return { kind: 'not_a_channel', title, extra };
    return { kind: 'not_found', title, extra };
}

// ---------------------------------------------------------------- filters

export function buildFilter({ includeKeywords = [], excludeKeywords = [], includeRegex, excludeRegex, caseSensitive = false } = {}) {
    const flags = caseSensitive ? 'u' : 'iu';
    const kw = (list) => list.map((k) => String(k).trim()).filter(Boolean).map((k) => (caseSensitive ? k : k.toLowerCase()));
    const inc = kw(includeKeywords); const exc = kw(excludeKeywords);
    const incRe = includeRegex ? new RegExp(includeRegex, flags) : null;
    const excRe = excludeRegex ? new RegExp(excludeRegex, flags) : null;
    const active = inc.length || exc.length || incRe || excRe;
    return {
        active: Boolean(active),
        test(msg) {
            const hay = [msg.text, msg.linkPreview?.title, msg.linkPreview?.description, msg.poll?.question].filter(Boolean).join('\n');
            const h = caseSensitive ? hay : hay.toLowerCase();
            if (exc.some((k) => h.includes(k))) return false;
            if (excRe && excRe.test(hay)) return false;
            if (inc.length || incRe) {
                const okKw = inc.length ? inc.some((k) => h.includes(k)) : false;
                const okRe = incRe ? incRe.test(hay) : false;
                return okKw || okRe;
            }
            return true;
        },
    };
}
