import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parsePage, normalizeChannel, parseCount, buildFilter, classifyProfile, extractEntities } from '../src/telegram.js';
import { parseDateInput } from '../src/dates.js';

const fx = (name) => fs.readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
const byId = (page, id) => page.messages.find((m) => m.messageId === id);

test('parseCount handles K / M suffixes and spaces', () => {
    assert.equal(parseCount('1.86M'), 1860000);
    assert.equal(parseCount('37.2K'), 37200);
    assert.equal(parseCount('882K'), 882000);
    assert.equal(parseCount('1 234'), 1234);
    assert.equal(parseCount('12'), 12);
    assert.equal(parseCount(''), null);
    assert.equal(parseCount('abc'), null);
});

test('normalizeChannel accepts usernames and links, rejects private links and junk', () => {
    assert.deepEqual(normalizeChannel('telegram'), { username: 'telegram' });
    assert.deepEqual(normalizeChannel('@durov'), { username: 'durov' });
    assert.deepEqual(normalizeChannel('https://t.me/s/bbcrussian?before=100'), { username: 'bbcrussian' });
    assert.deepEqual(normalizeChannel('t.me/durov/552'), { username: 'durov' });
    assert.deepEqual(normalizeChannel('https://telegram.me/contest'), { username: 'contest' });
    assert.equal(normalizeChannel('https://t.me/+AbCdEfGh123').error, 'private_invite');
    assert.equal(normalizeChannel('https://t.me/joinchat/AAAA').error, 'private_invite');
    assert.equal(normalizeChannel('https://t.me/c/123456/7').error, 'private_channel');
    assert.equal(normalizeChannel('ab').error, 'invalid_username');
    assert.equal(normalizeChannel('1badname').error, 'invalid_username');
    assert.equal(normalizeChannel('has space').error, 'invalid_username');
    assert.equal(normalizeChannel('').error, 'empty');
});

