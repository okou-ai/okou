#!/usr/bin/env bash
set -euo pipefail

credentials="${1:?Usage: runner-mock-claude-bootstrap.bash <credentials-file>}"
token=$(jq -er '.token | select(type == "string" and length > 0)' "$credentials")
api_url=$(jq -er '.apiUrl | select(type == "string" and length > 0)' "$credentials")
echo "::add-mask::$token"

headers=(-H "Authorization: Bearer ${token}" -H "Content-Type: application/json")
if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
    headers+=(-H "x-vercel-protection-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET}")
fi

provider_response=$(curl -fsS "${headers[@]}" \
    -X POST \
    -d '{"type":"claude-code-oauth-token","secret":"mock-oauth-token-for-e2e"}' \
    "${api_url}/api/me/model-providers")
jq -e '.provider.type == "claude-code-oauth-token"' \
    <<<"$provider_response" \
    >/dev/null

policies=$(curl -fsS "${headers[@]}" "${api_url}/api/model-policies")
policy_payload=$(jq -c '
    {
      revision,
      policies: (
        [.policies[] |
          select(.model != "claude-sonnet-4-6") |
          {
            model,
            isDefault,
            defaultProviderType,
            credentialScope,
            modelProviderId
          }
        ] + [
          {
            model: "claude-sonnet-4-6",
            isDefault: false,
            defaultProviderType: "claude-code-oauth-token",
            credentialScope: "member",
            modelProviderId: null
          }
        ]
      )
    }
' <<<"$policies")
curl -fsS "${headers[@]}" \
    -X PUT \
    -d "$policy_payload" \
    "${api_url}/api/model-policies" \
    >/dev/null

curl -fsS "${headers[@]}" \
    -X POST \
    -d '{"switches":{"_realAgentInPreview":false,"piLoop":false}}' \
    "${api_url}/api/feature-switches" \
    | jq -e '.effectiveSwitches._realAgentInPreview == false and .effectiveSwitches.piLoop == false' \
    >/dev/null
