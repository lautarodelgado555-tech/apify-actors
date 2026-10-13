#!/usr/bin/env bash
# Run an Actor on the Apify platform and save its run info, log and dataset.
# Usage: apify-run.sh <actor-name> <input.json> <output-dir>
# Needs APIFY_TOKEN in the environment.
set -u
ACTOR_NAME="$1"; INPUT="$2"; OUTDIR="$3"
API="https://api.apify.com/v2"
AUTH=(-H "Authorization: Bearer $APIFY_TOKEN")
json() { node -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1"; }

USERNAME=$(curl -sS "${AUTH[@]}" "$API/users/me" | json 'd.data.username')
echo "actor: $USERNAME~$ACTOR_NAME"
RUN=$(curl -sS -X POST "${AUTH[@]}" -H "Content-Type: application/json" \
  "$API/acts/$USERNAME~$ACTOR_NAME/runs?memory=2048&timeout=900" --data @"$INPUT")
RUN_ID=$(echo "$RUN" | json 'd.data ? d.data.id : ("ERROR " + JSON.stringify(d))')
echo "run: $RUN_ID"
case "$RUN_ID" in ERROR*) exit 1;; esac

for i in $(seq 1 100); do
  STATUS=$(curl -sS "${AUTH[@]}" "$API/actor-runs/$RUN_ID" | json 'd.data.status')
  echo "$(date -u +%T) status: $STATUS"
  case "$STATUS" in SUCCEEDED|FAILED|ABORTED|TIMED-OUT) break;; esac
  sleep 10
done

curl -sS "${AUTH[@]}" "$API/actor-runs/$RUN_ID" > "$OUTDIR/apify-run.json"
curl -sS "${AUTH[@]}" "$API/logs/$RUN_ID" > "$OUTDIR/apify-run.log"
DATASET=$(json 'd.data.defaultDatasetId' < "$OUTDIR/apify-run.json")
curl -sS "${AUTH[@]}" "$API/datasets/$DATASET/items?clean=true" > "$OUTDIR/apify-dataset.json"
json 'console.log("status", d.data.status, "CU", d.data.usage && d.data.usage.ACTOR_COMPUTE_UNITS, "usd", d.data.usageTotalUsd, "items", d.data.stats && d.data.stats.itemCount) || ""' < "$OUTDIR/apify-run.json"
