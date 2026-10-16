#!/usr/bin/env bash
set -euo pipefail
umask 077

# Run from the repository root with the resolved production API environment.
# Requires Bash, curl, jq, git and pnpm. Defaults to inventory-only; set
# WALLET_GRANT_MIGRATE=true to apply. Nonzero exit means the operation or its
# serving-identity checks failed. Only aggregate evidence is published.
: "${VERCEL_TOKEN:?}"
: "${VERCEL_ORG_ID:?}"
: "${VERCEL_PROJECT_ID:?}"
: "${GH_TOKEN:?}"
: "${GITHUB_REPOSITORY:?}"
: "${WEB_API_ENV_FILE:?}"
: "${WALLET_GRANT_REPORT:?}"

apply=${WALLET_GRANT_MIGRATE:-false}
if [[ "$apply" != "true" && "$apply" != "false" ]]; then
  echo "::error::WALLET_GRANT_MIGRATE must be true or false."
  exit 1
fi

readonly grant_writer_commit=37e6bb51029f05ff1d7a7a6c28b03f139dfd067c
read_serving() {
  curl --fail --silent --show-error --max-time 30 \
  "https://api.vercel.com/v9/projects/${VERCEL_PROJECT_ID}?teamId=${VERCEL_ORG_ID}" \
  -H "Authorization: Bearer ${VERCEL_TOKEN}" \
  | jq -ce --arg project "$VERCEL_PROJECT_ID" --arg team "$VERCEL_ORG_ID" '
      select(.id == $project and .accountId == $team)
      | .targets.production
      | select(.readyState == "READY" and .target == "production")
      | select(.alias | index("api.okou.ai"))
      | {deploymentId: .id, commit: .meta.githubCommitSha}
      | select(.commit | test("^[0-9a-f]{40}$"))
    '
}
serving=$(read_serving)
serving_commit=$(jq -r '.commit' <<< "$serving")
comparison=$(curl --fail --silent --show-error --max-time 30 \
  "https://api.github.com/repos/${GITHUB_REPOSITORY}/compare/${grant_writer_commit}...${serving_commit}" \
  -H "Authorization: Bearer ${GH_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  | jq -er '.status')
if [[ "$comparison" != "ahead" && "$comparison" != "identical" ]]; then
  echo "::error::Serving API predates the Link grant metadata writer; migration must not run."
  exit 1
fi
echo "Link wallet migration serving artifact: $serving"

# Values are data, never shell code. This is the same resolved environment used
# by the API artifact, including its database, Link client and KMS key.
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" ]] && continue
  if [[ ! "$line" =~ ^[a-zA-Z_][a-zA-Z0-9_]*= ]]; then
    echo "::error::Invalid API environment file; migration must not run."
    exit 1
  fi
  export "${line?}"
done < "$WEB_API_ENV_FILE"
if [[ "$ENV" != "production" ]]; then
  echo "::error::Link grant migration requires the production API environment."
  exit 1
fi

migration_status=0
args=(--report "$WALLET_GRANT_REPORT")
if [[ "$apply" == "true" ]]; then
  args+=(--migrate)
fi
pnpm --dir turbo/apps/api exec tsx src/scripts/migrate-link-wallet-grants.ts \
  "${args[@]}" || migration_status=$?
serving_unchanged=false
if [[ "$migration_status" -eq 0 ]]; then
  current_serving=$(read_serving)
  if [[ "$current_serving" == "$serving" ]]; then
    serving_unchanged=true
  else
    echo "::error::Serving API changed during Link grant migration; recheck convergence."
    migration_status=1
  fi
fi
if [[ -f "$WALLET_GRANT_REPORT" ]]; then
  jq --argjson serving "$serving" \
    --argjson servingUnchanged "$serving_unchanged" \
    --arg operatorCommit "$(git rev-parse HEAD)" \
    '. + {serving: $serving, servingUnchanged: $servingUnchanged, operatorCommit: $operatorCommit}' \
    "$WALLET_GRANT_REPORT" > "${WALLET_GRANT_REPORT}.tmp"
  mv "${WALLET_GRANT_REPORT}.tmp" "$WALLET_GRANT_REPORT"
fi
exit "$migration_status"
