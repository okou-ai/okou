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
readonly PERSONAL_SUBSCRIPTION_PRIORITY_COMMIT=8a5e1299b4d26bd114ccec017b84b7a83fb4a164
readonly ORG_MEMBER_MORNING_BRIEF_ELIGIBILITY_DROP_COMMIT=6e1abbb785dc1613d0f5cd1b1dd80fae694abb46
readonly HOSTED_PUBLICATION_RUNTIME_COMMIT=f205ec54fc463f43b1106a3659e5d6a8c979cab8
readonly PREPARED_DOMAIN_TRIGGER_RELEASE=eb2f211a9af41450d0d5dad10c0c8ad12fac0a24
# #36301 was the last of the four explicit API-writer preparations for #33749
# to land on main. Older APIs still need the artifact/chat triggers removed by 1205.
readonly ARTIFACT_CHAT_TRIGGER_WRITERS_COMMIT=065f970bbb8c21c10ef709495d5824d0a6183e50
readonly MARKETING_PRIVACY_CLEANUP_READER_PATH=turbo/apps/api/src/signals/services/marketing-privacy-cleanup.service.ts
readonly CHAT_THREAD_SNAPSHOT_R2_READER_PATH=turbo/apps/api/src/signals/services/chat-thread-snapshot-object.ts
readonly AGENTPHONE_PUBLIC_BRAND_DROP_PATH=turbo/packages/db/src/migrations/1228_drop_agentphone_public_brand.sql
readonly PUBLIC_BRAND_RETIREMENT_PATH=turbo/packages/db/src/migrations/1249_retire_public_brand.sql
readonly PROVIDER_BALANCE_FAILURE_COMMIT=0367d976a87fe1251fcb9b6cfe545a8b24e4f2b6
readonly PI_LAUNCH_CONFIG_VERSIONS_READER_COMMIT=8d8f3a3e14d23f7471e0773bd9acb988f59217af
readonly PI_SESSION_CONSTRUCTION_READER_COMMIT=322efb6d72508e15b90dc788100a776da1485751
# #36885 stopped GIN maintenance of the keyword-only chat search index that 1239 drops.
readonly CHAT_SEARCH_TSV_GIN_MAINTENANCE_COMMIT=32e48c76fea61c39d0962762e1bc2e0aa5a5cab0
# #36703 (API 1.676.0) removed the last reader of chat_event_write_control.
readonly CHAT_EVENT_WRITE_CONTROL_READER_REMOVAL_COMMIT=15117da7815a192e2f08ca46a2084129cb7fc48f
# #36897 made chat_thread_drafts the only draft store and writes user_id on
# every draft row. Migration contract_chat_thread_drafts makes user_id and
# draft_user_message NOT NULL, so earlier APIs fail every draft save.
readonly CHAT_THREAD_DRAFT_CHILD_WRITER_COMMIT=4558c9fac46ce1a96a25745b477b32b70dab7ae6

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

# API rollback does not restore schema. Preceding binaries implicitly select
# the retired hosted-publication version columns; retained Runner tags do not.
if ! git merge-base --is-ancestor \
  "$HOSTED_PUBLICATION_RUNTIME_COMMIT" "$TARGET_COMMIT"; then
  fail "Rollback target predates hosted publication version-column retirement: ${HOSTED_PUBLICATION_RUNTIME_COMMIT}."
fi

# A/B runtime identity and personal precedence must survive allowed rollback.
# D raises this to the accepted C writer boundary before policy conversion.
if ! git merge-base --is-ancestor \
  "$PERSONAL_SUBSCRIPTION_PRIORITY_COMMIT" "$TARGET_COMMIT"; then
  fail "Target commit predates personal subscription priority: ${PERSONAL_SUBSCRIPTION_PRIORITY_COMMIT}."
fi

# Migration 1132 removes the remaining A-D business triggers. API rollback does
# not restore schema, so only already-released explicit writers are supported.
if ! git merge-base --is-ancestor "$PREPARED_DOMAIN_TRIGGER_RELEASE" "$TARGET_COMMIT"; then
  fail "Rollback target lacks prepared billing, OAuth and hosting writers; first supported release is ${PREPARED_DOMAIN_TRIGGER_RELEASE}."
fi

# Migration 1206 drops eleven artifact/chat triggers before the new API deploys.
# A rollback keeps the contracted schema, so pre-writer API binaries are unsafe.
if ! git merge-base --is-ancestor "$ARTIFACT_CHAT_TRIGGER_WRITERS_COMMIT" "$TARGET_COMMIT"; then
  fail "Rollback target predates artifact/chat explicit writers: ${ARTIFACT_CHAT_TRIGGER_WRITERS_COMMIT} (first supported release: 3a2a331d50503a73407029ed9074e7d6930778da, API 1.664.0)."
fi

# #34296 introduced optional-storage cleanup before 1139 removed that helper.
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

