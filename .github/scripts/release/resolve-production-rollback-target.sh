#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly BLANK_SANDBOX_STATUS_READER_COMMIT=febec8a3399be74b0f14a89cb9f42e39dd5ce69f
readonly PROVIDER_BALANCE_FAILURE_COMMIT=0367d976a87fe1251fcb9b6cfe545a8b24e4f2b6
# #43433 publishes each default Agent with its reference and never adopts an
# existing custom Agent. Atomic configuration updates rely on that identity.
readonly IMMUTABLE_DEFAULT_AGENT_WRITER_COMMIT=01d21f7c5857795104c27cd54e724f2ced2d683e
# #40232 installs Pi's runtime with Runner. URL-free APIs cannot serve earlier
# Guests during the Runner-first rollback interval, even for an older API target.
readonly BUNDLED_ONLY_CLI_RUNNER_COMMIT=dfff1605013103371cd90962ee5b54c80fc93140
# #40206 migrates encrypted Link grants before requiring their metadata. Old
# writers must never recreate the retired shape after the migration.
readonly LINK_WALLET_GRANT_WRITER_COMMIT=37e6bb51029f05ff1d7a7a6c28b03f139dfd067c
# Pair-free Guest telemetry can outlive Runner rollback. The receiving API must
# retain #41242's structured-only reader during independent Runner/API rollback.
readonly STRUCTURED_DISK_TELEMETRY_READER_COMMIT=e01702c7d762b5d2a76d557db77ccaf19c4f95c8
# Final receiving cleanup must not restart a Runner whose embedded Guest still
# emits the retired disk pair. Check the selected Runner tag independently.
readonly PAIR_FREE_DISK_TELEMETRY_WRITER_COMMIT=625c4607ccdcd2d46a5c7227f61419928035e13f
# Source-only finalizing readers require an API that always emits the UUID.
readonly FINALIZING_SOURCE_API_WRITER_COMMIT=968063848aea8cf54acd6f56facdf7cdcbd79051
# Runner is selected independently and must understand the source-bearing wire shape.
readonly FINALIZING_SOURCE_RUNNER_READER_COMMIT=b610ff61043274157618e3925b13a66dc56ef84b
# #41808 stopped naming runner_state.wss_ingress_service_active in ORM statements
# and removed every runner_wss_tickets reader and writer. Migrations
# drop_runner_state_wss_ingress and drop_runner_wss_tickets drop that storage,
# so earlier APIs fail Runner state and WSS ticket SQL.
readonly RUNNER_STATE_WSS_INGRESS_FREE_COMMIT=430cb92b5431e1554d0a1dceed6d9cfb27762921
# #42935 removed retired Data job mappings and pricing columns from API SQL.
# The later storage contraction must not restore an API that still names them.
readonly MANAGED_DATA_RUNTIME_RETIREMENT_COMMIT=b220a504c5e633de162791f1216c4458188ffe72
# #42572 removed invoice-paid automation SQL before its dedicated tables retire.
# Preserve the shared Stripe Connect deauthorization receiver from that release.
readonly STRIPE_INVOICE_PAID_RETIREMENT_COMMIT=190cdfba6440b50469117758156616447d707b81
# #43148 removed every citation-table reader and writer before its contraction.
readonly RUN_OUTPUT_MEMORY_CITATION_RETIREMENT_COMMIT=26bacab4693d32e4a4453dce5c84e565d7129b9c
# #43797 stopped naming org_members_metadata.translation_language and
# proactive_planning_enabled. Migration drop_retired_member_preference_columns
# drops them, so earlier APIs fail every member preference statement.
readonly MEMBER_PREFERENCE_RETIREMENT_COMMIT=94389e2203aaa62408b780156c2cf8f9a9cc5414
# DAV catalog rules require #43517's API/Runner method support and rollout.
readonly DAV_FIREWALL_READER_COMMIT=c8de6212dc54a5aae0d4658acf1afa6a35f939ab
# #43667 prepared reference-only Workflow claims and current-content downloads.
# API and Runner can roll back independently; both artifacts must contain it.
readonly WORKFLOW_DOWNLOAD_READER_COMMIT=6fd29050029b5a521f75d0500e9876a11649afe6
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
# #38096 permanently moved OpenRouter Pi captures to generation 5. Current
# API/Runner/CLI readers no longer execute unversioned contexts, so a rollback
# must not restore the generation 1 writer or its disabled-switch path.
readonly PI_OPENROUTER_VERSIONED_WRITER_COMMIT=a635ec3afa20cdb5df9c8125afe6cec24ef53e16
# #38477 captures personal runtime and independent managed usage provenance.
# Final capture checks reject earlier personal writers; normalized histories
# must never regain selected-dependent usage interpretation after rollback.
readonly MODEL_EXECUTION_CAPTURE_WRITER_COMMIT=b6919718b6d856dfa3a7c500b6e899dd3fde7674
# #38431 removed chat_threads.provenance from runtime and root-schema SQL.
# The later physical contraction cannot serve earlier implicit column lists.
readonly CHAT_THREAD_PROVENANCE_REMOVAL_COMMIT=9fa8da0d3d25e75e0dcfdd3292e1e2bbe6fe262f
readonly PUBLIC_BRAND_RETIREMENT_PATH=turbo/packages/db/src/migrations/1255_retire_public_brand.sql
readonly AGENT_RUN_HEARTBEAT_DROP_PATH=turbo/packages/db/src/migrations/1259_drop_agent_runs_last_heartbeat_at.sql
readonly PERSONAL_SUBSCRIPTION_ACCOUNT_ONLY_PATH=turbo/packages/db/src/migrations/1260_personal_subscription_account_only.sql
readonly CHAT_THREAD_SNAPSHOT_JSONB_DROP_PATH=turbo/packages/db/src/migrations/1261_drop_chat_thread_snapshot_jsonb.sql
readonly STRIPE_PORTAL_PURPOSE_ONLY_PATH=.github/rollback-floors/stripe-portal-purpose-only
readonly CHAT_EVENT_SCHEMA_HEADER_RETIRED_PATH=.github/rollback-floors/chat-event-schema-header-retired
readonly CHAT_EVENT_V8_PATH=.github/rollback-floors/chat-event-v8
# #41860 always reads Agent instructions from the DB, without the retired
# execution-context marker. Earlier APIs may select the deleted Storage instead.
readonly AGENT_INSTRUCTIONS_DB_ONLY_READER_COMMIT=b4a90a6b3f79527f91836df6a2bcc8fe81c622e8
# #43808 explicitly clears callbacks, queue rows and usage links before Run deletion.
readonly RUN_REFERENCE_PREPARATION_PATH=.github/rollback-floors/run-reference-preparation
# #41393 prepared inline file injection before release 2 emits it.
readonly AGENT_INSTRUCTIONS_RUNNER_READER_COMMIT=da0dc9cd1b21ecdd91200fb1cad8600ee5fdfd29
# #44189 prepared immutable content publishers and the hash-addressed Runner reader.
# Rollback starts Runner before API, so both artifacts must retain that preparation.
readonly CONTENT_BUNDLE_PREPARATION_COMMIT=fc8f99468cc7946843620ff655ae22c09f9cb2ae
readonly CONTENT_BUNDLE_REFERENCE_ONLY_API_PATH=.github/rollback-floors/content-bundle-reference-only-api
readonly CONTENT_BUNDLE_ARCHIVE_READER_PATH=.github/rollback-floors/content-bundle-archive-reader
readonly BROWSER_SESSION_MUTATIONS_PATH=.github/rollback-floors/browser-session-mutations
readonly HOSTED_SITE_URL_ROUTING_PATH=.github/rollback-floors/hosted-site-url-routing
readonly DESKTOP_MIGRATION_HOP_PATH=turbo/apps/api/src/signals/services/desktop-electron-migration-release.ts
readonly COMPUTER_USE_COMMAND_NOTIFICATIONS_PATH=.github/rollback-floors/computer-use-command-notifications
readonly COMPUTER_USE_HOST_SESSION_ONLY_PATH=turbo/packages/db/src/runtime/computer-use-host.ts
readonly NATIVE_BRIEF_MEMBER_RUNTIME_PATH=turbo/packages/db/src/runtime/org-members-metadata.ts
readonly SESSION_STORAGE_MOUNT_RUNTIME_PATH=turbo/packages/db/src/runtime/agent-session.ts
readonly SESSION_CONVERSATION_RUNTIME_PATH=.github/rollback-floors/session-conversation-runtime
readonly WECHAT_WORKFLOWS_ONLY_PATH=.github/rollback-floors/wechat-workflows-only
readonly CONNECTOR_RESOURCE_SPLIT_PATH=.github/rollback-floors/connector-resource-split
readonly CONNECTOR_DIAGNOSTIC_TARGETS_PATH=.github/rollback-floors/connector-diagnostic-targets
readonly RUN_STORAGE_OUTPUT_READER_PATH=.github/rollback-floors/run-storage-output-reader
readonly GUEST_STORAGE_OUTPUT_COMPLETION_READER_PATH=.github/rollback-floors/guest-storage-output-completion-reader
readonly DECODED_STORAGE_CAPACITY_READER_PATH=.github/rollback-floors/decoded-storage-capacity-reader
readonly DATA_ROUTER_RESPONSE_ID_PATH=.github/rollback-floors/data-router-response-id
readonly DESKTOP_MANIFEST_R2_READER_PATH=.github/rollback-floors/desktop-manifest-r2-reader
readonly DATA_ROUTER_STATELESS_MCP_API_PATH=.github/rollback-floors/data-router-stateless-mcp-api
readonly HOME_CACHE_CAPACITY_READER_PATH=.github/rollback-floors/home-cache-capacity-reader
readonly WORKFLOW_ATTACHMENTS_DIRECT_PATH=.github/rollback-floors/workflow-attachments-direct
readonly STORAGE_DEBUG_CONTRACTS_PATH=.github/rollback-floors/storage-debug-contracts
readonly PI_MEMORY_RETIRED_PATH=.github/rollback-floors/pi-memory-retired
# Completion now accepts only storageOutputs. The selected Runner must embed
# #41742's Guest writer even when its paired API still accepts the old field.
readonly GUEST_STORAGE_OUTPUT_COMPLETION_WRITER_COMMIT=2eff576ad75d328676834643c1380ff35c2297e2
readonly VNC_CANONICAL_METADATA_PATH=.github/rollback-floors/vnc-native-networks-canonical-metadata
readonly WORKFLOW_NAME_SCOPES_PREPARATION_PATH=turbo/packages/db/src/migrations/1375_workflow_name_scopes.sql
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
readonly USAGE_ALLOWANCE_RETIREMENT_PATH=turbo/packages/db/src/migrations/1356_drop_organization_usage_allowance.sql
readonly SSH_CANONICAL_TRANSPORT_PATH=turbo/packages/db/src/migrations/1365_tailscale_private_ssh.sql
readonly OFFICIAL_RESULT_EMAIL_RUNTIME_RETIREMENT_PATH=turbo/packages/db/src/migrations/1382_retire_official_result_email_runtime.sql
readonly OFFICIAL_RESULT_EMAIL_STORAGE_CONTRACTION_PATH=turbo/packages/db/src/migrations/1386_drop_official_result_email_storage.sql
readonly SSH_NEEDS_REBIND_INDEPENDENT_PATH=turbo/packages/db/src/runtime/ssh-connection.ts

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

