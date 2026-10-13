#!/usr/bin/env bash
# Apply store listing, pricing and visibility from <actor-dir>/.actor/store.json (re-run after billing info is set).
# Usage: apify-publish.sh <actor-name> <actor-dir>   (needs APIFY_TOKEN)
set -u
ACTOR_NAME="$1"; ACTOR_DIR="$2"
API="https://api.apify.com/v2"
AUTH=(-H "Authorization: Bearer $APIFY_TOKEN")
json() { node -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1"; }
USERNAME=$(curl -sS "${AUTH[@]}" "$API/users/me" | json 'd.data.username')
ID="$USERNAME~$ACTOR_NAME"
STORE="$ACTOR_DIR/.actor/store.json"
echo "publishing $ID from $STORE"

CURRENT=$(curl -sS "${AUTH[@]}" "$API/acts/$ID")
echo "$CURRENT" | json 'd.data ? ("current: isPublic=" + d.data.isPublic + " pricing=" + JSON.stringify((d.data.pricingInfos||[]).map(p=>p.pricingModel))) : JSON.stringify(d)'

# 1) Listing: title, description, categories, SEO.
LISTING=$(node -pe 'const s=require("./'"$STORE"'"); JSON.stringify({title:s.title, description:s.description, categories:s.categories, seoTitle:s.seoTitle, seoDescription:s.seoDescription})')
curl -sS -X PUT "${AUTH[@]}" -H "Content-Type: application/json" "$API/acts/$ID" --data "$LISTING" \
  | json 'd.data ? ("listing ok: " + d.data.title + " | " + JSON.stringify(d.data.categories)) : ("listing FAILED: " + JSON.stringify(d))'

# 2) Pricing: only when the Actor has no pay-per-event pricing yet.
HAS_PPE=$(echo "$CURRENT" | json '(d.data && (d.data.pricingInfos||[]).some(p=>p.pricingModel==="PAY_PER_EVENT")) ? "yes" : "no"')
if [ "$HAS_PPE" = "no" ]; then
  PRICING=$(node -pe 'const s=require("./'"$STORE"'"); JSON.stringify({pricingInfos:[{pricingModel:"PAY_PER_EVENT", pricingPerEvent:{actorChargeEvents:s.events}}]})')
  curl -sS -X PUT "${AUTH[@]}" -H "Content-Type: application/json" "$API/acts/$ID" --data "$PRICING" \
    | json 'd.data ? ("pricing ok: " + JSON.stringify((d.data.pricingInfos||[]).map(p=>p.pricingModel))) : ("pricing FAILED: " + JSON.stringify(d))'
else
  echo "pricing already set, leaving it alone"
fi

# 2b) Permission level and example input (both needed before "Publish on Store").
EXTRA=$(node -pe 'const s=require("./'"$STORE"'"); JSON.stringify({actorPermissionLevel:s.permissionLevel||"LIMITED_PERMISSIONS", exampleRunInput:{body:JSON.stringify(s.exampleInput||{}), contentType:"application/json"}})')
curl -sS -X PUT "${AUTH[@]}" -H "Content-Type: application/json" "$API/acts/$ID" --data "$EXTRA" \
  | json 'd.data ? ("permissions ok: " + d.data.actorPermissionLevel + " exampleInput=" + (d.data.exampleRunInput ? "set" : "missing")) : ("permissions FAILED: " + JSON.stringify(d))'

# 3) Visibility.
PUBLIC=$(node -pe 'require("./'"$STORE"'").isPublic ? "true" : "false"')
curl -sS -X PUT "${AUTH[@]}" -H "Content-Type: application/json" "$API/acts/$ID" --data "{\"isPublic\":$PUBLIC}" \
  | json 'd.data ? ("visibility ok: isPublic=" + d.data.isPublic) : ("visibility FAILED: " + JSON.stringify(d))'
