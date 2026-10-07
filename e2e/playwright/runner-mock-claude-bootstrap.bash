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

# Pin the mocked runtime before provisioning synthetic subscription accounts.
curl -fsS "${headers[@]}" \
    -X POST \
    -d '{"switches":{"_realAgentInPreview":false}}' \
    "${api_url}/api/feature-switches" \
    | jq -e '.effectiveSwitches._realAgentInPreview == false' >/dev/null

provider_response=$(curl -fsS "${headers[@]}" \
    -X POST \
    -d '{"type":"claude-code-oauth-token","secret":"mock-oauth-token-for-e2e"}' \
    "${api_url}/api/me/model-providers")
jq -e '.provider.type == "claude-code-oauth-token"' <<<"$provider_response" >/dev/null

# The native Codex behavioral suite selects a personal subscription. These
# credentials are synthetic and the preview runtime stays mocked; no real
# subscription credential enters CI.
jwt_header=$(printf '%s' '{"alg":"none","typ":"JWT"}' | base64 | tr -d '\n=' | tr '+/' '-_')
access_claims=$(jq -nc --argjson exp "$(($(date +%s) + 86400))" '{exp: $exp}')
id_claims=$(jq -nc --argjson exp "$(($(date +%s) + 86400))" '{
    exp: $exp,
    email: "mock-codex@vm0-e2e.ai",
    "https://api.openai.com/auth": {
        chatgpt_account_id: "e2e-mock-codex",
        chatgpt_plan_type: "plus"
    }
}')
access_token="${jwt_header}.$(printf '%s' "$access_claims" | base64 | tr -d '\n=' | tr '+/' '-_').mock-signature"
id_token="${jwt_header}.$(printf '%s' "$id_claims" | base64 | tr -d '\n=' | tr '+/' '-_').mock-signature"
auth_json=$(jq -nc --arg accessToken "$access_token" --arg idToken "$id_token" '{
    OPENAI_API_KEY: null,
    tokens: {
        access_token: $accessToken,
        refresh_token: "e2e-mock-codex-refresh-token",
        id_token: $idToken,
        account_id: "e2e-mock-codex"
    }
}')
payload=$(jq -nc --arg authJson "$auth_json" '{
    type: "codex-oauth-token",
    authMethod: "auth_json",
    secrets: {CODEX_AUTH_JSON: $authJson}
}')
curl -fsS "${headers[@]}" -X POST -d "$payload" \
    "${api_url}/api/me/model-providers" | jq -e '.provider.type == "codex-oauth-token"' >/dev/null

curl -fsS "${headers[@]}" "${api_url}/api/run-models" | jq -e '
    .models[0].model == null and
    any(.models[]; .model == "claude-sonnet-5-5" and
        .memberEffective.providerType == "claude-code-oauth-token" and .memberEffective.credentialScope == "member") and
    any(.models[]; .model == "gpt-6-astra" and
        .memberEffective.providerType == "codex-oauth-token" and .memberEffective.credentialScope == "member")
' >/dev/null
