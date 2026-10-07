#!/usr/bin/env bash
set -euo pipefail

credentials="${1:?Usage: runner-auto-bootstrap.bash <credentials-file> <real-agent>}"
real_agent="${2:?Specify true or false for the preview runtime}"
[[ "$real_agent" == true || "$real_agent" == false ]]
token=$(jq -er '.token | select(type == "string" and length > 0)' "$credentials")
api_url=$(jq -er '.apiUrl | select(type == "string" and length > 0)' "$credentials")
echo "::add-mask::$token"
headers=(-H "Authorization: Bearer ${token}" -H "Content-Type: application/json")
if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
    headers+=(-H "x-vercel-protection-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET}")
fi

# Platform models are read-only. New accounts need no provider connection or
# Debug gate to use Auto.
curl -fsS "${headers[@]}" "${api_url}/api/run-models" | jq -e '
    .defaultModel == "okou-1.0" and
    (.models | length == 1) and
    .models[0].model == "okou-1.0" and
    .models[0].memberEffective.providerType == "built-in" and
    .models[0].memberEffective.credentialScope == "org" and
    .models[0].modelProviderId == null
' >/dev/null
curl -fsS "${headers[@]}" -X PUT \
    -d '{"selectedModel":"okou-1.0","serviceTier":null}' \
    "${api_url}/api/user-model-preference" >/dev/null
payload=$(jq -nc --argjson realAgent "$real_agent" '{switches: {_realAgentInPreview: $realAgent}}')
curl -fsS "${headers[@]}" -X POST -d "$payload" \
    "${api_url}/api/feature-switches" | jq -e --argjson realAgent "$real_agent" \
    '.effectiveSwitches._realAgentInPreview == $realAgent' >/dev/null
