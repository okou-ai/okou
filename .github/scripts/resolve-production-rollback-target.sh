#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly CHAT_EVENT_FAILURE_REASON_READER_COMMIT=c093e0ffdab988d2a8a071809f90d87fa3e79f20
readonly CHAT_EVENT_FAILURE_REASON_READER_RELEASE=89c6a521944e2ac8550da424f164db08f4f80f0c
readonly BLANK_SANDBOX_STATUS_READER_COMMIT=febec8a3399be74b0f14a89cb9f42e39dd5ce69f
readonly OKOU_GOAL_RETIREMENT_COMMIT=6d391117e4fead19e2105136fb2792a6e77801d8
readonly OKOU_GOAL_SCHEMA_READER_COMMIT=2c231766e383b651867893852cfb47dcc78af0bd
readonly OKOU_GOAL_SCHEMA_REPAIR_COMMIT=077a9a644986e13bed4750796f91e55c4a876aad
readonly OKOU_GOAL_SCHEMA_RELEASE=4a4881bf84cb1d79723fd38c83e00f2215bb1e31
readonly OKOU_GOAL_RETIREMENT_RELEASE=1f68f182a2457ec3aea52d8063be2bd2d2263abd
readonly COMPUTER_USE_HOST_CLIENT_PRODUCT_DROP_COMMIT=669d0befc9a181e44e3f1f9e39093efddabcc0f8
readonly ORG_MEMBER_MORNING_BRIEF_ELIGIBILITY_DROP_COMMIT=6e1abbb785dc1613d0f5cd1b1dd80fae694abb46
readonly PREPARED_DOMAIN_TRIGGER_RELEASE=eb2f211a9af41450d0d5dad10c0c8ad12fac0a24
readonly MARKETING_PRIVACY_CLEANUP_READER_PATH=turbo/apps/api/src/signals/services/marketing-privacy-cleanup.service.ts

fail() {
  echo "::error::$*" >&2
  exit 1
}

require_env() {
  local name=$1
  if [ -z "${!name:-}" ]; then
    fail "Missing required environment variable: ${name}"
  fi
}

for name in \
  AWS_METAL_RUNNER_HOSTS \
  GH_TOKEN \
  GITHUB_OUTPUT \
  GITHUB_REPOSITORY \
  METAL_USER \
  TARGET_COMMIT \
  VERCEL_ORG_ID \
  VERCEL_PROJECT_ID \
  VERCEL_TOKEN; do
  require_env "$name"
done

