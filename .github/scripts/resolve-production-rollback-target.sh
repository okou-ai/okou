#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly BLANK_SANDBOX_STATUS_READER_COMMIT=febec8a3399be74b0f14a89cb9f42e39dd5ce69f
readonly PROVIDER_BALANCE_FAILURE_COMMIT=0367d976a87fe1251fcb9b6cfe545a8b24e4f2b6
# #36897 made chat_thread_drafts the only draft store and writes user_id on
# every draft row. Migration contract_chat_thread_drafts makes user_id and
# draft_user_message NOT NULL, so earlier APIs fail every draft save.
readonly CHAT_THREAD_DRAFT_CHILD_WRITER_COMMIT=4558c9fac46ce1a96a25745b477b32b70dab7ae6
# #36932 targets the (chat_thread_id, user_id) draft key and stopped mapping the
# chat_threads draft columns. Migration drop_chat_thread_draft_columns makes that
# pair the primary key and drops the columns, so earlier APIs fail draft saves
# and thread inserts.
readonly CHAT_THREAD_DRAFT_OWNER_KEY_COMMIT=7a187fa0a3fe2f23a134c7cdff66ee9c7e2bdb38
# #36984 stopped naming computer_use_command_audit_events.approval_outcome in
# audit INSERT and SELECT. Migration 1263 drops that column, so earlier APIs
# fail every Computer Use audit write.
readonly COMPUTER_USE_AUDIT_WRITER_COMMIT=cdeec36c168636b1a2e510e660eb6139c9c4e07a
# #36990 removed the chat search GIN pending-list maintenance, the only caller of
# public.pgstatginindex. Migration 1265 drops pgstattuple, so earlier APIs fail
# every chat search projection tick.
readonly CHAT_SEARCH_GIN_MAINTENANCE_REMOVAL_COMMIT=98b5515ae2874128734b19a17b96dc8c6c7afe47
# #37076 includes #37057's copy/device/reconciliation protocols and prepares
# SSH credential deletion alongside #37071's exact host-FK error handling.
# Earlier API writers cannot safely overlap their advisory-free replacements.
readonly ADVISORY_LOCK_PREPARATION_COMMIT=ee863a302a6c547f94e50ec4069f70910d68bee2
# #36945 made every non-empty chat thread snapshot response R2-only. API targets
# before it may still return inline data to an old header-less client.
readonly CHAT_THREAD_SNAPSHOT_R2_ONLY_COMMIT=3d93ff8d4b4a07a5888e3030e69b340f40da0ad4
# #37063 removed the last reader of agent_run_queue, which migration 1272
# drops. Earlier APIs still read it while promoting queued runs.
readonly QUEUED_RUN_PROMOTION_REMOVAL_COMMIT=84ac71914345b8360f3df43cc2cd47f0a8af7a23
# #37082 (release 3) moved steering onto chat events and stopped reading and
# writing active_input_deliveries and active_input_delivery_items, which
# migration 1273 drops. Earlier APIs reserve steered input in those tables.
readonly UNIFIED_CHAT_QUEUE_RELEASE_COMMIT=553fc566b7e9be2cd4a8c1de314d55939b99490a
# #37115 (release 4) added the steerable-inputs next and steered endpoints.
# Release 6 Runners and their Guests steer only through them, so an earlier API
# cannot serve a draining release 6 Runner after a rollback.
readonly RUNNER_STEER_ENDPOINTS_COMMIT=fd5104417a0cf41116ce9cb9c1aeb2fa3b5e14da
# #37242 retired video, voice and talking-avatar generation. Later APIs remove
# the completion paths for jobs accepted before it, so an earlier API would
# accept video jobs that can no longer complete after rolling forward.
readonly VIDEO_GENERATION_RETIREMENT_COMMIT=45b537a596a153a91b76c3bc7223187840f52775
readonly PUBLIC_BRAND_RETIREMENT_PATH=turbo/packages/db/src/migrations/1255_retire_public_brand.sql
readonly AGENT_RUN_HEARTBEAT_DROP_PATH=turbo/packages/db/src/migrations/1259_drop_agent_runs_last_heartbeat_at.sql
readonly PERSONAL_SUBSCRIPTION_ACCOUNT_ONLY_PATH=turbo/packages/db/src/migrations/1260_personal_subscription_account_only.sql
readonly CHAT_THREAD_SNAPSHOT_JSONB_DROP_PATH=turbo/packages/db/src/migrations/1261_drop_chat_thread_snapshot_jsonb.sql
readonly STRIPE_PORTAL_PURPOSE_ONLY_PATH=.github/rollback-floors/stripe-portal-purpose-only
readonly CHAT_EVENT_SCHEMA_HEADER_RETIRED_PATH=.github/rollback-floors/chat-event-schema-header-retired
readonly CHAT_EVENT_V8_PATH=.github/rollback-floors/chat-event-v8
readonly BROWSER_SESSION_MUTATIONS_PATH=.github/rollback-floors/browser-session-mutations
readonly RETIRED_PREFERENCE_COLUMNS_DROP_PATH=turbo/packages/db/src/migrations/1274_drop_retired_voice_reasoning_collection_columns.sql
readonly RETIRED_INTEGRATION_AGENT_TABLES_DROP_PATH=turbo/packages/db/src/migrations/1282_drop_retired_integration_agent_tables.sql
readonly VIDEO_MODEL_COLUMNS_DROP_PATH=turbo/packages/db/src/migrations/1283_drop_retired_video_model_columns.sql
readonly IMAGE_MODEL_THREAD_COLUMNS_DROP_PATH=turbo/packages/db/src/migrations/1287_drop_image_model_thread_columns.sql
readonly VIDEO_ENTITLEMENT_DROP_PATH=turbo/packages/db/src/migrations/1315_drop_retired_video_entitlement.sql
readonly RETIRED_MODEL_CONFIGURATION_COLUMNS_DROP_PATH=turbo/packages/db/src/migrations/1330_drop_retired_model_configuration_columns.sql
readonly CHAT_THREAD_PROVIDER_PIN_COLUMNS_DROP_PATH=turbo/packages/db/src/migrations/1332_drop_chat_thread_provider_pin_columns.sql
readonly DEAD_MODEL_PROVIDER_COLUMNS_DROP_PATH=turbo/packages/db/src/migrations/1333_drop_dead_model_provider_columns.sql
readonly CONNECTOR_CATALOG_RELEASE_2_PATH=turbo/packages/db/src/migrations/1334_connector_catalog_release_2_contraction.sql
readonly MODEL_ROUTE_STATE_RETIREMENT_PATH=turbo/packages/db/src/migrations/1338_retire_model_route_state.sql
readonly PI_STABLE_CONTEXT_RETIREMENT_PATH=turbo/packages/db/src/migrations/1343_retire_pi_stable_context.sql
readonly PI_DEBUG_TRACE_RETIREMENT_PATH=turbo/packages/db/src/migrations/1345_outstanding_the_hood.sql
readonly CONNECTOR_CATALOG_PAYLOAD_INDEPENDENT_PATH=turbo/packages/db/src/migrations/1348_connector_catalog_payload_independent_api.sql

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
if ! git merge-base --is-ancestor "$CHAT_THREAD_DRAFT_OWNER_KEY_COMMIT" "$TARGET_COMMIT"; then
  fail "Rollback target predates the chat thread draft owner key writer: ${CHAT_THREAD_DRAFT_OWNER_KEY_COMMIT}."
