import test from 'node:test';
import assert from 'node:assert/strict';
import { scrapeChannel, locateBefore } from '../src/scraper.js';
import { buildFilter } from '../src/telegram.js';

/** Fake t.me for one channel with `total` messages (ids 1..total, one per hour, 20 per page), using the real page markup shape. */
function fakeTelegram({ total = 100, channel = 'fakechan', start = Date.parse('2026-01-01T00:00:00Z'), gapEvery = 0, deleted = new Set(), service = new Set(), flaky } = {}) {
    const requests = [];
    const exists = (id) => id >= 1 && id <= total && !deleted.has(id) && !(gapEvery && id % gapEvery === 0);
    const msgHtml = (id) => `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message ${service.has(id) ? 'service_message' : ''}" data-post="${channel}/${id}">`
        + `<div class="tgme_widget_message_bubble"><div class="tgme_widget_message_text js-message_text" dir="auto">message ${id}${id % 7 === 0 ? ' bitcoin' : ''}</div>`
        + `<div class="tgme_widget_message_footer"><div class="tgme_widget_message_info"><span class="tgme_widget_message_views">${id}</span>`
        + `<span class="tgme_widget_message_meta"><a class="tgme_widget_message_date" href="https://t.me/${channel}/${id}"><time datetime="${new Date(start + id * 3600e3).toISOString()}" class="time">x</time></a></span></div></div></div></div></div>`;
    const page = (before) => {
        const upper = before ? Math.min(before - 1, total) : total;
        const ids = [];
        for (let id = upper; id >= 1 && ids.length < 20; id -= 1) if (exists(id)) ids.unshift(id);
        if (!ids.length) return '<html><body><section class="tgme_channel_history"></section></body></html>';
        const more = ids[0] > 1 ? `<div class="tgme_widget_message_centered"><a href="/s/${channel}?before=${ids[0]}" class="tme_messages_more js-messages_more" data-before="${ids[0]}"></a></div>` : '';
        return `<html><body><div class="tgme_channel_info"><div class="tgme_channel_info_header_title"><span>Fake Channel</span></div><div class="tgme_channel_info_header_username"><a>@${channel}</a></div>`
            + `<div class="tgme_channel_info_counters"><div class="tgme_channel_info_counter"><span class="counter_value">1.5K</span> <span class="counter_type">subscribers</span></div></div></div>`
            + `<section class="tgme_channel_history">${more}${ids.map(msgHtml).join('')}</section></body></html>`;
    };
    const fetcher = {
        requests,
        async get(path) {
            requests.push(path);
            if (flaky && flaky(path, requests.length)) throw new Error('boom');
            const m = path.match(/^\/s\/([^?]+)(?:\?before=(\d+))?$/);
            if (m && m[1] === channel) return { status: 200, body: page(m[2] ? Number(m[2]) : null) };
            if (m) return { status: 302, body: '' };
            if (path === '/ghost') return { status: 200, body: '<div class="tgme_page_title">Ghost</div><div class="tgme_page_extra">500 subscribers</div>' };
            if (path === '/someuser') return { status: 200, body: '<div class="tgme_page_title">Some User</div><div class="tgme_page_extra">@someuser</div>' };
            return { status: 200, body: '<div class="tgme_page_title">Telegram: Contact @x</div>' };
        },
    };
    return fetcher;
}

const collect = () => {
    const out = [];
    return { out, emit: async (m) => { out.push(m); return true; } };
};
const run = (fetcher, opt, username = 'fakechan') => {
    const sink = collect();
    return scrapeChannel({ username, fetcher, opt, sink }).then((res) => ({ res, out: sink.out }));
};

test('newest messages first, paginating backwards, stops at maxMessages', async () => {
    const f = fakeTelegram({ total: 100 });
    const { res, out } = await run(f, { maxMessages: 45 });
    assert.equal(out.length, 45);
    assert.equal(out[0].messageId, 100);
    assert.equal(out[44].messageId, 56);
    assert.equal(res.pages, 3);
    assert.equal(res.status, 'ok');
    assert.equal(res.channel.title, 'Fake Channel');
    assert.equal(res.channel.subscribers, 1500);
    assert.deepEqual(f.requests, ['/s/fakechan', '/s/fakechan?before=81', '/s/fakechan?before=61']);
});