test('durov page: channel info, forwarded message, reactions, video, entities', () => {
    const page = parsePage(fx('channel-durov.html'));
    assert.equal(page.messages.length, 20);
    assert.equal(page.moreBefore, 531);
    assert.equal(page.channel.username, 'durov');
    assert.equal(page.channel.title, 'Pavel Durov');
    assert.equal(page.channel.verified, true);
    assert.ok(page.channel.subscribers > 1_000_000);
    const m = byId(page, 552);
    assert.equal(m.channel, 'durov');
    assert.equal(m.url, 'https://t.me/durov/552');
    assert.equal(m.date, '2026-10-11T14:52:40.000Z');
    assert.deepEqual(m.forwardedFrom, { name: 'Telegram Designers', url: 'https://t.me/designers/266', author: null });
    assert.match(m.text, /^✨ Designers × AI/);
    assert.ok(m.html.includes('<b>Designers × AI'));
    assert.ok(!m.html.includes('onclick'));
    assert.deepEqual(m.mentions, ['@designers']);
    assert.equal(m.views, 792000);
    assert.equal(m.media[0].type, 'video');
    assert.equal(m.media[0].duration, '1:15');
    assert.match(m.media[0].thumbnailUrl, /^https:\/\//);
    assert.ok(m.reactions.length >= 2);
    assert.ok(m.reactions.some((r) => r.paid && r.count > 0));
    assert.ok(m.reactions.every((r) => r.count > 0));
    assert.equal(m.reactionsTotal, m.reactions.reduce((a, r) => a + r.count, 0));
    assert.equal(m.edited, false);
    // message ids ascend inside a page and none are duplicated
    const ids = page.messages.map((x) => x.messageId);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
    assert.equal(new Set(ids).size, ids.length);
});

test('regular emoji reactions come with the emoji character', () => {
    const page = parsePage(fx('channel-tginfo.html'));
    const withReactions = page.messages.filter((m) => m.reactions.some((r) => r.emoji && r.emoji !== '⭐'));
    assert.ok(withReactions.length > 3);
    const r = withReactions[0].reactions.find((x) => x.emoji !== '⭐');
    assert.match(r.emoji, /\p{Extended_Pictographic}/u);
    assert.ok(Number.isInteger(r.count));
});

test('edited flag, link preview and views (contest)', () => {
    const page = parsePage(fx('channel-contest.html'));
    const m = byId(page, 456);
    assert.equal(m.edited, true);
    assert.equal(m.views, 882000);
    assert.equal(m.linkPreview.siteName, 'YouTube');
    assert.equal(m.linkPreview.url, 'https://youtube.com/watch?v=1Yq_5aDdJ24');
    assert.match(m.linkPreview.title, /Pavel Durov/);
    assert.match(m.linkPreview.imageUrl, /^https:\/\//);
    assert.ok(m.links.includes('https://www.youtube.com/watch?v=1Yq_5aDdJ24'));
    const notEdited = page.messages.filter((x) => !x.edited);
    assert.ok(notEdited.length > 0);
});

test('reply with quoted text and document (bbcrussian)', () => {
    const page = parsePage(fx('channel-bbcrussian.html'));
    const reply = byId(page, 100332);
    assert.equal(reply.replyTo.messageId, 100331);
    assert.equal(reply.replyTo.url, 'https://t.me/bbcrussian/100331');
    assert.match(reply.replyTo.text, /Россия нанесла удар по Киеву/);
    assert.match(reply.text, /^Удар по Киеву: двое погибших/);
    assert.ok(!reply.text.includes('Россия нанесла удар по Киеву. Зеленский'), 'reply preview text must not leak into the message text');
    const doc = byId(page, 100317);
    assert.equal(doc.media[0].type, 'audio');
    assert.equal(doc.media[0].title, 'Что будет с «Яндексом»?');
});

test('grouped photos and hashtags in a Russian channel', () => {
    const page = parsePage(fx('channel-rian.html'));
    const album = byId(page, 347930);
    assert.equal(album.media.filter((x) => x.type === 'photo').length, 2);
    assert.ok(album.media.every((x) => x.type !== 'photo' || /^https:\/\//.test(x.url)));
    const tags = parsePage(fx('message-forwarded-author.html')).messages.find((m) => m.messageId === 4005);
    assert.deepEqual(tags.hashtags, ['#Android', '#авторизация']);
    assert.equal(tags.forwardedFrom.name, 'Beta Info');
    assert.equal(tags.forwardedFrom.author, 'Полян');
    assert.ok(tags.links.some((l) => l.startsWith('https://github.com/')));
    assert.ok(tags.mentions.includes('@tgcrawl'));
});

test('signature, inline buttons (tginfo)', () => {
    const page = parsePage(fx('message-buttons.html'));
    const m = page.messages[0];
    assert.equal(m.author, 'Tribute');
    assert.equal(m.buttons[0].text, 'Поддержать');
    assert.match(m.buttons[0].url, /^https:\/\/t\.me\/tribute/);
});

test('poll question, options, percentages and voters', () => {
    const m = parsePage(fx('message-poll.html')).messages[0];
    assert.equal(m.poll.question, 'Which feature you would like us to build next?');
    assert.equal(m.poll.type, 'Anonymous Poll');
    assert.deepEqual(m.poll.options.map((o) => [o.text, o.percent]), [['Video calls', 62], ['Group voice calls', 16], ['Folders for chats', 22]]);
    assert.equal(m.poll.voters, 627000);
    assert.equal(m.messageId, 105);
});

test('voice and round video metadata without downloading', () => {
    const v = parsePage(fx('message-voice.html')).messages[0];
    assert.equal(v.media[0].type, 'voice');
    assert.equal(v.media[0].duration, '0:03');
    assert.match(v.media[0].url, /^https:\/\/cdn\d\.telesco\.pe\//);
    const r = parsePage(fx('message-roundvideo.html')).messages[0];
    assert.equal(r.media[0].type, 'round_video');
    assert.equal(r.media[0].duration, '0:23');
    assert.ok(r.media[0].thumbnailUrl);
    assert.ok(r.reactions.some((x) => x.emoji === '🔥' && x.count === 625));
});

test('service messages are flagged', () => {
    const page = parsePage(fx('channel-elonmusk.html'));
    const service = page.messages.filter((m) => m.isService);
    assert.ok(service.length >= 2);
    assert.ok(service.some((m) => /pinned|changed/.test(m.text)));
    assert.ok(page.messages.some((m) => !m.isService));
});

test('older page and channel with a page before', () => {
    const page = parsePage(fx('before-telegram.html'));
    assert.equal(page.moreBefore, 420);
    assert.equal(Math.max(...page.messages.map((m) => m.messageId)), 440);
});

test('pages without messages', () => {
    const page = parsePage('<html><body><div class="tgme_page">nothing</div></body></html>');
    assert.equal(page.messages.length, 0);
    assert.equal(page.channel, null);
});

test('profile page classification', () => {
    const withPreview = classifyProfile(fx('profile-channel.html'));
    assert.equal(withPreview.kind, 'unavailable');
    assert.match(withPreview.extra, /subscribers/);
    const noPreview = '<div class="tgme_page_title">Some channel</div><div class="tgme_page_extra">12 345 subscribers</div>';
    assert.equal(classifyProfile(noPreview).kind, 'preview_disabled');
    assert.equal(classifyProfile('<div class="tgme_page_title">Bob</div><div class="tgme_page_extra">@bob</div>').kind, 'not_a_channel');
    assert.equal(classifyProfile('<div class="tgme_page_title">Telegram: Contact @nobody_here</div>').kind, 'not_found');
});

test('extractEntities finds links, mentions and hashtags', () => {
    const html = 'Hi <a href="https://example.com/a">x</a> <a href="https://t.me/foo_bar">@foo_bar</a> <a href="?q=%23btc">#btc</a> and #eth';
    const e = extractEntities(html, 'Hi x @foo_bar #btc and #eth');
    assert.deepEqual(e.links, ['https://example.com/a']);
    assert.deepEqual(e.mentions, ['@foo_bar']);
    assert.deepEqual(e.hashtags, ['#btc', '#eth']);
});

test('keyword and regex filters', () => {
    const msg = (text) => ({ text, linkPreview: null, poll: null });
    const f1 = buildFilter({ includeKeywords: ['Bitcoin', 'ETH'], excludeKeywords: ['scam'] });
    assert.equal(f1.test(msg('bitcoin is up')), true);
    assert.equal(f1.test(msg('Eth merge')), true);
    assert.equal(f1.test(msg('bitcoin scam alert')), false);
    assert.equal(f1.test(msg('nothing here')), false);
    const f2 = buildFilter({ includeRegex: '\\b(update|release)\\s+\\d+' });
    assert.equal(f2.test(msg('New release 12 is out')), true);
    assert.equal(f2.test(msg('nothing')), false);
    const f3 = buildFilter({ excludeRegex: '^ad:' });
    assert.equal(f3.test(msg('AD: buy now')), false);
    assert.equal(f3.test(msg('news')), true);
    assert.equal(buildFilter({}).active, false);
    assert.throws(() => buildFilter({ includeRegex: '(' }));
});

test('date inputs', () => {
    const now = Date.parse('2026-10-14T12:00:00Z');
    assert.equal(parseDateInput('2026-09-01', 'start'), Date.parse('2026-09-01T00:00:00Z'));
    assert.equal(parseDateInput('2026-09-01', 'end'), Date.parse('2026-09-02T00:00:00Z') - 1);
    assert.equal(parseDateInput('2026-09-01T10:30:00Z', 'end'), Date.parse('2026-09-01T10:30:00Z'));
    assert.equal(parseDateInput('7 days', 'start', now), now - 7 * 86400e3);
    assert.equal(parseDateInput('2 weeks ago', 'start', now), now - 14 * 86400e3);
    assert.equal(parseDateInput('', 'start'), null);
    assert.equal(parseDateInput(undefined, 'start'), null);
    assert.throws(() => parseDateInput('last tuesday'));
});