# Snapshot compaction retires the JSONB payload as soon as the R2-capable API
# serves. Resolve the canonical main introduction so squash merging the reader
# cannot leave a branch-only SHA as the permanent rollback floor.
snapshot_r2_reader_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$CHAT_THREAD_SNAPSHOT_R2_READER_PATH" | sed -n '1p')
if [[ ! "$snapshot_r2_reader_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged chat thread snapshot R2 reader on main."
fi
if ! git merge-base --is-ancestor "$snapshot_r2_reader_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the chat thread snapshot R2 reader: ${snapshot_r2_reader_commit}."
fi

# Migration 1228 drops the four AgentPhone public_brand columns. Every earlier
# API, including those after #36722, still declares them and names them in
# inserts and bare selects. Resolve the migration's canonical main introduction
# so squash merging cannot leave a branch-only SHA as the rollback floor.
agentphone_public_brand_drop_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$AGENTPHONE_PUBLIC_BRAND_DROP_PATH" | sed -n '1p')
if [[ ! "$agentphone_public_brand_drop_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged AgentPhone public_brand drop on main."
fi
if ! git merge-base --is-ancestor "$agentphone_public_brand_drop_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the AgentPhone public_brand drop: ${agentphone_public_brand_drop_commit}."
fi

# Migration 1249 drops the remaining non-link public_brand columns (including
# github_installations.setup_public_brand) and renames the hosted/artifact/shared
# link-layout column to link_layout_segment. Every earlier API, including those
# with the Phase 1 okou defaults, still declares these columns and names them in
# inserts and bare selects, so it fails with 42703. Resolve the migration's
# canonical main introduction so squash merging cannot leave a branch-only SHA.
public_brand_retirement_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$PUBLIC_BRAND_RETIREMENT_PATH" | sed -n '1p')
if [[ ! "$public_brand_retirement_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged public_brand retirement on main."
fi
if ! git merge-base --is-ancestor "$public_brand_retirement_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the public_brand retirement: ${public_brand_retirement_commit}."
fi

# Terminal presentation trusts the stored cause without repairing old records.
# Keep the owner-aware reader and structured Runner writer available for new runs.
if ! git merge-base --is-ancestor "$PROVIDER_BALANCE_FAILURE_COMMIT" "$TARGET_COMMIT"; then
  fail "Rollback target predates owner-aware provider balance failures: ${PROVIDER_BALANCE_FAILURE_COMMIT}."
fi

# The API writes `requiredPiAgentRuntimeVersion` and `minCliVersion` into the
# persisted Pi launch config, and `piApiFirstTurnConfigSchema` is strict, so an
# API that predates the tolerant reader rejects every queued payload carrying
# them at claim time. Retained Runner tags are unaffected: the guest ignores
# unknown launch-config fields.
if ! git merge-base --is-ancestor "$PI_LAUNCH_CONFIG_VERSIONS_READER_COMMIT" "$TARGET_COMMIT"; then
  fail "Rollback target predates the Pi launch-config version reader: ${PI_LAUNCH_CONFIG_VERSIONS_READER_COMMIT}."
fi

# The API now writes a session-construction digest into the same strict queued
# launch config. Only API targets with its reader can claim those runs; retained
# Runner tags remain independent because the guest ignores unknown fields.
if ! git merge-base --is-ancestor "$PI_SESSION_CONSTRUCTION_READER_COMMIT" "$TARGET_COMMIT"; then
  fail "Rollback target predates the Pi session-construction digest reader: ${PI_SESSION_CONSTRUCTION_READER_COMMIT}."
fi

# Migration 1239 drops chat_event_search_messages_tsv_idx. Earlier APIs name it
# in chat search GIN maintenance, so every projection tick fails with 42P01.
if ! git merge-base --is-ancestor "$CHAT_SEARCH_TSV_GIN_MAINTENANCE_COMMIT" "$TARGET_COMMIT"; then
  fail "Rollback target predates the keyword-only chat search GIN index drop: ${CHAT_SEARCH_TSV_GIN_MAINTENANCE_COMMIT}."
fi

# The draft contraction requires every draft row to carry its owner and a
# document. Only APIs with the child-only draft writer satisfy that.
if ! git merge-base --is-ancestor "$CHAT_THREAD_DRAFT_CHILD_WRITER_COMMIT" "$TARGET_COMMIT"; then
  fail "Rollback target predates the chat thread draft child-only writer: ${CHAT_THREAD_DRAFT_CHILD_WRITER_COMMIT}."
fi

# Migration 1245 drops chat_event_write_control. APIs 1.674.0 and 1.675.0 read
# it on every chat event write, so only APIs from Release 2 on can serve.
if ! git merge-base --is-ancestor "$CHAT_EVENT_WRITE_CONTROL_READER_REMOVAL_COMMIT" "$TARGET_COMMIT"; then
  fail "Rollback target predates the chat_event_write_control reader removal: ${CHAT_EVENT_WRITE_CONTROL_READER_REMOVAL_COMMIT}."
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
