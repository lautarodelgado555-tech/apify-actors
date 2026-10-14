# Actor playbook (read this first)

Repo: `lautarodelgado555-tech/apify-actors` (public, branch `main`). Owner: Lautaro Delgado (Apify username `lautarodelgado`).
Reference implementation: `actors/florida-sunbiz-scraper/` (published, working). Copy its structure and read its `src/main.js`, `.actor/*`, `README.md`, `Dockerfile` before writing anything.
Market research behind the choices: `/home/claude/reports/Oportunidades de Actors en Apify.md` (read the section for your Actor) if it exists in your environment; the brief you were given already carries the essentials.

## Hard rules

1. **Own files only.** You may create/edit: `actors/<name>/**`, `.github/workflows/<name>.yml`, `.github/workflows/recon-<name>.yml`, `recon/<name>/**`, `ci/<name>/**` (CI writes it). Do not touch shared files (`scripts/*`, `.github/workflows/publish.yml`, other Actors, `docs/`). If a shared script needs a change, say so in your final report instead.
2. **Git.** Work in your own worktree. Small commits. Before every push: `git pull --rebase --autostash`; retry if the push races. Never force-push, never rewrite pushed history. Push to `main` (CI deploys from there). End every commit message with these two lines:
   ```
   Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
   Claude-Session: https://claude.ai/code/session_01Gt7zykfrHn7jxUezgp42KW
   ```
3. **No internet from the shell** (only npm/pip/GitHub; `WebFetch`/`WebSearch` work for reading docs and public pages but are not a substitute for a real fetch). Every real fetch and every scraper run happens on a GitHub runner:
   - Recon: copy `docs/templates/recon.yml` to `.github/workflows/recon-<name>.yml` (`sed -i 's/__ACTOR__/<name>/g'`), write `recon/<name>/targets.json` (format documented at the top of `scripts/recon.mjs`: GET/POST, headers, JSON body, strategies `fetch|gotScraping|impit|chromium|firefox`, browser `actions`), push. The runner commits `recon/<name>/out/`. Pull and read it.
   - Actor CI: copy `docs/templates/actor-ci.yml` to `.github/workflows/<name>.yml` (replace `__ACTOR__`, pick a `__CRON__` from your brief). It runs unit tests, local runs for each `ci-inputs/*.json` (except `platform*.json`), deploys with `apify push`, runs the Actor on Apify with `ci-inputs/platform.json`, and commits everything into `ci/<name>/`. Platform deploy/run happens on pushes and Mondays only (saves credit); the daily cron still does the free local smoke test.
   - To wait for a workflow: `gh run list --workflow <file> --limit 1` and `gh run watch <id> --exit-status` (REST only; GraphQL is blocked). Then `git pull --rebase` and read `ci/<name>/`. Do not poll with blind `sleep` loops.
