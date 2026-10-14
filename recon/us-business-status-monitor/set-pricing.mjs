// Applies the tiered pay-per-event prices from actors/us-business-status-monitor/.actor/store.json while the Actor is private.
// The shared publish script only sets pricing when none exists (and its first attempt with tiers is rejected for a new record),
// so this idempotent step replaces the flat price with the tiered one. It never touches a public Actor.
// Needs APIFY_TOKEN in the environment. Never prints it.
import fs from 'node:fs';

const NAME = 'us-business-status-monitor';
const API = 'https://api.apify.com/v2';
const headers = { Authorization: `Bearer ${process.env.APIFY_TOKEN}`, 'Content-Type': 'application/json' };
const store = JSON.parse(fs.readFileSync(new URL('../../actors/us-business-status-monitor/.actor/store.json', import.meta.url), 'utf8'));

const me = (await (await fetch(`${API}/users/me`, { headers })).json()).data.username;
const id = `${me}~${NAME}`;
const cur = (await (await fetch(`${API}/acts/${id}`, { headers })).json()).data;
const ppe = (cur.pricingInfos || []).filter((p) => p.pricingModel === 'PAY_PER_EVENT').at(-1);
const current = ppe?.pricingPerEvent?.actorChargeEvents ?? {};
console.log('isPublic=', cur.isPublic, 'current:', JSON.stringify(Object.fromEntries(Object.entries(current).map(([k, v]) => [k, v.eventTieredPricingUsd ?? v.eventPriceUsd]))));
if (cur.isPublic) {
    console.log('Actor is public: not touching pricing');
    process.exit(0);
}
const same = Object.entries(store.events).every(([k, v]) => JSON.stringify(current[k]?.eventTieredPricingUsd) === JSON.stringify(v.eventTieredPricingUsd));
if (same) {
    console.log('tiered pricing already in place');
    process.exit(0);
}
const body = { pricingInfos: [{ pricingModel: 'PAY_PER_EVENT', pricingPerEvent: { actorChargeEvents: store.events } }] };
const res = await fetch(`${API}/acts/${id}`, { method: 'PUT', headers, body: JSON.stringify(body) });
const out = await res.json();
if (out.data) {
    const p = (out.data.pricingInfos || []).filter((x) => x.pricingModel === 'PAY_PER_EVENT').at(-1);
    console.log('pricing updated:', JSON.stringify(p?.pricingPerEvent?.actorChargeEvents));
} else {
    console.log('pricing update FAILED:', JSON.stringify(out).slice(0, 600));
}