test('complete archive down to message 1 without duplicates, ends without extra requests', async () => {
    const f = fakeTelegram({ total: 95, deleted: new Set([10, 11, 50]) });
    const { out, res } = await run(f, { maxMessages: 1000 });
    const ids = out.map((m) => m.messageId);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.length, 95 - 3);
    assert.equal(ids.at(-1), 1);
    assert.equal(res.pages, 5);
});

test('date window: dateFrom stops the walk early', async () => {
    const f = fakeTelegram({ total: 200 });
    const start = Date.parse('2026-01-01T00:00:00Z');
    const dateFrom = start + 150 * 3600e3; // messages 150..200
    const { out, res } = await run(f, { maxMessages: 10000, dateFrom });
    assert.equal(out.length, 51);
    assert.equal(out.at(-1).messageId, 150);
    assert.ok(res.pages <= 4, `walked ${res.pages} pages`);
});

test('date window: dateTo jumps with a binary search instead of walking from the newest message', async () => {
    const f = fakeTelegram({ total: 5000 });
    const start = Date.parse('2026-01-01T00:00:00Z');
    const dateTo = start + 1000 * 3600e3; // newest allowed: message 1000
    const dateFrom = start + 981 * 3600e3;
    const { out, res } = await run(f, { maxMessages: 10000, dateFrom, dateTo });
    assert.deepEqual(out.map((m) => m.messageId), Array.from({ length: 20 }, (_, i) => 1000 - i));
    assert.ok(f.requests.length < 30, `${f.requests.length} requests`);
    assert.ok(res.probes > 5);
});

test('dateTo later than the newest message needs no search', async () => {
    const f = fakeTelegram({ total: 50 });
    const { out, res } = await run(f, { maxMessages: 5, dateTo: Date.parse('2030-01-01T00:00:00Z') });
    assert.equal(out.length, 5);
    assert.equal(res.probes, 0);
    assert.equal(f.requests.length, 1);
});

test('locateBefore returns the largest id whose preceding messages are within the date', async () => {
    const f = fakeTelegram({ total: 300 });
    const start = Date.parse('2026-01-01T00:00:00Z');
    const { before } = await locateBefore(f, 'fakechan', 300, start + 123.5 * 3600e3);
    assert.equal(before, 124); // messages <= 123 qualify, 124 is the first newer than the limit
});

test('dateTo older than the whole channel yields nothing and is not an error', async () => {
    const f = fakeTelegram({ total: 100 });
    const { out, res } = await run(f, { maxMessages: 10, dateTo: Date.parse('2020-01-01T00:00:00Z') });
    assert.equal(out.length, 0);
    assert.equal(res.status, 'empty');
});

test('keyword filter applies while paginating; service messages skipped by default', async () => {
    const f = fakeTelegram({ total: 100, service: new Set([98, 91]) });
    const filter = buildFilter({ includeKeywords: ['bitcoin'] });
    const { out } = await run(f, { maxMessages: 1000, filter });
    assert.deepEqual(out.map((m) => m.messageId), [98, 91, 84, 77, 70, 63, 56, 49, 42, 35, 28, 21, 14, 7].filter((id) => id !== 98 && id !== 91));
    const all = await run(fakeTelegram({ total: 30, service: new Set([30]) }), { maxMessages: 100 });
    assert.equal(all.out.length, 29);
    const withService = await run(fakeTelegram({ total: 30, service: new Set([30]) }), { maxMessages: 100, includeService: true });
    assert.equal(withService.out.length, 30);
});