if ! git merge-base --is-ancestor "$IMMUTABLE_DEFAULT_AGENT_WRITER_COMMIT" "$TARGET_COMMIT"; then
  fail "Rollback target predates immutable default Agent identity: ${IMMUTABLE_DEFAULT_AGENT_WRITER_COMMIT}."
fi

if ! git merge-base --is-ancestor "$STRUCTURED_DISK_TELEMETRY_READER_COMMIT" "$TARGET_COMMIT"; then
  fail "Rollback target predates the structured-only disk telemetry reader: ${STRUCTURED_DISK_TELEMETRY_READER_COMMIT}."
fi

if ! git merge-base --is-ancestor "$FINALIZING_SOURCE_API_WRITER_COMMIT" "$TARGET_COMMIT"; then
  fail "Rollback target predates the independent finalizing source writer: ${FINALIZING_SOURCE_API_WRITER_COMMIT}."
fi

if ! git merge-base --is-ancestor "$RUNNER_STATE_WSS_INGRESS_FREE_COMMIT" "$TARGET_COMMIT"; then
  fail "Rollback target predates the wss_ingress_service_active-free Runner state mapping: ${RUNNER_STATE_WSS_INGRESS_FREE_COMMIT}."
fi

if ! git merge-base --is-ancestor "$MANAGED_DATA_RUNTIME_RETIREMENT_COMMIT" "$TARGET_COMMIT"; then
  fail "Rollback target predates the retired Data storage-independent runtime: ${MANAGED_DATA_RUNTIME_RETIREMENT_COMMIT}."