if [[ ! "$TARGET_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  fail "target_commit must be a full lowercase SHA-1: ${TARGET_COMMIT}"
fi

git fetch --force --tags origin main
git cat-file -e "${TARGET_COMMIT}^{commit}"
if ! git merge-base --is-ancestor "$TARGET_COMMIT" origin/main; then
  fail "Target commit is not reachable from main: ${TARGET_COMMIT}"
fi
if ! git merge-base --is-ancestor \
  "$CHAT_EVENT_FAILURE_REASON_READER_COMMIT" "$TARGET_COMMIT"; then
  fail "Target commit predates the Chat Event failure-reason reader. The first compatible release is ${CHAT_EVENT_FAILURE_REASON_READER_RELEASE}."
fi

release_tags=$(git tag --points-at "$TARGET_COMMIT" | grep -E -- '-v[0-9]' || true)
if ! git merge-base --is-ancestor "$BLANK_SANDBOX_STATUS_READER_COMMIT" "$TARGET_COMMIT"; then
  fail "Target commit predates the blank sandbox status reader: ${BLANK_SANDBOX_STATUS_READER_COMMIT}."
fi
if [ -z "$release_tags" ]; then
  fail "Target commit has no release tags: ${TARGET_COMMIT}"
fi

# The API retirement boundary legitimately retains a pre-retirement Runner tag.
if ! git merge-base --is-ancestor "$OKOU_GOAL_RETIREMENT_COMMIT" "$TARGET_COMMIT"; then
  fail "Target commit predates the Okou Goal retirement boundary. The first compatible release is ${OKOU_GOAL_RETIREMENT_RELEASE} (API 1.571.1)."
fi

# Current main owns this API schema guard before S5 production contraction.
# Retained Runner tags have separate ancestry and artifact requirements below.
if ! git merge-base --is-ancestor "$OKOU_GOAL_SCHEMA_READER_COMMIT" "$TARGET_COMMIT" ||
  ! git merge-base --is-ancestor "$OKOU_GOAL_SCHEMA_REPAIR_COMMIT" "$TARGET_COMMIT"; then
  fail "Target commit lacks the combined S4 Goal schema compatibility boundary. The first verified compatible release is ${OKOU_GOAL_SCHEMA_RELEASE} (API 1.580.0)."
fi

# Rollback promotes artifacts without restoring schema, so an API target that
# still declares client_product names a dropped column in every insert,
# bare select and bare returning.
if ! git merge-base --is-ancestor \
  "$COMPUTER_USE_HOST_CLIENT_PRODUCT_DROP_COMMIT" "$TARGET_COMMIT"; then
  fail "Target commit predates the computer_use_hosts.client_product drop: ${COMPUTER_USE_HOST_CLIENT_PRODUCT_DROP_COMMIT}."
fi

# Same barrier for morning_brief_default_eligible_at: an API target that still
# declares it names a dropped column in every insert on org_members_metadata.
if ! git merge-base --is-ancestor \
  "$ORG_MEMBER_MORNING_BRIEF_ELIGIBILITY_DROP_COMMIT" "$TARGET_COMMIT"; then
  fail "Target commit predates the org_members_metadata.morning_brief_default_eligible_at drop: ${ORG_MEMBER_MORNING_BRIEF_ELIGIBILITY_DROP_COMMIT}."
fi

# Migration 1132 removes the remaining A-D business triggers. API rollback does
# not restore schema, so only already-released explicit writers are supported.
if ! git merge-base --is-ancestor "$PREPARED_DOMAIN_TRIGGER_RELEASE" "$TARGET_COMMIT"; then
  fail "Rollback target lacks prepared billing, OAuth and hosting writers; first supported release is ${PREPARED_DOMAIN_TRIGGER_RELEASE}."
fi

# #34296 introduced optional-storage cleanup before 1138 removed that helper.
# Resolve its first addition on canonical main, including after file deletion,
# so squash merging the preparation cannot turn an unmerged branch SHA into a
# permanent rollback floor. Missing/shallow history fails before artifact I/O.
privacy_cleanup_reader_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$MARKETING_PRIVACY_CLEANUP_READER_PATH" | sed -n '1p')
if [[ ! "$privacy_cleanup_reader_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged marketing privacy cleanup preparation on main."
fi
if ! git merge-base --is-ancestor "$privacy_cleanup_reader_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates marketing privacy storage cleanup preparation: ${privacy_cleanup_reader_commit}."
fi

deployments=$(curl -fsS --get "https://api.vercel.com/v6/deployments" \
  -H "Authorization: Bearer ${VERCEL_TOKEN}" \
  --data-urlencode "teamId=${VERCEL_ORG_ID}" \
  --data-urlencode "projectId=${VERCEL_PROJECT_ID}" \
  --data-urlencode "target=production" \
  --data-urlencode "state=READY" \
  --data-urlencode "meta-githubCommitSha=${TARGET_COMMIT}" \
  --data-urlencode "limit=100")

matches=$(jq -c --arg sha "$TARGET_COMMIT" '[
  (.deployments // [])[]
  | select(.meta.githubCommitSha == $sha)
  | select(.state == "READY")
  | select(.target == "production")
]' <<<"$deployments")
match_count=$(jq -r 'length' <<<"$matches")
if [ "$match_count" -ne 1 ]; then
  fail "Expected exactly one READY production API deployment for ${TARGET_COMMIT}, found ${match_count}."
fi
api_deployment_url="https://$(jq -r '.[0].url' <<<"$matches")"

. "${script_dir}/runner-image-target.sh"
runner_version=$(git show "${TARGET_COMMIT}:crates/runner/Cargo.toml" \
  | sed -nE 's/^version = "([^"]+)"/\1/p' \
  | head -1)
if [ -z "$runner_version" ]; then
  fail "Could not resolve Runner version from ${TARGET_COMMIT}."
fi

runner_tag=$(runner_image_release_tag "$runner_version")
runner_tag_commit=$(git rev-list -n 1 "$runner_tag" || true)
if [ -z "$runner_tag_commit" ] || ! git merge-base --is-ancestor "$runner_tag_commit" "$TARGET_COMMIT"; then
  fail "Runner release ${runner_tag} is not reachable from ${TARGET_COMMIT}."
fi
if ! git merge-base --is-ancestor "$BLANK_SANDBOX_STATUS_READER_COMMIT" "$runner_tag_commit"; then
  fail "Runner release ${runner_tag} predates the blank sandbox status reader: ${BLANK_SANDBOX_STATUS_READER_COMMIT}."
fi

runner_matrix=$("${script_dir}/runner-host-architecture-groups.sh" target-matrix)
runner_group_count=$(jq -r 'length' <<<"$runner_matrix")
if [ "$runner_group_count" -lt 1 ]; then
  fail "No production Runner host groups found."
fi

runner_assets=$(curl -fsSL \
  --retry 5 \
  --retry-delay 2 \
  --retry-max-time 60 \
  --retry-all-errors \
  -H "Authorization: token ${GH_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/tags/${runner_tag}" \
  | jq -r '.assets[].name')

runner_targets=$(jq -r '.[].target' <<<"$runner_matrix")
while IFS= read -r target; do
  asset_name=$(runner_image_release_asset_name "$runner_version" "$target")
  if ! grep -qx "$asset_name" <<<"$runner_assets"; then
    fail "Runner release ${runner_tag} is missing ${asset_name}."
  fi
done <<<"$runner_targets"

{
  echo "api_deployment_url=$api_deployment_url"
  echo "runner_matrix=$runner_matrix"
  echo "runner_tag=$runner_tag"
  echo "runner_version=$runner_version"
  echo "target_commit=$TARGET_COMMIT"
} >>"$GITHUB_OUTPUT"

echo "Release target: ${TARGET_COMMIT}"
printf '%s\n' "$release_tags"
echo "API target: ${api_deployment_url}"
echo "Runner target: ${runner_tag}"
jq . <<<"$runner_matrix"
