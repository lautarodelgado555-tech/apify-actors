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