fi

if ! git merge-base --is-ancestor "$STRIPE_INVOICE_PAID_RETIREMENT_COMMIT" "$TARGET_COMMIT"; then
  fail "Rollback target predates the Stripe invoice-paid automation retirement: ${STRIPE_INVOICE_PAID_RETIREMENT_COMMIT}."
fi

if ! git merge-base --is-ancestor "$RUN_OUTPUT_MEMORY_CITATION_RETIREMENT_COMMIT" "$TARGET_COMMIT"; then
  fail "Rollback target predates the Run output memory citation retirement: ${RUN_OUTPUT_MEMORY_CITATION_RETIREMENT_COMMIT}."
fi

if ! git merge-base --is-ancestor "$MEMBER_PREFERENCE_RETIREMENT_COMMIT" "$TARGET_COMMIT"; then
  fail "Rollback target predates the retired member preference mapping: ${MEMBER_PREFERENCE_RETIREMENT_COMMIT}."
fi

if ! git merge-base --is-ancestor "$DAV_FIREWALL_READER_COMMIT" "$TARGET_COMMIT"; then
  fail "Rollback target predates DAV connector preparation: ${DAV_FIREWALL_READER_COMMIT}."
fi

if ! git merge-base --is-ancestor "$WORKFLOW_DOWNLOAD_READER_COMMIT" "$TARGET_COMMIT"; then
  fail "Rollback target predates Workflow download preparation: ${WORKFLOW_DOWNLOAD_READER_COMMIT}."
fi

