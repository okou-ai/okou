#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly BLANK_SANDBOX_STATUS_READER_COMMIT=febec8a3399be74b0f14a89cb9f42e39dd5ce69f
readonly PROVIDER_BALANCE_FAILURE_COMMIT=0367d976a87fe1251fcb9b6cfe545a8b24e4f2b6
# #36897 made chat_thread_drafts the only draft store and writes user_id on
# every draft row. Migration contract_chat_thread_drafts makes user_id and
# draft_user_message NOT NULL, so earlier APIs fail every draft save.
readonly CHAT_THREAD_DRAFT_CHILD_WRITER_COMMIT=4558c9fac46ce1a96a25745b477b32b70dab7ae6
readonly PUBLIC_BRAND_RETIREMENT_PATH=turbo/packages/db/src/migrations/1255_retire_public_brand.sql

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
release_tags=$(git tag --points-at "$TARGET_COMMIT" | grep -E -- '-v[0-9]' || true)
if [ -z "$release_tags" ]; then
  fail "Target commit has no release tags: ${TARGET_COMMIT}"
fi

# The draft contraction requires every draft row to carry its owner and a
# document. Only APIs with the child-only draft writer satisfy that.
if ! git merge-base --is-ancestor "$CHAT_THREAD_DRAFT_CHILD_WRITER_COMMIT" "$TARGET_COMMIT"; then
  fail "Rollback target predates the chat thread draft child-only writer: ${CHAT_THREAD_DRAFT_CHILD_WRITER_COMMIT}."
fi

# Migration 1255 drops the remaining non-link public_brand columns and renames
# five persisted link-layout columns. Earlier APIs implicitly name the retired
# columns in INSERT/SELECT, so rollback below the canonical migration is unsafe.
public_brand_retirement_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$PUBLIC_BRAND_RETIREMENT_PATH" | sed -n '1p')
if [[ ! "$public_brand_retirement_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged public_brand retirement on main."
fi
if ! git merge-base --is-ancestor "$public_brand_retirement_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the public_brand retirement: ${public_brand_retirement_commit}."
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
if ! git merge-base --is-ancestor "$PROVIDER_BALANCE_FAILURE_COMMIT" "$runner_tag_commit"; then
  fail "Runner release ${runner_tag} predates structured provider balance failures: ${PROVIDER_BALANCE_FAILURE_COMMIT}."
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