4. **Secrets.** `APIFY_TOKEN` exists only as a GitHub secret. Never print it, never ask for it, never write it to a file or log (the templates already `grep -v -i token`).
5. **Never make an Actor public.** `store.json` must keep `"isPublic": false`. Lautaro presses "Publish" in the Console himself.
6. **Public data only.** No logins, no credentials, no CAPTCHA-solving services, no paid unblockers. If the source shows a challenge you cannot pass with a normal browser (Firefox headless passed Sunbiz's Cloudflare check), **fail closed**: stop, say clearly in the Actor log and the dataset-free output that the source blocked the run, and charge nothing. Collect only what the source shows publicly; say so in the README. State "not affiliated with or endorsed by <source>" in the README.
7. **Logos are original and generic** (draw one with Python PIL: simple glyph or initials on a flat color, 512x512 `.actor/logo.png`). Never reproduce a brand's logo or mascot.
8. **Keep platform runs cheap.** `ci-inputs/platform.json` should be a small run (a handful of items, 1024-2048 MB). Report the real cost: `usageTotalUsd` and items from `ci/<name>/apify-run.json`, per-1,000-results cost = usageTotalUsd / items * 1000 (state that it is extrapolated from a small run).

## Lessons from the Sunbiz Actor (do not relearn them)

- Prefer HTTP + Cheerio (or the source's JSON API). Use a browser only if the spike proves HTTP fails. Cheerio costs ≈ USD 0.07 per 1,000 pages; a browser ≈ USD 0.67; residential proxy USD 8/GB. Price must leave `0.8 × price ≥ 2 × cost`.
- Image for HTTP-only: `apify/actor-node:22`. For Firefox: `apify/actor-node-playwright-firefox:22-1.64.0` with `"playwright": "1.64.0"` pinned exactly (a version mismatch breaks browser launch).
- Dockerfile gotchas: `COPY --chown=myuser package*.json ./` and `COPY --chown=myuser . ./` (otherwise EACCES on lockfile); `npm install --omit=dev --omit=optional`; dockerfile path in `.actor/actor.json` must resolve (`"dockerfile": "../Dockerfile"` when the file sits in the Actor root). Add a `.dockerignore` (`node_modules`, `storage`, `test`, `.git`, `ci-inputs/`).
- `apify push --no-prompt` no longer exists; the template uses `apify push --force`.
- Tests: `"test": "node --test test/*.test.js"` (not the bare folder). Save real pages/JSON captured by recon as fixtures in `test/fixtures/` and test the parsers against them; that is how you know the parser matches reality.
- State that must survive migrations goes in `Actor.useState('STATE', {...})`. Charge **before** pushing a row: `const r = await Actor.charge({eventName:'result'}); if (r.eventChargeLimitReached) stop;` then `Actor.pushData(row)`. Respect `ACTOR_MAX_TOTAL_CHARGE_USD` via that return value. Never charge the synthetic `apify-actor-start` event.
- A failed/blocked item is never charged. Rows with no data are never charged.
- Store requirements before "Publish on Store" works: `.actor/output_schema.json` (see Sunbiz), `dataset_schema.json`, `input_schema.json` with descriptive titles/descriptions/prefill, `permissionLevel: LIMITED_PERMISSIONS`, example input, logo, README, billing already set on the account.
- The Store runs every public Actor daily with its default/prefill input; 3 failing days = "under maintenance". The prefill input must be light (a few results), need no residential proxy, and succeed.
- Free-plan users earn nothing for us. Optional but recommended: when `process.env.APIFY_USER_IS_PAYING !== '1'`, cap results per run at about 10 and say so in the README/log.
- Actor technical name = folder name = `actor.json` `name` (never rename later). Title: exact platform name + "Scraper"/"Monitor", 40-50 chars. SEO title/description in `store.json`.
- README: 300+ words, keyword in the first paragraph and in H2/H3, what it returns, input table, output example (real, from CI), pricing table, FAQ, limitations, legal/not-affiliated note, "More Actors by this developer" linking `https://apify.com/lautarodelgado/florida-sunbiz-scraper`. English first, then a short Spanish section.

## Pricing (pay-per-event, no "+usage")

`.actor/store.json` is the source of truth; `.github/workflows/publish.yml` applies it via `scripts/apify-publish.sh` when it changes (it sets pricing only if the Actor has none yet, then permissions, example input, listing, visibility). The Sunbiz file is the template. Use tiered pricing (it ranks better): per event

```json
"eventTieredPricingUsd": {
  "FREE":   {"tieredEventPriceUsd": 0.005},
  "BRONZE": {"tieredEventPriceUsd": 0.005},
  "SILVER": {"tieredEventPriceUsd": 0.0045},
  "GOLD":   {"tieredEventPriceUsd": 0.004}
}
```

in place of `eventPriceUsd` (the two are mutually exclusive). The field name was taken from the Apify client reference; after your first push to `store.json`, read `ci/<name>/07-publish.log`. If it says `pricing FAILED`, fall back to flat `eventPriceUsd` (read the error first, fix the casing/shape if that is the cause) and say which you used. Exactly one event must have `isPrimaryEvent: true`. Prices come from your brief; change them only if the measured cost demands it and say why.

## Definition of done

- `npm test` green in CI (`ci/<name>/02-test.log`), with fixtures from real responses.
- Local runs against the live source worked in CI (`ci/<name>/04-local-*.log`, `local-dataset-*.json` non-empty and sensible). Invalid/blocked/empty inputs behave (no crash, no charge).
- Deployed and run on Apify with status SUCCEEDED (`ci/<name>/apify-run.json`), dataset looks right (`apify-dataset.json`), build log clean.
- `store.json` pushed and `ci/<name>/07-publish.log` shows listing, pricing, permissions OK, `isPublic=false`.
- README, schemas, logo, `.dockerignore` present.
- If something cannot be done (source blocks datacenter IPs, needs login, no public data), stop that Actor early, leave the code in a clean state, and report exactly what the evidence shows. A clean "no-go with proof" is a valid outcome and cheaper than a broken Actor.

## Final report (to the orchestrator, Spanish, under 300 words)

Status (done / partial / no-go), evidence paths in `ci/<name>/`, what the Actor does, modes/inputs, pricing set and the measured platform cost per 1,000 results, known limits and risks, anything Lautaro must do, anything the orchestrator must do (shared-file changes), and the exact name/title of the Actor on Apify.

## Lessons from the first wave (added after it ran)

- Tiered PPE pricing is only accepted by the API when ALL six tiers are present: FREE, BRONZE, SILVER, GOLD, PLATINUM, DIAMOND (copy GOLD into PLATINUM and DIAMOND). `scripts/apify-publish.sh` does not change pricing that already exists; see `recon/telegram-channel-scraper/set-pricing.mjs` and `actors/us-business-status-monitor` for a working set-pricing step.
- The CI template must not delete `07-publish.log` / `05b-pricing.log` (fixed in the template).
- `apify-configure.sh` sets 2048 MB default memory; light HTTP Actors need about 512 MB.
- Sources that put Cloudflare Turnstile / reCAPTCHA tokens on their API (Washington), a `robots.txt` with `Disallow: /` plus an image CAPTCHA (Arizona) or a login wall for automated traffic (Mercado Libre) are no-go: do not evade them.
- Cloudflare in front of Georgia: Apify datacenter proxy blocked, direct connection and residential passed; Tiendanube rate-limits per IP above ~3 requests/second.
