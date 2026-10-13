import fs from 'node:fs';
const targets = JSON.parse(fs.readFileSync('recon/targets.json', 'utf8'));
fs.mkdirSync('recon/out', { recursive: true });
for (const f of fs.readdirSync('recon/out')) if (f !== '.keep') fs.rmSync(`recon/out/${f}`);
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
for (const t of targets) {
  const started = Date.now();
  try {
    const res = await fetch(t.url, {
      method: t.method || 'GET',
      headers: { 'user-agent': UA, accept: 'text/html,*/*', ...(t.headers || {}) },
      body: t.body,
      redirect: 'manual',
    });
    const text = await res.text();
    const ms = Date.now() - started;
    fs.writeFileSync(`recon/out/${t.name}.html`, text);
    console.log(`\n===== ${t.name} :: ${res.status} ${res.headers.get('content-type')} len=${text.length} ${ms}ms location=${res.headers.get('location') || '-'}`);
    console.log(`----- set-cookie: ${res.headers.get('set-cookie') || '-'}`);
  } catch (e) {
    console.log(`\n===== ${t.name} :: ERROR ${e.message}`);
  }
}
