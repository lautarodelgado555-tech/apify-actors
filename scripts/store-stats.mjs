// Daily snapshot of usage stats for every Actor in actors/, plus the diff against the previous snapshot.
// Writes ci/store-stats/history.jsonl (one line per day), latest.json and latest-diff.json. Needs APIFY_TOKEN.
import fs from 'node:fs';

const API = 'https://api.apify.com/v2';
const headers = { Authorization: `Bearer ${process.env.APIFY_TOKEN}` };
const OUT = 'ci/store-stats';
fs.mkdirSync(OUT, { recursive: true });

const get = async (url, auth = true) => {
  const res = await fetch(url, { headers: auth ? headers : {} });
  if (!res.ok) throw new Error(`${res.status} ${url.replace(/token=[^&]+/, 'token=***')}`);
  return (await res.json()).data;
};

const me = await get(`${API}/users/me`);
const store = await get(`${API}/store?username=${me.username}&limit=100`, false).catch(() => ({ items: [] }));
const storeByName = Object.fromEntries((store.items || []).map((i) => [i.name, i]));

const actors = {};
for (const name of fs.readdirSync('actors').sort()) {
  try {
    const d = await get(`${API}/acts/${me.username}~${name}`);
    const s = d.stats || {};
    const pub = storeByName[name] || {};
    actors[name] = {
      isPublic: d.isPublic,
      totalUsers: s.totalUsers ?? null,
      totalUsers7Days: s.totalUsers7Days ?? null,
      totalUsers30Days: s.totalUsers30Days ?? null,
      totalRuns: s.totalRuns ?? null,
      lastRunStartedAt: s.lastRunStartedAt ?? null,
      rating: pub.actorReviewRating ?? pub.stats?.actorReviewRating ?? null,
      reviews: pub.actorReviewCount ?? pub.stats?.actorReviewCount ?? null,
    };
  } catch (e) {
    actors[name] = { error: String(e.message) };
  }
}

const snapshot = { checkedAt: new Date().toISOString(), actors };
const histFile = `${OUT}/history.jsonl`;
const prev = fs.existsSync(histFile)
  ? JSON.parse(fs.readFileSync(histFile, 'utf8').trim().split('\n').filter(Boolean).pop() || 'null')
  : null;

const diff = { checkedAt: snapshot.checkedAt, previousCheckedAt: prev?.checkedAt ?? null, changes: [] };
for (const [name, cur] of Object.entries(actors)) {
  const old = prev?.actors?.[name];
  if (!old) { diff.changes.push({ actor: name, field: 'new-actor', after: cur }); continue; }
  for (const f of ['isPublic', 'totalUsers', 'totalUsers30Days', 'totalRuns', 'rating', 'reviews', 'error']) {
    if (JSON.stringify(old[f]) !== JSON.stringify(cur[f])) diff.changes.push({ actor: name, field: f, before: old[f] ?? null, after: cur[f] ?? null });
  }
}

fs.appendFileSync(histFile, JSON.stringify(snapshot) + '\n');
fs.writeFileSync(`${OUT}/latest.json`, JSON.stringify(snapshot, null, 2));
fs.writeFileSync(`${OUT}/latest-diff.json`, JSON.stringify(diff, null, 2));
console.log(JSON.stringify(diff, null, 2));
