// Replaces the flat pay-per-event price with the tiered price from .actor/store.json while the Actor is still private.
// The shared publish script only sets pricing when none exists, so tiers added later need this one-off, idempotent step.
// Needs APIFY_TOKEN in the environment. Never prints it.
import fs from 'node:fs';

const NAME = 'telegram-channel-scraper';
const API = 'https://api.apify.com/v2';
const headers = { Authorization: `Bearer ${process.env.APIFY_TOKEN}`, 'Content-Type': 'application/json' };
const store = JSON.parse(fs.readFileSync(new URL('../../actors/telegram-channel-scraper/.actor/store.json', import.meta.url), 'utf8'));

const me = (await (await fetch(`${API}/users/me`, { headers })).json()).data.username;
const id = `${me}~${NAME}`;
const cur = (await (await fetch(`${API}/acts/${id}`, { headers })).json()).data;
const ppe = (cur.pricingInfos || []).filter((p) => p.pricingModel === 'PAY_PER_EVENT').at(-1);
const curEvent = ppe?.pricingPerEvent?.actorChargeEvents?.message;
console.log('current pricing:', JSON.stringify(curEvent ?? null), 'isPublic=', cur.isPublic);
const wanted = store.events.message;
if (cur.isPublic) { console.log('Actor is public: not touching pricing'); process.exit(0); }
if (curEvent?.eventTieredPricingUsd && JSON.stringify(curEvent.eventTieredPricingUsd) === JSON.stringify(wanted.eventTieredPricingUsd)) { console.log('tiered pricing already in place'); process.exit(0); }
const body = { pricingInfos: [{ pricingModel: 'PAY_PER_EVENT', pricingPerEvent: { actorChargeEvents: store.events } }] };
const res = await fetch(`${API}/acts/${id}`, { method: 'PUT', headers, body: JSON.stringify(body) });
const out = await res.json();
if (out.data) {
    const p = (out.data.pricingInfos || []).filter((x) => x.pricingModel === 'PAY_PER_EVENT').at(-1);
    console.log('pricing updated:', JSON.stringify(p?.pricingPerEvent?.actorChargeEvents?.message));
} else {
    console.log('pricing update FAILED:', JSON.stringify(out).slice(0, 600));
}