fi
if ! git merge-base --is-ancestor "$COMPUTER_USE_AUDIT_WRITER_COMMIT" "$TARGET_COMMIT"; then
  fail "Rollback target predates the computer-use audit approval column cutover: ${COMPUTER_USE_AUDIT_WRITER_COMMIT}."
fi
if ! git merge-base --is-ancestor "$CHAT_SEARCH_GIN_MAINTENANCE_REMOVAL_COMMIT" "$TARGET_COMMIT"; then
  fail "Rollback target predates the chat search GIN maintenance removal: ${CHAT_SEARCH_GIN_MAINTENANCE_REMOVAL_COMMIT}."
fi
if ! git merge-base --is-ancestor "$ADVISORY_LOCK_PREPARATION_COMMIT" "$TARGET_COMMIT"; then
  fail "Rollback target predates the advisory lock replacement protocols: ${ADVISORY_LOCK_PREPARATION_COMMIT}."
fi
if ! git merge-base --is-ancestor "$QUEUED_RUN_PROMOTION_REMOVAL_COMMIT" "$TARGET_COMMIT"; then
  fail "Rollback target predates the queued run promotion removal: ${QUEUED_RUN_PROMOTION_REMOVAL_COMMIT}."
fi
if ! git merge-base --is-ancestor "$UNIFIED_CHAT_QUEUE_RELEASE_COMMIT" "$TARGET_COMMIT"; then
  fail "Rollback target predates the unified chat queue release: ${UNIFIED_CHAT_QUEUE_RELEASE_COMMIT}."