test('incremental: first run records the newest id, second run finds nothing new', async () => {
    const f = fakeTelegram({ total: 100 });
    const first = await run(f, { maxMessages: 5, incremental: true, lastId: null });
    assert.equal(first.out.length, 5);
    assert.equal(first.res.nextLastId, 100);
    const second = await run(f, { maxMessages: 5, incremental: true, lastId: first.res.nextLastId });
    assert.equal(second.out.length, 0);
    assert.equal(second.res.nextLastId, 100);
    assert.equal(second.res.pages, 1);
});

test('incremental: new messages are emitted oldest first and the pointer advances', async () => {
    const before = fakeTelegram({ total: 100 });
    const first = await run(before, { maxMessages: 5, incremental: true });
    const grown = fakeTelegram({ total: 143 });
    const next = await run(grown, { maxMessages: 1000, incremental: true, lastId: first.res.nextLastId });
    assert.deepEqual(next.out.map((m) => m.messageId), Array.from({ length: 43 }, (_, i) => 101 + i));
    assert.equal(next.res.nextLastId, 143);
    assert.ok(next.res.pages >= 3);
});

test('incremental: maxMessages smaller than the backlog continues exactly where it stopped', async () => {
    const f = fakeTelegram({ total: 143 });
    const a = await run(f, { maxMessages: 10, incremental: true, lastId: 100 });
    assert.deepEqual(a.out.map((m) => m.messageId), Array.from({ length: 10 }, (_, i) => 101 + i));
    assert.equal(a.res.nextLastId, 110);
    assert.equal(a.res.carryOver, true);
    const b = await run(f, { maxMessages: 1000, incremental: true, lastId: a.res.nextLastId });
    assert.deepEqual(b.out.map((m) => m.messageId), Array.from({ length: 33 }, (_, i) => 111 + i));
    assert.equal(b.res.nextLastId, 143);
});

test('incremental: a charge limit stops emission and the pointer stays on the last emitted message', async () => {
    const f = fakeTelegram({ total: 143 });
    const out = [];
    const sink = { emit: async (m) => { if (out.length >= 3) return false; out.push(m); return true; } };
    const res = await scrapeChannel({ username: 'fakechan', fetcher: f, opt: { maxMessages: 1000, incremental: true, lastId: 100 }, sink });
    assert.equal(out.length, 3);
    assert.equal(res.stoppedByLimit, true);
    assert.equal(res.nextLastId, 103);
});

test('incremental pointer ignores filtered-out messages but never skips unseen ones', async () => {
    const f = fakeTelegram({ total: 143 });
    const filter = buildFilter({ includeKeywords: ['bitcoin'] });
    const r = await run(f, { maxMessages: 1000, incremental: true, lastId: 100, filter });
    assert.deepEqual(r.out.map((m) => m.messageId), [105, 112, 119, 126, 133, 140]);
    assert.equal(r.res.nextLastId, 143);
});

test('maxPages caps the walk and flags truncation', async () => {
    const f = fakeTelegram({ total: 1000 });
    const { res, out } = await run(f, { maxMessages: 100000, maxPages: 3, filter: buildFilter({ includeKeywords: ['nomatch'] }) });
    assert.equal(res.pages, 3);
    assert.equal(res.truncated, true);
    assert.equal(out.length, 0);
});

test('channels without a public preview are classified and produce nothing', async () => {
    const f = fakeTelegram({ total: 10 });
    assert.equal((await run(f, { maxMessages: 5 }, 'ghost')).res.status, 'preview_disabled');
    assert.equal((await run(f, { maxMessages: 5 }, 'someuser')).res.status, 'not_a_channel');
    const none = await run(f, { maxMessages: 5 }, 'doesnotexist');
    assert.equal(none.res.status, 'not_found');
    assert.equal(none.out.length, 0);
});

test('a channel that errors mid-way rejects (the caller reports it as failed and charges only emitted messages)', async () => {
    const f = fakeTelegram({ total: 100, flaky: (path, n) => n === 2 });
    const sink = collect();
    await assert.rejects(scrapeChannel({ username: 'fakechan', fetcher: f, opt: { maxMessages: 100 }, sink }), /boom/);
    assert.equal(sink.out.length, 20, 'messages from the good first page were already emitted once');
});
