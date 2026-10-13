#!/usr/bin/env bash
# Set default run options for an Actor after `apify push`.
# Usage: apify-configure.sh <actor-name>   (needs APIFY_TOKEN)
set -u
ACTOR_NAME="$1"
API="https://api.apify.com/v2"
AUTH=(-H "Authorization: Bearer $APIFY_TOKEN")
json() { node -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1"; }
USERNAME=$(curl -sS "${AUTH[@]}" "$API/users/me" | json 'd.data.username')
ID="$USERNAME~$ACTOR_NAME"
echo "configuring $ID"
curl -sS -X PUT "${AUTH[@]}" -H "Content-Type: application/json" "$API/acts/$ID" \
  --data '{"defaultRunOptions":{"build":"latest","timeoutSecs":3600,"memoryMbytes":2048}}' \
  | json 'd.data ? ("ok defaultRunOptions=" + JSON.stringify(d.data.defaultRunOptions)) : JSON.stringify(d)'

# Save the log of the most recent build next to the deploy log for debugging.
OUTDIR="${2:-.}"
BUILD_ID=$(curl -sS "${AUTH[@]}" "$API/acts/$ID/builds?desc=true&limit=1" | json 'd.data.items[0] ? d.data.items[0].id : ""')
if [ -n "$BUILD_ID" ]; then
  curl -sS "${AUTH[@]}" "$API/actor-builds/$BUILD_ID/log" > "$OUTDIR/apify-build.log"
  echo "saved build log $BUILD_ID ($(wc -l < "$OUTDIR/apify-build.log") lines)"
fi