fi
if ! git merge-base --is-ancestor "$RUNNER_STEER_ENDPOINTS_COMMIT" "$TARGET_COMMIT"; then
  fail "Rollback target predates the runner steer endpoints: ${RUNNER_STEER_ENDPOINTS_COMMIT}."
fi
if ! git merge-base --is-ancestor "$VIDEO_GENERATION_RETIREMENT_COMMIT" "$TARGET_COMMIT"; then
  fail "Rollback target predates the video generation retirement: ${VIDEO_GENERATION_RETIREMENT_COMMIT}."
fi

# The preparatory catalog release stops writing/reading payload and removes it
# from the runtime ORM. Resolve its merged commit, not a branch SHA. Once new
# entries have NULL payload, payload-dependent APIs are no longer supported
# rollback targets; the later physical DROP requires this same floor.
connector_catalog_payload_independent_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$CONNECTOR_CATALOG_PAYLOAD_INDEPENDENT_PATH" | sed -n '1p')
if [[ ! "$connector_catalog_payload_independent_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged connector catalog payload-independent API on main."
fi
if ! git merge-base --is-ancestor "$connector_catalog_payload_independent_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the connector catalog payload-independent API: ${connector_catalog_payload_independent_commit}."
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

if ! git merge-base --is-ancestor "$CHAT_THREAD_SNAPSHOT_R2_ONLY_COMMIT" "$TARGET_COMMIT"; then
  fail "Rollback target predates the R2-only chat thread snapshot API: ${CHAT_THREAD_SNAPSHOT_R2_ONLY_COMMIT}."
fi

# Migration 1259 drops agent_runs.last_heartbeat_at. Earlier APIs still declare
# it, so every agent_runs insert, bare select and bare returning names it.
agent_run_heartbeat_drop_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$AGENT_RUN_HEARTBEAT_DROP_PATH" | sed -n '1p')
if [[ ! "$agent_run_heartbeat_drop_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged agent_runs heartbeat column drop on main."
fi
if ! git merge-base --is-ancestor "$agent_run_heartbeat_drop_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the agent_runs heartbeat column drop: ${agent_run_heartbeat_drop_commit}."
fi

# Migration 1260 deletes the personal subscription secrets mirror. Earlier APIs
# read that mirror, so they treat every personal Claude/Codex subscription as
# unavailable and their legacy import paths diverge from the account store.
personal_subscription_account_only_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$PERSONAL_SUBSCRIPTION_ACCOUNT_ONLY_PATH" | sed -n '1p')
if [[ ! "$personal_subscription_account_only_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged personal subscription account-only migration on main."
fi
if ! git merge-base --is-ancestor "$personal_subscription_account_only_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the personal subscription account-only store: ${personal_subscription_account_only_commit}."
fi

# Once the snapshot JSONB column is dropped, earlier APIs still name it in
# compaction writes (and older ones read it). Resolve the squash-merged commit
# from the migration so no branch-only SHA can become a rollback floor.
snapshot_jsonb_drop_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$CHAT_THREAD_SNAPSHOT_JSONB_DROP_PATH" | sed -n '1p')
if [[ ! "$snapshot_jsonb_drop_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged chat thread snapshot JSONB drop on main."
fi
if ! git merge-base --is-ancestor "$snapshot_jsonb_drop_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the chat thread snapshot JSONB drop: ${snapshot_jsonb_drop_commit}."
fi

# Removing the Stripe Portal brand metadata makes pre-cutover APIs unable to
# find the existing configuration. Resolve the cutover from the canonical main
# commit, not a branch-only SHA, before selecting a rollback API artifact.
stripe_portal_purpose_only_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$STRIPE_PORTAL_PURPOSE_ONLY_PATH" | sed -n '1p')
if [[ ! "$stripe_portal_purpose_only_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged Stripe Portal purpose-only cutover on main."
fi
if ! git merge-base --is-ancestor "$stripe_portal_purpose_only_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the Stripe Portal purpose-only cutover: ${stripe_portal_purpose_only_commit}."
fi

# Header-free Chat Event clients stop sending X-Chat-Event-Schema-Version.
# Earlier APIs require it and answer every Chat Event read with 400, so an API
# rollback below the canonical main commit that retired it breaks chat sync.
chat_event_schema_header_retired_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$CHAT_EVENT_SCHEMA_HEADER_RETIRED_PATH" | sed -n '1p')
if [[ ! "$chat_event_schema_header_retired_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged Chat Event schema header retirement on main."
fi
if ! git merge-base --is-ancestor "$chat_event_schema_header_retired_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the Chat Event schema header retirement: ${chat_event_schema_header_retired_commit}."
fi

# Migration 1274 drops chat_threads.reasoning_effort,
# org_members_metadata.voice_input_model and
# morning_brief_native_occurrences.collection_facts. Earlier APIs still declare
# them, so every insert, bare select and bare returning on those tables names
# the dropped columns.
retired_preference_columns_drop_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$RETIRED_PREFERENCE_COLUMNS_DROP_PATH" | sed -n '1p')
if [[ ! "$retired_preference_columns_drop_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged retired preference column drop on main."
fi
if ! git merge-base --is-ancestor "$retired_preference_columns_drop_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the retired preference column drop: ${retired_preference_columns_drop_commit}."
fi

# Migration 1283 drops selected_video_model from chat_threads,
# org_members_metadata, agent_runs and chat_thread_events and removes the
# video_model_updated event kind. Earlier APIs still declare the columns, so
# every insert, bare select and bare returning on those tables names them. This
# floor also covers #37256, the first API that stopped reading the columns.
video_model_columns_drop_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$VIDEO_MODEL_COLUMNS_DROP_PATH" | sed -n '1p')
if [[ ! "$video_model_columns_drop_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged video model column drop on main."
fi
if ! git merge-base --is-ancestor "$video_model_columns_drop_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the video model column drop: ${video_model_columns_drop_commit}."
fi

# Migration 1287 drops selected_image_model from chat_threads and
# chat_thread_events and removes the image_model_updated event kind. Earlier
# APIs still declare the columns, so every insert, bare select and bare
# returning on those tables names them, and their raw thread-event insert names
# selected_image_model explicitly.
image_model_thread_columns_drop_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$IMAGE_MODEL_THREAD_COLUMNS_DROP_PATH" | sed -n '1p')
if [[ ! "$image_model_thread_columns_drop_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged image model thread column drop on main."
fi
if ! git merge-base --is-ancestor "$image_model_thread_columns_drop_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the image model thread column drop: ${image_model_thread_columns_drop_commit}."
fi

# Migration 1315 drops the retired video entitlement. Earlier APIs still name
# it in entitlement reads/writes, model bootstrap and reward wallet creation.
video_entitlement_drop_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$VIDEO_ENTITLEMENT_DROP_PATH" | sed -n '1p')
if [[ ! "$video_entitlement_drop_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged video entitlement column drop on main."
fi
if ! git merge-base --is-ancestor "$video_entitlement_drop_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the video entitlement column drop: ${video_entitlement_drop_commit}."
fi

# Migration 1330 drops agents.model_provider_id, agents.selected_model,
# agents.prefer_personal_provider, model_providers.secret_id and
# org_plan_entitlements.support_byok. Every earlier API still declares them, so
# agent and entitlement reads and writes name the dropped columns. This floor
# descends from, and so supersedes, the earlier run model schema contraction.
retired_model_configuration_columns_drop_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$RETIRED_MODEL_CONFIGURATION_COLUMNS_DROP_PATH" | sed -n '1p')
if [[ ! "$retired_model_configuration_columns_drop_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged retired model configuration column drop on main."
fi
if ! git merge-base --is-ancestor "$retired_model_configuration_columns_drop_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the retired model configuration column drop: ${retired_model_configuration_columns_drop_commit}."
fi

# Migration 1332 drops the legacy chat_threads provider pin columns
# (model_provider_id, model_provider_type, model_provider_credential_scope).
# Every earlier API still declares them, so its chat thread inserts and bare
# selects name the dropped columns.
chat_thread_provider_pin_columns_drop_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$CHAT_THREAD_PROVIDER_PIN_COLUMNS_DROP_PATH" | sed -n '1p')
if [[ ! "$chat_thread_provider_pin_columns_drop_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged chat thread provider pin column drop on main."
fi
if ! git merge-base --is-ancestor "$chat_thread_provider_pin_columns_drop_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the chat thread provider pin column drop: ${chat_thread_provider_pin_columns_drop_commit}."
fi
# Migration 1333 drops model_providers.auth_method, model_providers.is_default,
# model_providers.selected_model, model_routes.price_tier and
# run_model_catalog.is_system_default. Every earlier API still declares and
# selects them in personal subscription and model catalog reads, so it cannot
# serve after 1333. This floor descends from the 1332 floor.
dead_model_provider_columns_drop_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$DEAD_MODEL_PROVIDER_COLUMNS_DROP_PATH" | sed -n '1p')
if [[ ! "$dead_model_provider_columns_drop_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged dead model provider column drop on main."
fi
if ! git merge-base --is-ancestor "$dead_model_provider_columns_drop_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the dead model provider column drop: ${dead_model_provider_columns_drop_commit}."
fi

# Migration 1334 is the connector catalog Release 2 contraction. It drops the
# legacy catalog sync state, active snapshot, compatibility evaluation and
# runtime projection tables plus the redundant pointer and entry columns. Every
# earlier API still writes them from its catalog synchronizer and preview seed,
# and APIs before Release 1 (#37861) also read them in business paths, so no
# earlier API can serve after 1334. This floor descends from the 1333 floor.
connector_catalog_release_2_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$CONNECTOR_CATALOG_RELEASE_2_PATH" | sed -n '1p')
if [[ ! "$connector_catalog_release_2_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged connector catalog Release 2 contraction on main."
fi
if ! git merge-base --is-ancestor "$connector_catalog_release_2_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the connector catalog Release 2 contraction: ${connector_catalog_release_2_commit}."
fi

# Migration 1338 drops built_in_model_candidate_cooldown, the frozen OAuth
# copies on model_providers and model_provider_auth_sessions.sandbox_id, and
# tightens the service tier and Pi route class checks. Every earlier API reads
# the cooldown table while resolving the Auto route and selects every column of
# both provider tables, so it cannot serve after 1338. This floor descends from
# the 1334 floor.
model_route_state_retirement_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$MODEL_ROUTE_STATE_RETIREMENT_PATH" | sed -n '1p')
if [[ ! "$model_route_state_retirement_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged model route state retirement on main."
fi
if ! git merge-base --is-ancestor "$model_route_state_retirement_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the model route state retirement: ${model_route_state_retirement_commit}."
fi

# Migration 1343 drops the Pi stable-context heads, artifacts, artifact
# resources and resource snapshot tables, and renames the generation and
# publication tables to storage_publication_generations/tokens. Every earlier
# API writes the old tables on Agent instructions, Workflow and Storage
# publication paths, so it cannot serve after 1343. This floor descends from
# the 1338 floor.
pi_stable_context_retirement_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$PI_STABLE_CONTEXT_RETIREMENT_PATH" | sed -n '1p')
if [[ ! "$pi_stable_context_retirement_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged Pi stable-context retirement on main."
fi
if ! git merge-base --is-ancestor "$pi_stable_context_retirement_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the Pi stable-context retirement: ${pi_stable_context_retirement_commit}."
fi

# Earlier APIs name the retired per-run trace column in launch, detail and
# completion queries (including implicit Drizzle projections).
pi_debug_trace_retirement_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$PI_DEBUG_TRACE_RETIREMENT_PATH" | sed -n '1p')
if [[ ! "$pi_debug_trace_retirement_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged Pi debug trace retirement on main."
fi
if ! git merge-base --is-ancestor "$pi_debug_trace_retirement_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the Pi debug trace retirement: ${pi_debug_trace_retirement_commit}."
fi

# Chat Event V8 removes eight event types and two context types. Earlier APIs
# serve V7 rows and snapshots that V8 App builds reject, so no earlier API can
# serve chat reads.
chat_event_v8_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$CHAT_EVENT_V8_PATH" | sed -n '1p')
if [[ ! "$chat_event_v8_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged Chat Event V8 migration on main."
fi
if ! git merge-base --is-ancestor "$chat_event_v8_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the Chat Event V8 migration: ${chat_event_v8_commit}."
fi

# Browser viewer mutations send an empty body. APIs predating this contract
# still require a request event ID, so they cannot serve the current App.
browser_session_mutations_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$BROWSER_SESSION_MUTATIONS_PATH" | sed -n '1p')
if [[ ! "$browser_session_mutations_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged Browser session mutation contract on main."
fi
if ! git merge-base --is-ancestor "$browser_session_mutations_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the Browser session mutation contract: ${browser_session_mutations_commit}."
fi

# Migration 1282 drops the retired integration agent preference and
# self-hosted Telegram tables, feishu_org_installations.default_agent_id,
# telegram_chat_thread_routes.telegram_user_link_id and
# telegram_messages.installation_id. Earlier APIs still declare those columns,
# so their Telegram message and route inserts name the dropped columns.
retired_integration_agent_tables_drop_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$RETIRED_INTEGRATION_AGENT_TABLES_DROP_PATH" | sed -n '1p')
if [[ ! "$retired_integration_agent_tables_drop_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged retired integration agent table drop on main."
fi
if ! git merge-base --is-ancestor "$retired_integration_agent_tables_drop_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the retired integration agent table drop: ${retired_integration_agent_tables_drop_commit}."
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