# Workflows retain the authoritative cursor in Cloudflare. Earlier APIs also
# require the retired SQL ownership marker and cannot serve the contracted schema.
wechat_workflows_only_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$WECHAT_WORKFLOWS_ONLY_PATH" | sed -n '1p')
if [[ ! "$wechat_workflows_only_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged WeChat Workflows-only receiver on main."
fi

# New-only Workflow edits leave legacy Storage packages stale. Resolve the
# merged cutover itself, including squash merges, before any provider access.
workflow_attachments_direct_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$WORKFLOW_ATTACHMENTS_DIRECT_PATH" | sed -n '1p')
if [[ ! "$workflow_attachments_direct_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged direct Workflow attachment runtime on main."
fi
if ! git merge-base --is-ancestor "$workflow_attachments_direct_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates direct Workflow attachment ownership: ${workflow_attachments_direct_commit}."
fi
if ! git merge-base --is-ancestor "$wechat_workflows_only_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the WeChat Workflows-only receiver: ${wechat_workflows_only_commit}."
fi

if ! git merge-base --is-ancestor "$LINK_WALLET_GRANT_WRITER_COMMIT" "$TARGET_COMMIT"; then
  fail "Rollback target predates the Link wallet grant metadata writer: ${LINK_WALLET_GRANT_WRITER_COMMIT}."
fi

# G publishes native VNC bindings and always-present reference arrays. H's
# required readers must never reach a B-F API that can omit vncHosts. Resolve
# the producer's merged main commit, independently of the requested old target.
vnc_canonical_metadata_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$VNC_CANONICAL_METADATA_PATH" | sed -n '1p')
if [[ ! "$vnc_canonical_metadata_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged VNC canonical metadata producer on main."
fi
if ! git merge-base --is-ancestor "$vnc_canonical_metadata_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the VNC canonical metadata producer: ${vnc_canonical_metadata_commit}."
fi

# Native-only producers cannot roll back to Session-based handlers or deleters.
# The main-owned marker becomes authoritative when this cutover PR merges.
session_conversation_runtime_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$SESSION_CONVERSATION_RUNTIME_PATH" | sed -n '1p')
if [ -n "$session_conversation_runtime_commit" ] && \
  ! git merge-base --is-ancestor "$session_conversation_runtime_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates native-only Session/Conversation retirement: ${session_conversation_runtime_commit}."
fi

if ! git merge-base --is-ancestor "$CHAT_THREAD_PROVENANCE_REMOVAL_COMMIT" "$TARGET_COMMIT"; then
  fail "Rollback target predates the chat thread provenance runtime removal: ${CHAT_THREAD_PROVENANCE_REMOVAL_COMMIT}."
fi

# The preparation clears retired host hashes without deleting devices or chat
# bindings. Only the session-only runtime mapping can overlap the later DROP;
# older APIs still name token_hash in implicit reads and writes.
computer_use_host_session_only_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$COMPUTER_USE_HOST_SESSION_ONLY_PATH" | sed -n '1p')
if [[ ! "$computer_use_host_session_only_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged Computer Use session-only host mapping on main."
fi
if ! git merge-base --is-ancestor "$computer_use_host_session_only_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the Computer Use session-only host mapping: ${computer_use_host_session_only_commit}."
fi

# #38737 removed the Native collection fence from every member SQL projection.
# Earlier APIs still include it in implicit INSERT, SELECT and RETURNING.
native_brief_member_runtime_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$NATIVE_BRIEF_MEMBER_RUNTIME_PATH" | sed -n '1p')
if [[ ! "$native_brief_member_runtime_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged Native Morning Brief member runtime preparation on main."
fi
if ! git merge-base --is-ancestor "$native_brief_member_runtime_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the Native Morning Brief member runtime preparation: ${native_brief_member_runtime_commit}."
fi

# #39325 omits Session storage_mounts from all runtime and root-schema SQL.
# Resolve that shipped preparation, not the later DROP, so compatible release-1
# APIs remain eligible after the physical contraction under #39310.
session_storage_mount_runtime_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$SESSION_STORAGE_MOUNT_RUNTIME_PATH" | sed -n '1p')
if [[ ! "$session_storage_mount_runtime_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged Session storage-mount runtime preparation on main."
fi
if ! git merge-base --is-ancestor "$session_storage_mount_runtime_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the Session storage-mount runtime preparation: ${session_storage_mount_runtime_commit}."
fi

# Removing the shared Private-name index allows ordinary and Official rows with
# the same name. Earlier APIs resolve both by name and can recover an Official
# installation through the ordinary row. Keep already-deployed preparation
# releases eligible rather than requiring the later index-drop release.
workflow_name_scopes_preparation_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$WORKFLOW_NAME_SCOPES_PREPARATION_PATH" | sed -n '1p')
if [[ ! "$workflow_name_scopes_preparation_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged Workflow namespace preparation on main."
fi
if ! git merge-base --is-ancestor "$workflow_name_scopes_preparation_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the Workflow namespace preparation: ${workflow_name_scopes_preparation_commit}."
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
if ! git merge-base --is-ancestor "$PI_OPENROUTER_VERSIONED_WRITER_COMMIT" "$TARGET_COMMIT"; then
  fail "Rollback target predates the versioned Pi OpenRouter writer: ${PI_OPENROUTER_VERSIONED_WRITER_COMMIT}."
fi

if ! git merge-base --is-ancestor "$MODEL_EXECUTION_CAPTURE_WRITER_COMMIT" "$TARGET_COMMIT"; then
  fail "Rollback target predates the model execution capture writer: ${MODEL_EXECUTION_CAPTURE_WRITER_COMMIT}."
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

# Migration 1356 drops Allowance history and its hourly columns. Earlier APIs
# still read the allocation table and write the retired hourly shape, so none
# can serve after the contraction. Resolve the canonical first-parent main
# commit, never a branch-only implementation SHA.
usage_allowance_retirement_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$USAGE_ALLOWANCE_RETIREMENT_PATH" | sed -n '1p')
if [[ ! "$usage_allowance_retirement_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged Usage Allowance retirement on main."
fi
if ! git merge-base --is-ancestor "$usage_allowance_retirement_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the Usage Allowance retirement: ${usage_allowance_retirement_commit}."
fi

# Prepared SSH writers no longer mirror needs_rebind. APIs before the canonical
# transport migration infer authority from that flag and can misread retained
# private bindings, even while its physical column remains for outgoing SQL.
ssh_canonical_transport_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$SSH_CANONICAL_TRANSPORT_PATH" | sed -n '1p')
if [[ ! "$ssh_canonical_transport_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged canonical SSH transport on main."
fi
if ! git merge-base --is-ancestor "$ssh_canonical_transport_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates canonical SSH transport: ${ssh_canonical_transport_commit}."
fi

# Release 2 of #39378 stops writing official_result_email_enabled (new Official
# Automations store NULL) and publishes catalog schema v3. Earlier APIs treat
# NULL as incomplete dormant materialization state or mismatched ownership and
# predate the v3 writer, so no earlier API is a safe rollback target.
official_result_email_runtime_retirement_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$OFFICIAL_RESULT_EMAIL_RUNTIME_RETIREMENT_PATH" | sed -n '1p')
if [[ ! "$official_result_email_runtime_retirement_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged Official result-email runtime retirement on main."
fi
if ! git merge-base --is-ancestor "$official_result_email_runtime_retirement_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the Official result-email runtime retirement: ${official_result_email_runtime_retirement_commit}."
fi

# Release 3 of #39378 drops official_automation_result_email_claims,
# workflow_automations.official_result_email_enabled and the email_outbox source
# pair. Release-1 APIs name that storage in their completion-email producer and
# ORM, and release-2 APIs (including 1.729.1) in their bounded legacy consumer
# (#39524), so no earlier API can serve after the contraction. This floor
# descends from, and so supersedes, that consumer's floor. Resolve the canonical
# first-parent main commit, never a branch-only SHA.
official_result_email_storage_contraction_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$OFFICIAL_RESULT_EMAIL_STORAGE_CONTRACTION_PATH" | sed -n '1p')
if [[ ! "$official_result_email_storage_contraction_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged Official result-email storage contraction on main."
fi
if ! git merge-base --is-ancestor "$official_result_email_storage_contraction_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the Official result-email storage contraction: ${official_result_email_storage_contraction_commit}."
fi

# Physical needs_rebind contraction requires the independently released runtime
# preparation. Earlier canonical APIs still name it in implicit ORM statements.
ssh_needs_rebind_independent_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$SSH_NEEDS_REBIND_INDEPENDENT_PATH" | sed -n '1p')
if [[ ! "$ssh_needs_rebind_independent_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged needs_rebind-independent SSH preparation on main."
fi
if ! git merge-base --is-ancestor "$ssh_needs_rebind_independent_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the needs_rebind-independent SSH preparation: ${ssh_needs_rebind_independent_commit}."
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

# Host Worker aliases resolve through the API even while URL editing is disabled.
# Earlier APIs cannot authorize a renamed site or preserve it on publication.
hosted_site_url_routing_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$HOSTED_SITE_URL_ROUTING_PATH" | sed -n '1p')
if [[ ! "$hosted_site_url_routing_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged hosted-site URL routing contract on main."
fi
if ! git merge-base --is-ancestor "$hosted_site_url_routing_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the hosted-site URL routing contract: ${hosted_site_url_routing_commit}."
fi

# Installed Native Desktop versions use Ably wakeups and heartbeat hints rather
# than periodic claims. Earlier APIs cannot authorize or recover that protocol.
computer_use_command_notifications_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$COMPUTER_USE_COMMAND_NOTIFICATIONS_PATH" | sed -n '1p')
if [[ ! "$computer_use_command_notifications_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged Computer Use command notification contract on main."
fi
if ! git merge-base --is-ancestor "$computer_use_command_notifications_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the Computer Use command notification contract: ${computer_use_command_notifications_commit}."
fi

# Bridge-free Native ZIPs are safe only while dormant Squirrel clients receive
# the retained migration hop. Earlier APIs would restore mutable latest selection.
# Resolve the merged preparation, never this bridge-removal branch's SHA.
desktop_migration_hop_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$DESKTOP_MIGRATION_HOP_PATH" | sed -n '1p')
if [[ ! "$desktop_migration_hop_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged Desktop migration-hop policy on main."
fi
if ! git merge-base --is-ancestor "$desktop_migration_hop_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the frozen Desktop migration-hop policy: ${desktop_migration_hop_commit}."
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

# #41333 deployed the canonical Storage-output log reader before duplicate
# artifact writes stopped. Read its explicit floor from current main so that
# the shipped preparation remains eligible, independently of this cleanup.
if ! run_storage_output_reader_commit=$(git show "origin/main:${RUN_STORAGE_OUTPUT_READER_PATH}"); then
  fail "Cannot read the Run Storage-output reader rollback floor from main."
fi
if [[ ! "$run_storage_output_reader_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Missing or invalid Run Storage-output reader rollback floor."
fi
if ! git merge-base --is-ancestor "$run_storage_output_reader_commit" origin/main; then
  fail "Run Storage-output reader rollback floor is not on main."
fi
if ! git merge-base --is-ancestor "$run_storage_output_reader_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the Run Storage-output log reader: ${run_storage_output_reader_commit}."
fi

# #41656 prepared the API for Guest completion.storageOutputs before its writer
# switched. Draining Guests can outlive a Runner rollback, so the API target must
# retain that reader independently of the selected Runner artifact.
if ! guest_storage_output_completion_reader_commit=$(git show "origin/main:${GUEST_STORAGE_OUTPUT_COMPLETION_READER_PATH}"); then
  fail "Cannot read the Guest Storage-output completion reader rollback floor from main."
fi
if [[ ! "$guest_storage_output_completion_reader_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Missing or invalid Guest Storage-output completion reader rollback floor."
fi
if ! git merge-base --is-ancestor "$guest_storage_output_completion_reader_commit" origin/main; then
  fail "Guest Storage-output completion reader rollback floor is not on main."
fi
if ! git merge-base --is-ancestor "$guest_storage_output_completion_reader_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the Guest Storage-output completion reader: ${guest_storage_output_completion_reader_commit}."
fi

# The cleanup and raised App floor form one compatibility boundary. A prepared
# reader alone is insufficient: an earlier API would restore its lower App floor
# and re-admit pages requiring aliases absent from canonical-only snapshots.
storage_debug_contracts_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$STORAGE_DEBUG_CONTRACTS_PATH" | sed -n '1p')
if [[ ! "$storage_debug_contracts_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged Storage debug contract cleanup on main."
fi
if ! git merge-base --is-ancestor "$storage_debug_contracts_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the Storage debug contract cleanup: ${storage_debug_contracts_commit}."
fi

# Pi memory's private tables no longer exist. Earlier APIs still name them
# during ordinary native memory writes, even though producers were retired.
pi_memory_retired_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$PI_MEMORY_RETIRED_PATH" | sed -n '1p')
if [[ ! "$pi_memory_retired_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged Pi memory storage retirement on main."
fi
if ! git merge-base --is-ancestor "$pi_memory_retired_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates Pi memory storage retirement: ${pi_memory_retired_commit}."
fi

# PR1 introduced /api/connectors/connected and /api/remotes/overview before
# App consumers switched. A rollback must retain those resource endpoints even
# when the selected API predates the later legacy overview removal.
if ! connector_resource_split_commit=$(git show "origin/main:${CONNECTOR_RESOURCE_SPLIT_PATH}"); then
  fail "Cannot read the Connector resource split rollback floor from main."
fi
if [[ ! "$connector_resource_split_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Missing or invalid Connector resource split rollback floor."
fi
if ! git merge-base --is-ancestor "$connector_resource_split_commit" origin/main; then
  fail "Connector resource split rollback floor is not on main."
fi
if ! git merge-base --is-ancestor "$connector_resource_split_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the Connector resource split: ${connector_resource_split_commit}."
fi

# Current CLI diagnostics require canonical targets for environment and URL
# responses. Older APIs cannot serve that reader after an independent rollback.
if ! connector_diagnostic_targets_commit=$(git show "origin/main:${CONNECTOR_DIAGNOSTIC_TARGETS_PATH}"); then
  fail "Cannot read the Connector diagnostic targets rollback floor from main."
fi
if [[ ! "$connector_diagnostic_targets_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Missing or invalid Connector diagnostic targets rollback floor."
fi
if ! git merge-base --is-ancestor "$connector_diagnostic_targets_commit" origin/main; then
  fail "Connector diagnostic targets rollback floor is not on main."
fi
if ! git merge-base --is-ancestor "$connector_diagnostic_targets_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates canonical Connector diagnostic targets: ${connector_diagnostic_targets_commit}."
fi

if ! git merge-base --is-ancestor "$AGENT_INSTRUCTIONS_DB_ONLY_READER_COMMIT" "$TARGET_COMMIT"; then
  fail "Rollback target predates the database-only Agent instructions reader: ${AGENT_INSTRUCTIONS_DB_ONLY_READER_COMMIT}."
fi

# Hash-only Runners cannot execute claims from an inline/document API producer.
# Read the activation floor from current main, independently of the Runner reader floor.
if ! content_bundle_reference_only_api_commit=$(git show "origin/main:${CONTENT_BUNDLE_REFERENCE_ONLY_API_PATH}"); then
  fail "Cannot read the reference-only content bundle API rollback floor from main."
fi
if [[ ! "$content_bundle_reference_only_api_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Missing or invalid reference-only content bundle API rollback floor."
fi
if ! git merge-base --is-ancestor "$content_bundle_reference_only_api_commit" origin/main; then
  fail "Reference-only content bundle API rollback floor is not on main."
fi
if ! git merge-base --is-ancestor "$content_bundle_reference_only_api_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates reference-only content bundle claims: ${content_bundle_reference_only_api_commit}."
fi

if ! git merge-base --is-ancestor "$CONTENT_BUNDLE_PREPARATION_COMMIT" "$TARGET_COMMIT"; then
  fail "Rollback target predates immutable content bundle publication: ${CONTENT_BUNDLE_PREPARATION_COMMIT}."
fi

# Reference-only claims require the corrected archive reader. Keep the API
# producer floor independent of the selected Runner reader artifact.
content_bundle_archive_reader_commit=$(git log --reverse --first-parent --diff-filter=A --format=%H \
  origin/main -- "$CONTENT_BUNDLE_ARCHIVE_READER_PATH" | sed -n '1p')
if [[ ! "$content_bundle_archive_reader_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Cannot resolve the merged content bundle archive reader on main."
fi
if ! git merge-base --is-ancestor "$content_bundle_archive_reader_commit" origin/main; then
  fail "Content bundle archive reader rollback floor is not on main."
fi

# Retained decoded-v1 entries can outlive the wider writer. Read main's floor
# before provider access, then check the independently selected Runner below.
if ! decoded_storage_capacity_reader_commit=$(git show "origin/main:${DECODED_STORAGE_CAPACITY_READER_PATH}"); then
  fail "Cannot read the decoded storage capacity reader rollback floor from main."
fi
if [[ ! "$decoded_storage_capacity_reader_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Missing or invalid decoded storage capacity reader rollback floor."
fi
if ! git merge-base --is-ancestor "$decoded_storage_capacity_reader_commit" origin/main; then
  fail "Decoded storage capacity reader rollback floor is not on main."
fi

# Router generates billing request IDs after removing its legacy header input.
# #43113 records the response ID in MITM; earlier Runner artifacts would retain
# their locally generated ID and lose the billing association after rollback.
if ! data_router_response_id_commit=$(git show "origin/main:${DATA_ROUTER_RESPONSE_ID_PATH}"); then
  fail "Cannot read the Data Router response ID rollback floor from main."
fi
if [[ ! "$data_router_response_id_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Missing or invalid Data Router response ID rollback floor."
fi
if ! git merge-base --is-ancestor "$data_router_response_id_commit" origin/main; then
  fail "Data Router response ID rollback floor is not on main."
fi

# The GitHub manifest mirror is retired. Every supported API must read the
# authoritative R2 manifest introduced by #43047, including after a rollback.
if ! desktop_manifest_r2_reader_commit=$(git show "origin/main:${DESKTOP_MANIFEST_R2_READER_PATH}"); then
  fail "Cannot read the Desktop manifest R2 reader rollback floor from main."
fi
if [[ ! "$desktop_manifest_r2_reader_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Missing or invalid Desktop manifest R2 reader rollback floor."
fi
if ! git merge-base --is-ancestor "$desktop_manifest_r2_reader_commit" origin/main; then
  fail "Desktop manifest R2 reader rollback floor is not on main."
fi
if ! git merge-base --is-ancestor "$desktop_manifest_r2_reader_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the Desktop manifest R2 reader: ${desktop_manifest_r2_reader_commit}."
fi

# Router serves only stateless MCP 2026-07-28. #43447 moved every API request to
# that revision; earlier APIs send envelope-less JSON-RPC that Router rejects,
# so Run-end billing lookups would fail without retry.
if ! data_router_stateless_mcp_api_commit=$(git show "origin/main:${DATA_ROUTER_STATELESS_MCP_API_PATH}"); then
  fail "Cannot read the Data Router stateless MCP API rollback floor from main."
fi
if [[ ! "$data_router_stateless_mcp_api_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Missing or invalid Data Router stateless MCP API rollback floor."
fi
if ! git merge-base --is-ancestor "$data_router_stateless_mcp_api_commit" origin/main; then
  fail "Data Router stateless MCP API rollback floor is not on main."
fi
if ! git merge-base --is-ancestor "$data_router_stateless_mcp_api_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the Data Router stateless MCP requests: ${data_router_stateless_mcp_api_commit}."
fi

# Larger Runner inventories remain reachable during independent API rollback.
# Keep #43397's prepared receiver even if the selected Runner advertises less.
if ! home_cache_capacity_reader_commit=$(git show "origin/main:${HOME_CACHE_CAPACITY_READER_PATH}"); then
  fail "Cannot read the home cache capacity reader rollback floor from main."
fi
if [[ ! "$home_cache_capacity_reader_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Missing or invalid home cache capacity reader rollback floor."
fi
if ! git merge-base --is-ancestor "$home_cache_capacity_reader_commit" origin/main; then
  fail "Home cache capacity reader rollback floor is not on main."
fi
if ! git merge-base --is-ancestor "$home_cache_capacity_reader_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates the home cache capacity reader: ${home_cache_capacity_reader_commit}."
fi

# Restrictive Run references no longer perform the old cascade/SET NULL work.
# Keep the separately deployed preparation available for rollback.
if ! run_reference_preparation_commit=$(git show "origin/main:${RUN_REFERENCE_PREPARATION_PATH}"); then
  fail "Cannot read the Run reference preparation rollback floor from main."
fi
if [[ ! "$run_reference_preparation_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Missing or invalid Run reference preparation rollback floor."
fi
if ! git merge-base --is-ancestor "$run_reference_preparation_commit" origin/main; then
  fail "Run reference preparation rollback floor is not on main."
fi
if ! git merge-base --is-ancestor "$run_reference_preparation_commit" "$TARGET_COMMIT"; then
  fail "Rollback target predates explicit Run reference cleanup: ${run_reference_preparation_commit}."
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

. "${script_dir}/../runner/runner-image-target.sh"
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
if ! git merge-base --is-ancestor "$DAV_FIREWALL_READER_COMMIT" "$runner_tag_commit"; then
  fail "Runner release ${runner_tag} predates DAV firewall method support: ${DAV_FIREWALL_READER_COMMIT}."
fi
if ! git merge-base --is-ancestor "$BLANK_SANDBOX_STATUS_READER_COMMIT" "$runner_tag_commit"; then
  fail "Runner release ${runner_tag} predates the blank sandbox status reader: ${BLANK_SANDBOX_STATUS_READER_COMMIT}."
fi
if ! git merge-base --is-ancestor "$PROVIDER_BALANCE_FAILURE_COMMIT" "$runner_tag_commit"; then
  fail "Runner release ${runner_tag} predates structured provider balance failures: ${PROVIDER_BALANCE_FAILURE_COMMIT}."
fi
if ! git merge-base --is-ancestor "$BUNDLED_ONLY_CLI_RUNNER_COMMIT" "$runner_tag_commit"; then
  fail "Runner release ${runner_tag} predates bundled-only CLI startup: ${BUNDLED_ONLY_CLI_RUNNER_COMMIT}."
fi
if ! git merge-base --is-ancestor "$PAIR_FREE_DISK_TELEMETRY_WRITER_COMMIT" "$runner_tag_commit"; then
  fail "Runner release ${runner_tag} predates the pair-free disk telemetry writer: ${PAIR_FREE_DISK_TELEMETRY_WRITER_COMMIT}."
fi
if ! git merge-base --is-ancestor "$GUEST_STORAGE_OUTPUT_COMPLETION_WRITER_COMMIT" "$runner_tag_commit"; then
  fail "Runner release ${runner_tag} predates the Guest Storage-output completion writer: ${GUEST_STORAGE_OUTPUT_COMPLETION_WRITER_COMMIT}."
fi

if ! git merge-base --is-ancestor "$FINALIZING_SOURCE_RUNNER_READER_COMMIT" "$runner_tag_commit"; then
  fail "Runner release ${runner_tag} predates the independent finalizing source reader: ${FINALIZING_SOURCE_RUNNER_READER_COMMIT}."
fi

if ! git merge-base --is-ancestor "$AGENT_INSTRUCTIONS_RUNNER_READER_COMMIT" "$runner_tag_commit"; then
  fail "Runner release ${runner_tag} predates inline Agent instructions: ${AGENT_INSTRUCTIONS_RUNNER_READER_COMMIT}."
fi

if ! git merge-base --is-ancestor "$CONTENT_BUNDLE_PREPARATION_COMMIT" "$runner_tag_commit"; then
  fail "Runner release ${runner_tag} predates hash-addressed content bundles: ${CONTENT_BUNDLE_PREPARATION_COMMIT}."
fi

if ! git merge-base --is-ancestor "$content_bundle_archive_reader_commit" "$runner_tag_commit"; then
  fail "Runner release ${runner_tag} predates bounded content bundle archive delivery: ${content_bundle_archive_reader_commit}."
fi

if ! git merge-base --is-ancestor "$WORKFLOW_DOWNLOAD_READER_COMMIT" "$runner_tag_commit"; then
  fail "Runner release ${runner_tag} predates Workflow download preparation: ${WORKFLOW_DOWNLOAD_READER_COMMIT}."
fi

if ! git merge-base --is-ancestor "$decoded_storage_capacity_reader_commit" "$runner_tag_commit"; then
  fail "Runner release ${runner_tag} predates the decoded storage capacity reader: ${decoded_storage_capacity_reader_commit}."
fi
if ! git merge-base --is-ancestor "$workflow_attachments_direct_commit" "$runner_tag_commit"; then
  fail "Runner release ${runner_tag} predates verified Workflow attachment delivery: ${workflow_attachments_direct_commit}."
fi

if ! git merge-base --is-ancestor "$data_router_response_id_commit" "$runner_tag_commit"; then
  fail "Runner release ${runner_tag} predates Data Router response ID tracking: ${data_router_response_id_commit}."
fi

runner_matrix=$("${script_dir}/../runner/runner-host-architecture-groups.sh" target-matrix)
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
