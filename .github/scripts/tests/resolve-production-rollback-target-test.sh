#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/release/resolve-production-rollback-target.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
fake_bin="${tmp_dir}/bin"
mkdir -p "$fake_bin"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

target_commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
connector_resource_split_floor=$(<"${repo_root}/.github/rollback-floors/connector-resource-split")
decoded_storage_reader_floor=$(<"${repo_root}/.github/rollback-floors/decoded-storage-capacity-reader")
data_router_response_id_floor=$(<"${repo_root}/.github/rollback-floors/data-router-response-id")
connector_diagnostic_targets_floor=$(<"${repo_root}/.github/rollback-floors/connector-diagnostic-targets")
desktop_manifest_r2_reader_floor=$(<"${repo_root}/.github/rollback-floors/desktop-manifest-r2-reader")
data_router_stateless_mcp_api_floor=$(<"${repo_root}/.github/rollback-floors/data-router-stateless-mcp-api")
home_cache_capacity_reader_floor=$(<"${repo_root}/.github/rollback-floors/home-cache-capacity-reader")

cat >"${fake_bin}/git" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'git %s\n' "$*" >>"$MOCK_BOUNDARY_LOG"
case "${1:-}" in
  fetch|cat-file) exit 0 ;;
  merge-base)
    if [ "${3:-}" = "01d21f7c5857795104c27cd54e724f2ced2d683e" ]; then
      [ "${MOCK_IMMUTABLE_DEFAULT_AGENT_WRITER_TARGET_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "7171717171717171717171717171717171717171" ]; then
      if [ "${4:-}" = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" ]; then
        [ "${MOCK_WORKFLOW_ATTACHMENT_RUNNER_VALID:-1}" = "1" ]
      else
        [ "${MOCK_WORKFLOW_ATTACHMENT_API_VALID:-1}" = "1" ]
      fi
    elif [ "${3:-}" = "6fd29050029b5a521f75d0500e9876a11649afe6" ]; then
      if [ "${4:-}" = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" ]; then
        [ "${MOCK_WORKFLOW_DOWNLOAD_RUNNER_VALID:-1}" = "1" ]
      else
        [ "${MOCK_WORKFLOW_DOWNLOAD_API_VALID:-1}" = "1" ]
      fi
    elif [ "${3:-}" = "$MOCK_DATA_ROUTER_RESPONSE_ID_FLOOR" ]; then
      if [ "${4:-}" = "origin/main" ]; then
        [ "${MOCK_DATA_ROUTER_RESPONSE_ID_ON_MAIN:-1}" = "1" ]
      elif [ "${4:-}" = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" ]; then
        [ "${MOCK_DATA_ROUTER_RESPONSE_ID_RUNNER_VALID:-1}" = "1" ]
      fi
    elif [ "${3:-}" = "$MOCK_HOME_CACHE_CAPACITY_READER_FLOOR" ]; then
      if [ "${4:-}" = "origin/main" ]; then
        [ "${MOCK_HOME_CACHE_CAPACITY_READER_ON_MAIN:-1}" = "1" ]
      else
        [ "${MOCK_HOME_CACHE_CAPACITY_READER_TARGET_VALID:-1}" = "1" ]
      fi
    elif [ "${3:-}" = "$MOCK_DATA_ROUTER_STATELESS_MCP_API_FLOOR" ]; then
      if [ "${4:-}" = "origin/main" ]; then
        [ "${MOCK_DATA_ROUTER_STATELESS_MCP_API_ON_MAIN:-1}" = "1" ]
      else
        [ "${MOCK_DATA_ROUTER_STATELESS_MCP_API_TARGET_VALID:-1}" = "1" ]
      fi
    elif [ "${3:-}" = "$MOCK_DESKTOP_MANIFEST_R2_READER_FLOOR" ]; then
      if [ "${4:-}" = "origin/main" ]; then
        [ "${MOCK_DESKTOP_MANIFEST_R2_READER_ON_MAIN:-1}" = "1" ]
      else
        [ "${MOCK_DESKTOP_MANIFEST_R2_READER_TARGET_VALID:-1}" = "1" ]
      fi
    elif [ "${3:-}" = "${MOCK_DECODED_STORAGE_READER_COMMIT-$MOCK_DECODED_STORAGE_READER_FLOOR}" ]; then
      if [ "${4:-}" = "origin/main" ]; then
        [ "${MOCK_DECODED_STORAGE_READER_ON_MAIN:-1}" = "1" ]
      elif [ "${4:-}" = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" ]; then
        [ "${MOCK_DECODED_STORAGE_READER_RUNNER_VALID:-1}" = "1" ]
      fi
    elif [ "${3:-}" = "$MOCK_CONNECTOR_RESOURCE_SPLIT_FLOOR" ]; then
      if [ "${4:-}" = "origin/main" ]; then
        [ "${MOCK_CONNECTOR_RESOURCE_SPLIT_ON_MAIN:-1}" = "1" ]
      else
        [ "${MOCK_CONNECTOR_RESOURCE_SPLIT_TARGET_VALID:-1}" = "1" ]
      fi
    elif [ "${3:-}" = "$MOCK_CONNECTOR_DIAGNOSTIC_TARGETS_FLOOR" ]; then
      if [ "${4:-}" = "origin/main" ]; then
        [ "${MOCK_CONNECTOR_DIAGNOSTIC_TARGETS_ON_MAIN:-1}" = "1" ]
      else
        [ "${MOCK_CONNECTOR_DIAGNOSTIC_TARGETS_TARGET_VALID:-1}" = "1" ]
      fi
    elif [ "${3:-}" = "6060606060606060606060606060606060606060" ]; then
      if [ "${4:-}" = "origin/main" ]; then
        [ "${MOCK_GUEST_STORAGE_COMPLETION_READER_ON_MAIN:-1}" = "1" ]
      else
        [ "${MOCK_GUEST_STORAGE_COMPLETION_READER_FLOOR_VALID:-1}" = "1" ]
      fi
    elif [ "${3:-}" = "6161616161616161616161616161616161616161" ]; then
      [ "${MOCK_STORAGE_DEBUG_CONTRACTS_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "2eff576ad75d328676834643c1380ff35c2297e2" ] && [ "${4:-}" = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" ]; then
      [ "${MOCK_GUEST_STORAGE_COMPLETION_WRITER_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "c0dec0dec0dec0dec0dec0dec0dec0dec0dec0de" ]; then
      if [ "${4:-}" = "origin/main" ]; then
        [ "${MOCK_RUN_STORAGE_OUTPUT_READER_ON_MAIN:-1}" = "1" ]
      else
        [ "${MOCK_RUN_STORAGE_OUTPUT_READER_FLOOR_VALID:-1}" = "1" ]
      fi
    elif [ "${3:-}" = "625c4607ccdcd2d46a5c7227f61419928035e13f" ]; then
      [ "${MOCK_PAIR_FREE_DISK_WRITER_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "e01702c7d762b5d2a76d557db77ccaf19c4f95c8" ]; then
      [ "${MOCK_STRUCTURED_DISK_READER_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "968063848aea8cf54acd6f56facdf7cdcbd79051" ]; then
      [ "${MOCK_FINALIZING_SOURCE_API_WRITER_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "430cb92b5431e1554d0a1dceed6d9cfb27762921" ]; then
      [ "${MOCK_RUNNER_STATE_WSS_INGRESS_FREE_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "190cdfba6440b50469117758156616447d707b81" ]; then
      [ "${MOCK_STRIPE_INVOICE_PAID_RETIREMENT_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "26bacab4693d32e4a4453dce5c84e565d7129b9c" ]; then
      [ "${MOCK_RUN_OUTPUT_MEMORY_CITATION_RETIREMENT_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "94389e2203aaa62408b780156c2cf8f9a9cc5414" ]; then
      [ "${MOCK_MEMBER_PREFERENCE_RETIREMENT_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "c8de6212dc54a5aae0d4658acf1afa6a35f939ab" ]; then
      if [ "${4:-}" = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" ]; then
        [ "${MOCK_DAV_RUNNER_READER_VALID:-1}" = "1" ]
      else
        [ "${MOCK_DAV_API_READER_VALID:-1}" = "1" ]
      fi
    elif [ "${3:-}" = "b610ff61043274157618e3925b13a66dc56ef84b" ]; then
      [ "${MOCK_FINALIZING_SOURCE_RUNNER_READER_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "5959595959595959595959595959595959595959" ]; then
      [ "${MOCK_WECHAT_WORKFLOWS_ONLY_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "dfff1605013103371cd90962ee5b54c80fc93140" ]; then
      [ "${MOCK_BUNDLED_CLI_RUNNER_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "37e6bb51029f05ff1d7a7a6c28b03f139dfd067c" ]; then
      [ "${MOCK_LINK_GRANT_WRITER_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "52525252525252525252525252525252525252ab" ]; then
      [ "${MOCK_WORKFLOW_NAME_SCOPES_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "4747474747474747474747474747474747474747" ]; then
      [ "${MOCK_NATIVE_BRIEF_MEMBER_RUNTIME_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "4646464646464646464646464646464646464646" ]; then
      [ "${MOCK_DESKTOP_MIGRATION_HOP_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "4545454545454545454545454545454545454545" ]; then
      [ "${MOCK_COMPUTER_USE_HOST_SESSION_ONLY_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "9fa8da0d3d25e75e0dcfdd3292e1e2bbe6fe262f" ]; then
      [ "${MOCK_CHAT_THREAD_PROVENANCE_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "febec8a3399be74b0f14a89cb9f42e39dd5ce69f" ]; then
      [ "${MOCK_BLANK_RUNNER_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "0367d976a87fe1251fcb9b6cfe545a8b24e4f2b6" ]; then
      [ "${MOCK_BALANCE_RUNNER_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "4558c9fac46ce1a96a25745b477b32b70dab7ae6" ]; then
      [ "${MOCK_CHAT_THREAD_DRAFT_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "7a187fa0a3fe2f23a134c7cdff66ee9c7e2bdb38" ]; then
      [ "${MOCK_CHAT_THREAD_DRAFT_OWNER_KEY_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "cdeec36c168636b1a2e510e660eb6139c9c4e07a" ]; then
      [ "${MOCK_COMPUTER_USE_AUDIT_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "98b5515ae2874128734b19a17b96dc8c6c7afe47" ]; then
      [ "${MOCK_CHAT_SEARCH_GIN_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "ee863a302a6c547f94e50ec4069f70910d68bee2" ]; then
      [ "${MOCK_ADVISORY_LOCK_PREPARATION_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "84ac71914345b8360f3df43cc2cd47f0a8af7a23" ]; then
      [ "${MOCK_QUEUED_RUN_PROMOTION_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "553fc566b7e9be2cd4a8c1de314d55939b99490a" ]; then
      [ "${MOCK_UNIFIED_CHAT_QUEUE_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "fd5104417a0cf41116ce9cb9c1aeb2fa3b5e14da" ]; then
      [ "${MOCK_RUNNER_STEER_ENDPOINTS_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "45b537a596a153a91b76c3bc7223187840f52775" ]; then
      [ "${MOCK_VIDEO_GENERATION_RETIREMENT_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "66e1cae65d0468a50149f0dafab9d0d35abd0819" ]; then
      if [ "${4:-}" = "origin/main" ]; then
        [ "${MOCK_RUN_REFERENCE_PREPARATION_ON_MAIN:-1}" = "1" ]
      else
        [ "${MOCK_RUN_REFERENCE_PREPARATION_VALID:-1}" = "1" ]
      fi
    elif [ "${3:-}" = "6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a" ]; then
      [ "${MOCK_PI_MEMORY_RETIRED_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "a635ec3afa20cdb5df9c8125afe6cec24ef53e16" ]; then
      [ "${MOCK_PI_OPENROUTER_VERSIONED_WRITER_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "b6919718b6d856dfa3a7c500b6e899dd3fde7674" ]; then
      [ "${MOCK_MODEL_EXECUTION_CAPTURE_WRITER_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "3d93ff8d4b4a07a5888e3030e69b340f40da0ad4" ]; then
      [ "${MOCK_CHAT_THREAD_SNAPSHOT_R2_ONLY_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "2222222222222222222222222222222222222222" ]; then
      [ "${MOCK_PUBLIC_BRAND_RETIREMENT_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "3333333333333333333333333333333333333333" ]; then
      [ "${MOCK_AGENT_RUN_HEARTBEAT_DROP_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "4444444444444444444444444444444444444444" ]; then
      [ "${MOCK_PERSONAL_SUBSCRIPTION_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "5555555555555555555555555555555555555555" ]; then
      [ "${MOCK_SNAPSHOT_JSONB_DROP_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "6666666666666666666666666666666666666666" ]; then
      [ "${MOCK_STRIPE_PORTAL_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "7777777777777777777777777777777777777777" ]; then
      [ "${MOCK_CHAT_EVENT_SCHEMA_HEADER_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "8888888888888888888888888888888888888888" ]; then
      [ "${MOCK_RETIRED_PREFERENCE_COLUMNS_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1" ]; then
      [ "${MOCK_CHAT_EVENT_V8_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "b4a90a6b3f79527f91836df6a2bcc8fe81c622e8" ]; then
      [ "${MOCK_AGENT_INSTRUCTIONS_API_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "da0dc9cd1b21ecdd91200fb1cad8600ee5fdfd29" ]; then
      [ "${MOCK_AGENT_INSTRUCTIONS_RUNNER_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "7272727272727272727272727272727272727272" ]; then
      if [ "${4:-}" = "origin/main" ]; then
        [ "${MOCK_CONTENT_BUNDLE_ARCHIVE_READER_ON_MAIN:-1}" = "1" ]
      elif [ "${4:-}" = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" ]; then
        [ "${MOCK_CONTENT_BUNDLE_ARCHIVE_RUNNER_VALID:-1}" = "1" ]
      else
        [ "${MOCK_CONTENT_BUNDLE_ARCHIVE_API_VALID:-1}" = "1" ]
      fi
    elif [ "${3:-}" = "fc8f99468cc7946843620ff655ae22c09f9cb2ae" ]; then
      if [ "${4:-}" = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" ]; then
        [ "${MOCK_CONTENT_BUNDLE_RUNNER_VALID:-1}" = "1" ]
      else
        [ "${MOCK_CONTENT_BUNDLE_API_VALID:-1}" = "1" ]
      fi
    elif [ "${3:-}" = "1414141414141414141414141414141414141414" ]; then
      [ "${MOCK_BROWSER_SESSION_MUTATIONS_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "5858585858585858585858585858585858585858" ]; then
      [ "${MOCK_HOSTED_SITE_URL_ROUTING_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "4343434343434343434343434343434343434343" ]; then
      [ "${MOCK_COMPUTER_USE_COMMAND_NOTIFICATIONS_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "1212121212121212121212121212121212121212" ]; then
      [ "${MOCK_RETIRED_INTEGRATION_AGENT_TABLES_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" ]; then
      [ "${MOCK_VIDEO_MODEL_COLUMNS_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "1313131313131313131313131313131313131313" ]; then
      [ "${MOCK_IMAGE_MODEL_THREAD_COLUMNS_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "1515151515151515151515151515151515151515" ]; then
      [ "${MOCK_VIDEO_ENTITLEMENT_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "1616161616161616161616161616161616161616" ]; then
      [ "${MOCK_RETIRED_MODEL_CONFIGURATION_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "1717171717171717171717171717171717171717" ]; then
      [ "${MOCK_CHAT_THREAD_PROVIDER_PIN_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "1818181818181818181818181818181818181818" ]; then
      [ "${MOCK_DEAD_MODEL_PROVIDER_COLUMNS_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "1919191919191919191919191919191919191919" ]; then
      [ "${MOCK_CONNECTOR_CATALOG_RELEASE_2_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "3737373737373737373737373737373737373737" ]; then
      [ "${MOCK_MODEL_ROUTE_STATE_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "3838383838383838383838383838383838383838" ]; then
      [ "${MOCK_PI_STABLE_CONTEXT_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "3939393939393939393939393939393939393939" ]; then
      [ "${MOCK_PI_DEBUG_TRACE_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "4040404040404040404040404040404040404040" ]; then
      [ "${MOCK_CONNECTOR_CATALOG_PAYLOAD_INDEPENDENT_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "4141414141414141414141414141414141414141" ]; then
      [ "${MOCK_USAGE_ALLOWANCE_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "4848484848484848484848484848484848484848" ]; then
      [ "${MOCK_SSH_CANONICAL_TRANSPORT_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "4949494949494949494949494949494949494949" ]; then
      [ "${MOCK_OFFICIAL_RESULT_EMAIL_RUNTIME_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "5050505050505050505050505050505050505050" ]; then
      [ "${MOCK_OFFICIAL_RESULT_EMAIL_STORAGE_CONTRACTION_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "5151515151515151515151515151515151515151" ]; then
      [ "${MOCK_SSH_NEEDS_REBIND_INDEPENDENT_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "5757575757575757575757575757575757575757" ]; then
      [ "${MOCK_VNC_CANONICAL_METADATA_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "5656565656565656565656565656565656565656" ]; then
      [ "${MOCK_SESSION_CONVERSATION_RUNTIME_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "5252525252525252525252525252525252525252" ]; then
      [ "${MOCK_SESSION_STORAGE_MOUNT_RUNTIME_FLOOR_VALID:-1}" = "1" ]
    else
      [ "${MOCK_ANCESTRY_VALID:-1}" = "1" ]
    fi
    ;;
  log)
    if [[ "$*" == *rollback-floors/content-bundle-archive-reader* ]]; then
      printf '%s\n' "${MOCK_CONTENT_BUNDLE_ARCHIVE_READER_COMMIT-7272727272727272727272727272727272727272}"
    elif [[ "$*" == *rollback-floors/workflow-attachments-direct* ]]; then
      printf '%s\n' "${MOCK_WORKFLOW_ATTACHMENT_COMMIT-7171717171717171717171717171717171717171}"
    elif [[ "$*" == *rollback-floors/wechat-workflows-only* ]]; then
      printf '%s\n' "${MOCK_WECHAT_WORKFLOWS_ONLY_COMMIT-5959595959595959595959595959595959595959}"
    elif [[ "$*" == *1375_workflow_name_scopes.sql* ]]; then
      printf '%s\n' "${MOCK_WORKFLOW_NAME_SCOPES_COMMIT-52525252525252525252525252525252525252ab}"
    elif [[ "$*" == *desktop-electron-migration-release.ts* ]]; then
      printf '%s\n' "${MOCK_DESKTOP_MIGRATION_HOP_COMMIT-4646464646464646464646464646464646464646}"
    elif [[ "$*" == *src/runtime/computer-use-host.ts* ]]; then
      printf '%s\n' "${MOCK_COMPUTER_USE_HOST_SESSION_ONLY_COMMIT-4545454545454545454545454545454545454545}"
    elif [[ "$*" == *src/runtime/org-members-metadata.ts* ]]; then
      printf '%s\n' "${MOCK_NATIVE_BRIEF_MEMBER_RUNTIME_COMMIT-4747474747474747474747474747474747474747}"
    elif [[ "$*" == *1255_retire_public_brand.sql* ]]; then
      printf '%s\n' "${MOCK_PUBLIC_BRAND_RETIREMENT_COMMIT-2222222222222222222222222222222222222222}"
    elif [[ "$*" == *1259_drop_agent_runs_last_heartbeat_at.sql* ]]; then
      printf '%s\n' "${MOCK_AGENT_RUN_HEARTBEAT_DROP_COMMIT-3333333333333333333333333333333333333333}"
    elif [[ "$*" == *1260_personal_subscription_account_only.sql* ]]; then
      printf '%s\n' "${MOCK_PERSONAL_SUBSCRIPTION_COMMIT-4444444444444444444444444444444444444444}"
    elif [[ "$*" == *1261_drop_chat_thread_snapshot_jsonb.sql* ]]; then
      printf '%s\n' "${MOCK_SNAPSHOT_JSONB_DROP_COMMIT-5555555555555555555555555555555555555555}"
    elif [[ "$*" == *stripe-portal-purpose-only* ]]; then
      printf '%s\n' "${MOCK_STRIPE_PORTAL_COMMIT-6666666666666666666666666666666666666666}"
    elif [[ "$*" == *chat-event-schema-header-retired* ]]; then
      printf '%s\n' "${MOCK_CHAT_EVENT_SCHEMA_HEADER_COMMIT-7777777777777777777777777777777777777777}"
    elif [[ "$*" == *1274_drop_retired_voice_reasoning_collection_columns.sql* ]]; then
      printf '%s\n' "${MOCK_RETIRED_PREFERENCE_COLUMNS_COMMIT-8888888888888888888888888888888888888888}"
    elif [[ "$*" == *1283_drop_retired_video_model_columns.sql* ]]; then
      printf '%s\n' "${MOCK_VIDEO_MODEL_COLUMNS_COMMIT-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee}"
    elif [[ "$*" == *1287_drop_image_model_thread_columns.sql* ]]; then
      printf '%s\n' "${MOCK_IMAGE_MODEL_THREAD_COLUMNS_COMMIT-1313131313131313131313131313131313131313}"
    elif [[ "$*" == *1315_drop_retired_video_entitlement.sql* ]]; then
      printf '%s\n' "${MOCK_VIDEO_ENTITLEMENT_COMMIT-1515151515151515151515151515151515151515}"
    elif [[ "$*" == *1330_drop_retired_model_configuration_columns.sql* ]]; then
      printf '%s\n' "${MOCK_RETIRED_MODEL_CONFIGURATION_COMMIT-1616161616161616161616161616161616161616}"
    elif [[ "$*" == *1332_drop_chat_thread_provider_pin_columns.sql* ]]; then
      printf '%s\n' "${MOCK_CHAT_THREAD_PROVIDER_PIN_COMMIT-1717171717171717171717171717171717171717}"
    elif [[ "$*" == *1333_drop_dead_model_provider_columns.sql* ]]; then
      printf '%s\n' "${MOCK_DEAD_MODEL_PROVIDER_COLUMNS_COMMIT-1818181818181818181818181818181818181818}"
    elif [[ "$*" == *1334_connector_catalog_release_2_contraction.sql* ]]; then
      printf '%s\n' "${MOCK_CONNECTOR_CATALOG_RELEASE_2_COMMIT-1919191919191919191919191919191919191919}"
    elif [[ "$*" == *1338_retire_model_route_state.sql* ]]; then
      printf '%s\n' "${MOCK_MODEL_ROUTE_STATE_COMMIT-3737373737373737373737373737373737373737}"
    elif [[ "$*" == *1343_retire_pi_stable_context.sql* ]]; then
      printf '%s\n' "${MOCK_PI_STABLE_CONTEXT_COMMIT-3838383838383838383838383838383838383838}"
    elif [[ "$*" == *1345_outstanding_the_hood.sql* ]]; then
      printf '%s\n' "${MOCK_PI_DEBUG_TRACE_COMMIT-3939393939393939393939393939393939393939}"
    elif [[ "$*" == *1348_connector_catalog_payload_independent_api.sql* ]]; then
      printf '%s\n' "${MOCK_CONNECTOR_CATALOG_PAYLOAD_INDEPENDENT_COMMIT-4040404040404040404040404040404040404040}"
    elif [[ "$*" == *1356_drop_organization_usage_allowance.sql* ]]; then
      printf '%s\n' "${MOCK_USAGE_ALLOWANCE_COMMIT-4141414141414141414141414141414141414141}"
    elif [[ "$*" == *1365_tailscale_private_ssh.sql* ]]; then
      printf '%s\n' "${MOCK_SSH_CANONICAL_TRANSPORT_COMMIT-4848484848484848484848484848484848484848}"
    elif [[ "$*" == *1382_retire_official_result_email_runtime.sql* ]]; then
      printf '%s\n' "${MOCK_OFFICIAL_RESULT_EMAIL_RUNTIME_COMMIT-4949494949494949494949494949494949494949}"
    elif [[ "$*" == *1386_drop_official_result_email_storage.sql* ]]; then
      printf '%s\n' "${MOCK_OFFICIAL_RESULT_EMAIL_STORAGE_CONTRACTION_COMMIT-5050505050505050505050505050505050505050}"
    elif [[ "$*" == *.github/rollback-floors/storage-debug-contracts* ]]; then
      printf '%s\n' "${MOCK_STORAGE_DEBUG_CONTRACTS_COMMIT-6161616161616161616161616161616161616161}"
    elif [[ "$*" == *.github/rollback-floors/vnc-native-networks-canonical-metadata* ]]; then
      printf '%s\n' "${MOCK_VNC_CANONICAL_METADATA_COMMIT-5757575757575757575757575757575757575757}"
    elif [[ "$*" == *.github/rollback-floors/session-conversation-runtime* ]]; then
      printf '%s\n' "${MOCK_SESSION_CONVERSATION_RUNTIME_COMMIT-5656565656565656565656565656565656565656}"
    elif [[ "$*" == *runtime/agent-session.ts* ]]; then
      printf '%s\n' "${MOCK_SESSION_STORAGE_MOUNT_RUNTIME_COMMIT-5252525252525252525252525252525252525252}"
    elif [[ "$*" == *src/runtime/ssh-connection.ts* ]]; then
      printf '%s\n' "${MOCK_SSH_NEEDS_REBIND_INDEPENDENT_COMMIT-5151515151515151515151515151515151515151}"
    elif [[ "$*" == *chat-event-v8* ]]; then
      printf '%s\n' "${MOCK_CHAT_EVENT_V8_COMMIT-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1}"
    elif [[ "$*" == *pi-memory-retired* ]]; then
      printf '%s\n' "${MOCK_PI_MEMORY_RETIRED_COMMIT-6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a}"
    elif [[ "$*" == *browser-session-mutations* ]]; then
      printf '%s\n' "${MOCK_BROWSER_SESSION_MUTATIONS_COMMIT-1414141414141414141414141414141414141414}"
    elif [[ "$*" == *hosted-site-url-routing* ]]; then
      printf '%s\n' "${MOCK_HOSTED_SITE_URL_ROUTING_COMMIT-5858585858585858585858585858585858585858}"
    elif [[ "$*" == *computer-use-command-notifications* ]]; then
      printf '%s\n' "${MOCK_COMPUTER_USE_COMMAND_NOTIFICATIONS_COMMIT-4343434343434343434343434343434343434343}"
    elif [[ "$*" == *1282_drop_retired_integration_agent_tables.sql* ]]; then
      printf '%s\n' "${MOCK_RETIRED_INTEGRATION_AGENT_TABLES_COMMIT-1212121212121212121212121212121212121212}"
    else
      exit 2
    fi
    ;;
  tag)
    printf 'vm0-v1.2.3\n'
    ;;
  show)
    if [ "${2:-}" = "origin/main:.github/rollback-floors/run-reference-preparation" ]; then
      [ "${MOCK_RUN_REFERENCE_PREPARATION_AVAILABLE:-1}" = "1" ] || exit 128
      printf '%s\n' "${MOCK_RUN_REFERENCE_PREPARATION_COMMIT-66e1cae65d0468a50149f0dafab9d0d35abd0819}"
      exit 0
    fi
    if [ "${2:-}" = "origin/main:.github/rollback-floors/home-cache-capacity-reader" ]; then
      [ "${MOCK_HOME_CACHE_CAPACITY_READER_AVAILABLE:-1}" = "1" ] || exit 128
      printf '%s\n' "${MOCK_HOME_CACHE_CAPACITY_READER_COMMIT-$MOCK_HOME_CACHE_CAPACITY_READER_FLOOR}"
      exit 0
    fi
    if [ "${2:-}" = "origin/main:.github/rollback-floors/data-router-response-id" ]; then
      [ "${MOCK_DATA_ROUTER_RESPONSE_ID_AVAILABLE:-1}" = "1" ] || exit 128
      printf '%s\n' "${MOCK_DATA_ROUTER_RESPONSE_ID_COMMIT-$MOCK_DATA_ROUTER_RESPONSE_ID_FLOOR}"
      exit 0
    fi
    if [ "${2:-}" = "origin/main:.github/rollback-floors/data-router-stateless-mcp-api" ]; then
      [ "${MOCK_DATA_ROUTER_STATELESS_MCP_API_AVAILABLE:-1}" = "1" ] || exit 128
      printf '%s\n' "${MOCK_DATA_ROUTER_STATELESS_MCP_API_COMMIT-$MOCK_DATA_ROUTER_STATELESS_MCP_API_FLOOR}"
      exit 0
    fi
    if [ "${2:-}" = "origin/main:.github/rollback-floors/desktop-manifest-r2-reader" ]; then
      [ "${MOCK_DESKTOP_MANIFEST_R2_READER_AVAILABLE:-1}" = "1" ] || exit 128
      printf '%s\n' "$MOCK_DESKTOP_MANIFEST_R2_READER_FLOOR"
      exit 0
    fi
    if [ "${2:-}" = "origin/main:.github/rollback-floors/decoded-storage-capacity-reader" ]; then
      [ "${MOCK_DECODED_STORAGE_READER_AVAILABLE:-1}" = "1" ] || exit 128
      printf '%s\n' "${MOCK_DECODED_STORAGE_READER_COMMIT-$MOCK_DECODED_STORAGE_READER_FLOOR}"
      exit 0
    fi
    if [ "${2:-}" = "origin/main:.github/rollback-floors/connector-diagnostic-targets" ]; then
      [ "${MOCK_CONNECTOR_DIAGNOSTIC_TARGETS_AVAILABLE:-1}" = "1" ] || exit 128
      printf '%s\n' "${MOCK_CONNECTOR_DIAGNOSTIC_TARGETS_COMMIT-$MOCK_CONNECTOR_DIAGNOSTIC_TARGETS_FLOOR}"
      exit 0
    fi
    if [ "${2:-}" = "origin/main:.github/rollback-floors/connector-resource-split" ]; then
      [ "${MOCK_CONNECTOR_RESOURCE_SPLIT_AVAILABLE:-1}" = "1" ] || exit 128
      printf '%s\n' "${MOCK_CONNECTOR_RESOURCE_SPLIT_COMMIT-$MOCK_CONNECTOR_RESOURCE_SPLIT_FLOOR}"
      exit 0
    fi
    if [ "${2:-}" = "origin/main:.github/rollback-floors/guest-storage-output-completion-reader" ]; then
      [ "${MOCK_GUEST_STORAGE_COMPLETION_READER_AVAILABLE:-1}" = "1" ] || exit 128
      printf '%s\n' "${MOCK_GUEST_STORAGE_COMPLETION_READER_COMMIT-6060606060606060606060606060606060606060}"
      exit 0
    fi
    if [ "${2:-}" = "origin/main:.github/rollback-floors/run-storage-output-reader" ]; then
      [ "${MOCK_RUN_STORAGE_OUTPUT_READER_AVAILABLE:-1}" = "1" ] || exit 128
      printf '%s\n' "${MOCK_RUN_STORAGE_OUTPUT_READER_COMMIT-c0dec0dec0dec0dec0dec0dec0dec0dec0dec0de}"
      exit 0
    fi
    printf '[package]\nversion = "%s"\n' "${MOCK_RUNNER_VERSION:-1.2.3}"
    ;;
  rev-list)
    printf 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n'
    ;;
  *)
    echo "unexpected git command: $*" >&2
    exit 2
    ;;
esac
SH

cat >"${fake_bin}/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\n' "$*" >>"$MOCK_BOUNDARY_LOG"
if [[ "$*" == *"api.vercel.com/v6/deployments"* ]]; then
  jq -n \
    --arg sha "$TARGET_COMMIT" \
    --argjson count "${MOCK_VERCEL_MATCH_COUNT:-1}" \
    '{deployments: [range(0; $count) | {
      meta: {githubCommitSha: $sha},
      state: "READY",
      target: "production",
      url: ("api-" + (tostring) + ".vercel.app")
    }]}'
  exit 0
fi

if [ "${MOCK_RUNNER_ASSETS_VALID:-1}" = "1" ]; then
  jq -n --arg version "${MOCK_RUNNER_VERSION:-1.2.3}" '{assets: [
    {name: ("runner-v" + $version + "-aarch64-linux")},
    {name: ("runner-v" + $version + "-x86_64-linux")}
  ]}'
else
  jq -n '{assets: [{name: "runner-v1.2.3-aarch64-linux"}]}'
fi
SH

cat >"${fake_bin}/ssh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'ssh %s\n' "$*" >>"$MOCK_BOUNDARY_LOG"
if [ "${1:-}" = "-n" ]; then shift; fi
remote=$1
host=${remote#*@}
case "$host" in
  arm-1) printf 'aarch64\n' ;;
  x86-1) printf 'x86_64\n' ;;
  *) exit 255 ;;
esac
SH
chmod +x "${fake_bin}/git" "${fake_bin}/curl" "${fake_bin}/ssh"

run_resolver() {
  local output_file=$1
  shift
  : >"$output_file"
  env -i \
    PATH="${fake_bin}:$PATH" \
    HOME="${HOME:-/tmp}" \
    AWS_METAL_RUNNER_HOSTS=arm-1,x86-1 \
    GH_TOKEN=test-github-token \
    GITHUB_OUTPUT="$output_file" \
    GITHUB_REPOSITORY=okou-ai/okou \
    METAL_USER=ci \
    MOCK_BOUNDARY_LOG="${tmp_dir}/boundaries.log" \
    MOCK_CONNECTOR_RESOURCE_SPLIT_FLOOR="$connector_resource_split_floor" \
    MOCK_DECODED_STORAGE_READER_FLOOR="$decoded_storage_reader_floor" \
    MOCK_DATA_ROUTER_RESPONSE_ID_FLOOR="$data_router_response_id_floor" \
    MOCK_CONNECTOR_DIAGNOSTIC_TARGETS_FLOOR="$connector_diagnostic_targets_floor" \
    MOCK_DESKTOP_MANIFEST_R2_READER_FLOOR="$desktop_manifest_r2_reader_floor" \
    MOCK_DATA_ROUTER_STATELESS_MCP_API_FLOOR="$data_router_stateless_mcp_api_floor" \
    MOCK_HOME_CACHE_CAPACITY_READER_FLOOR="$home_cache_capacity_reader_floor" \
    TARGET_COMMIT="$target_commit" \
    VERCEL_ORG_ID=test-org \
    VERCEL_PROJECT_ID=test-project \
    VERCEL_TOKEN=test-vercel-token \
    "$@" \
    bash "$script"
}

assert_failure() {
  local expected_message=$1
  shift
  if "$@" >"${tmp_dir}/failure.out" 2>"${tmp_dir}/failure.err"; then
    fail "expected command to fail: ${expected_message}"
  fi
  if ! grep -q "$expected_message" "${tmp_dir}/failure.err"; then
    cat "${tmp_dir}/failure.err" >&2
    fail "missing failure message: ${expected_message}"
  fi
}

# A paired rollback must not reintroduce an API without current-content
# downloads or independently restart a Runner that still consumes inline claims.
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates Workflow download preparation" \
  run_resolver "${tmp_dir}/workflow-download-api.output" MOCK_WORKFLOW_DOWNLOAD_API_VALID=0
[ ! -s "${tmp_dir}/workflow-download-api.output" ] || fail "preparation-free Workflow API must not publish outputs"
if grep -Eq '^(curl|ssh) ' "${tmp_dir}/boundaries.log"; then
  fail "preparation-free Workflow API must fail before provider or host access"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "Runner release runner-rs-v1.2.3 predates Workflow download preparation" \
  run_resolver "${tmp_dir}/workflow-download-runner.output" MOCK_WORKFLOW_DOWNLOAD_RUNNER_VALID=0
[ ! -s "${tmp_dir}/workflow-download-runner.output" ] || fail "inline Workflow Runner must not publish outputs"
if grep -Eq '^ssh |releases/tags/' "${tmp_dir}/boundaries.log"; then
  fail "inline Workflow Runner must fail before Runner artifact or host access"
fi

# Publishing DAV catalog rules must not make either independently selected
# rollback artifact unable to read the catalog or bypass the iCloud rollout.
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates DAV connector preparation" \
  run_resolver "${tmp_dir}/dav-api-reader.output" MOCK_DAV_API_READER_VALID=0
[ ! -s "${tmp_dir}/dav-api-reader.output" ] || fail "pre-DAV API must not publish outputs"
if grep -Eq '^(curl|ssh) ' "${tmp_dir}/boundaries.log"; then
  fail "pre-DAV API must fail before provider or host access"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "predates DAV firewall method support" \
  run_resolver "${tmp_dir}/dav-runner-reader.output" MOCK_DAV_RUNNER_READER_VALID=0
[ ! -s "${tmp_dir}/dav-runner-reader.output" ] || fail "pre-DAV Runner must not publish outputs"
if grep -Eq '^ssh |releases/tags/' "${tmp_dir}/boundaries.log"; then
  fail "pre-DAV Runner must fail before Runner artifact or host access"
fi

# Outgoing configuration requests must not overlap a rollback that can adopt
# already-visible custom Agents as the workspace default.
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates immutable default Agent identity" \
  run_resolver "${tmp_dir}/immutable-default-agent.output" MOCK_IMMUTABLE_DEFAULT_AGENT_WRITER_TARGET_VALID=0
[ ! -s "${tmp_dir}/immutable-default-agent.output" ] || fail "mutable default Agent API must not publish outputs"
if grep -Eq '^(curl|ssh) ' "${tmp_dir}/boundaries.log"; then
  fail "mutable default Agent API must fail before provider or host access"
fi

# The prepared API reader is required even when the rollback selects an older
# Runner, because a larger current Runner may still own claimed/finalizing work.
for home_cache_case in \
  "MOCK_HOME_CACHE_CAPACITY_READER_AVAILABLE=0|Cannot read the home cache capacity reader rollback floor from main" \
  "MOCK_HOME_CACHE_CAPACITY_READER_COMMIT=|Missing or invalid home cache capacity reader rollback floor" \
  "MOCK_HOME_CACHE_CAPACITY_READER_COMMIT=not-a-commit|Missing or invalid home cache capacity reader rollback floor" \
  "MOCK_HOME_CACHE_CAPACITY_READER_ON_MAIN=0|Home cache capacity reader rollback floor is not on main" \
  "MOCK_HOME_CACHE_CAPACITY_READER_TARGET_VALID=0|Rollback target predates the home cache capacity reader"; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "${home_cache_case#*|}" \
    run_resolver "${tmp_dir}/home-cache-capacity.output" "${home_cache_case%%|*}"
  [ ! -s "${tmp_dir}/home-cache-capacity.output" ] || fail "incompatible home cache API must not publish outputs"
  if grep -Eq '^(curl|ssh) ' "${tmp_dir}/boundaries.log"; then
    fail "incompatible home cache API must fail before provider or host access"
  fi
done

# Missing or unmerged current-main policy must fail before provider or host access.
for data_router_case in \
  "MOCK_DATA_ROUTER_RESPONSE_ID_AVAILABLE=0|Cannot read the Data Router response ID rollback floor from main" \
  "MOCK_DATA_ROUTER_RESPONSE_ID_COMMIT=invalid|Missing or invalid Data Router response ID rollback floor" \
  "MOCK_DATA_ROUTER_RESPONSE_ID_ON_MAIN=0|Data Router response ID rollback floor is not on main"; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "${data_router_case#*|}" \
    run_resolver "${tmp_dir}/data-router-policy.output" "${data_router_case%%|*}"
  [ ! -s "${tmp_dir}/data-router-policy.output" ] || fail "invalid Data Router policy must not publish outputs"
  if grep -Eq '^(curl|ssh) ' "${tmp_dir}/boundaries.log"; then
    fail "invalid Data Router policy must fail before provider or host access"
  fi
done

# Reject the old protocol in both a paired rollback and a compatible API target
# whose independently resolved Runner artifact still predates response tracking.
for data_router_api_target in bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb "$target_commit"; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Runner release runner-rs-v0.237.7 predates Data Router response ID tracking" \
    run_resolver "${tmp_dir}/data-router-old-runner.output" \
    TARGET_COMMIT="$data_router_api_target" MOCK_RUNNER_VERSION=0.237.7 \
    MOCK_DATA_ROUTER_RESPONSE_ID_RUNNER_VALID=0
  [ ! -s "${tmp_dir}/data-router-old-runner.output" ] || fail "old Data Router protocol must not publish outputs"
  if grep -Eq '^ssh |releases/tags/' "${tmp_dir}/boundaries.log"; then
    fail "old Data Router protocol must fail before Runner artifact or host access"
  fi
done

# The first Runner release containing #43113 remains eligible.
run_resolver "${tmp_dir}/data-router-compatible.output" MOCK_RUNNER_VERSION=0.237.8 \
  >"${tmp_dir}/data-router-compatible.log"
grep -Fxq 'runner_version=0.237.8' "${tmp_dir}/data-router-compatible.output" || fail "compatible Data Router Runner must remain eligible"

# Current-main policy must reject pre-preparation APIs before provider or host
# access. Valid descendants still resolve through the existing success case.
for desktop_manifest_case in \
  "MOCK_DESKTOP_MANIFEST_R2_READER_AVAILABLE=0|Cannot read the Desktop manifest R2 reader rollback floor from main" \
  "MOCK_DESKTOP_MANIFEST_R2_READER_ON_MAIN=0|Desktop manifest R2 reader rollback floor is not on main" \
  "MOCK_DESKTOP_MANIFEST_R2_READER_TARGET_VALID=0|Rollback target predates the Desktop manifest R2 reader"; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "${desktop_manifest_case#*|}" \
    run_resolver "${tmp_dir}/desktop-manifest-r2-reader.output" "${desktop_manifest_case%%|*}"
  [ ! -s "${tmp_dir}/desktop-manifest-r2-reader.output" ] || fail "unsupported Desktop manifest reader must not publish outputs"
  if grep -Eq '^(curl|ssh) ' "${tmp_dir}/boundaries.log"; then
    fail "Desktop manifest R2 policy must reject before provider or host access"
  fi
done

# APIs before #43447 send envelope-less JSON-RPC that Router no longer serves.
for data_router_mcp_case in \
  "MOCK_DATA_ROUTER_STATELESS_MCP_API_AVAILABLE=0|Cannot read the Data Router stateless MCP API rollback floor from main" \
  "MOCK_DATA_ROUTER_STATELESS_MCP_API_COMMIT=not-a-commit|Missing or invalid Data Router stateless MCP API rollback floor" \
  "MOCK_DATA_ROUTER_STATELESS_MCP_API_ON_MAIN=0|Data Router stateless MCP API rollback floor is not on main" \
  "MOCK_DATA_ROUTER_STATELESS_MCP_API_TARGET_VALID=0|Rollback target predates the Data Router stateless MCP requests"; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "${data_router_mcp_case#*|}" \
    run_resolver "${tmp_dir}/data-router-stateless-mcp.output" "${data_router_mcp_case%%|*}"
  [ ! -s "${tmp_dir}/data-router-stateless-mcp.output" ] || fail "pre-stateless Data Router API must not publish outputs"
  if grep -Eq '^(curl|ssh) ' "${tmp_dir}/boundaries.log"; then
    fail "Data Router stateless MCP policy must reject before provider or host access"
  fi
done

for connector_case in \
  "MOCK_CONNECTOR_RESOURCE_SPLIT_AVAILABLE=0|Cannot read the Connector resource split rollback floor from main" \
  "MOCK_CONNECTOR_RESOURCE_SPLIT_COMMIT=|Missing or invalid Connector resource split rollback floor" \
  "MOCK_CONNECTOR_RESOURCE_SPLIT_COMMIT=not-a-commit|Missing or invalid Connector resource split rollback floor" \
  "MOCK_CONNECTOR_RESOURCE_SPLIT_ON_MAIN=0|Connector resource split rollback floor is not on main" \
  "MOCK_CONNECTOR_RESOURCE_SPLIT_TARGET_VALID=0|Rollback target predates the Connector resource split"; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "${connector_case#*|}" \
    run_resolver "${tmp_dir}/connector-resource-split.output" "${connector_case%%|*}"
  [ ! -s "${tmp_dir}/connector-resource-split.output" ] || fail "incompatible Connector API must not publish outputs"
  if grep -Eq '^(curl|ssh) ' "${tmp_dir}/boundaries.log"; then
    fail "Connector resource split policy must reject before artifact or host access"
  fi
done

# Missing policy must fail before any provider or host access.
for decoded_reader_case in \
  "MOCK_DECODED_STORAGE_READER_AVAILABLE=0|Cannot read the decoded storage capacity reader rollback floor from main" \
  "MOCK_DECODED_STORAGE_READER_COMMIT=|Missing or invalid decoded storage capacity reader rollback floor" \
  "MOCK_DECODED_STORAGE_READER_COMMIT=invalid|Missing or invalid decoded storage capacity reader rollback floor" \
  "MOCK_DECODED_STORAGE_READER_ON_MAIN=0|Decoded storage capacity reader rollback floor is not on main"; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "${decoded_reader_case#*|}" \
    run_resolver "${tmp_dir}/decoded-reader-policy.output" "${decoded_reader_case%%|*}"
  [ ! -s "${tmp_dir}/decoded-reader-policy.output" ] || fail "invalid decoded reader policy must not publish outputs"
  if grep -Eq '^(curl|ssh) ' "${tmp_dir}/boundaries.log"; then
    fail "invalid decoded reader policy must fail before provider or host access"
  fi
done

# A compatible API does not make an independently selected old Runner safe.
: >"${tmp_dir}/boundaries.log"
assert_failure "predates the decoded storage capacity reader" \
  run_resolver "${tmp_dir}/decoded-reader-runner.output" MOCK_DECODED_STORAGE_READER_RUNNER_VALID=0
[ ! -s "${tmp_dir}/decoded-reader-runner.output" ] || fail "incompatible decoded reader must not publish outputs"
if grep -Eq '^ssh |releases/tags/' "${tmp_dir}/boundaries.log"; then
  fail "incompatible decoded reader must fail before Runner artifact or host access"
fi

# The exact prepared Runner remains a valid rollback; activation is not the floor.
run_resolver "${tmp_dir}/decoded-reader-exact.output" \
  MOCK_DECODED_STORAGE_READER_COMMIT=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  >"${tmp_dir}/decoded-reader-exact.log"
[ -s "${tmp_dir}/decoded-reader-exact.output" ] || fail "exact prepared Runner must remain eligible"

for diagnostic_case in \
  "MOCK_CONNECTOR_DIAGNOSTIC_TARGETS_AVAILABLE=0|Cannot read the Connector diagnostic targets rollback floor from main" \
  "MOCK_CONNECTOR_DIAGNOSTIC_TARGETS_COMMIT=|Missing or invalid Connector diagnostic targets rollback floor" \
  "MOCK_CONNECTOR_DIAGNOSTIC_TARGETS_COMMIT=not-a-commit|Missing or invalid Connector diagnostic targets rollback floor" \
  "MOCK_CONNECTOR_DIAGNOSTIC_TARGETS_ON_MAIN=0|Connector diagnostic targets rollback floor is not on main" \
  "MOCK_CONNECTOR_DIAGNOSTIC_TARGETS_TARGET_VALID=0|Rollback target predates canonical Connector diagnostic targets"; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "${diagnostic_case#*|}" \
    run_resolver "${tmp_dir}/connector-diagnostic-targets.output" "${diagnostic_case%%|*}"
  [ ! -s "${tmp_dir}/connector-diagnostic-targets.output" ] || fail "incompatible diagnostic API must not publish outputs"
  if grep -Eq '^(curl|ssh) ' "${tmp_dir}/boundaries.log"; then
    fail "Connector diagnostic policy must reject before artifact or host access"
  fi
done

# A compatible API target must resolve its independently compatible Runner tag.
: >"${tmp_dir}/boundaries.log"
output_file="${tmp_dir}/success.output"
run_resolver "$output_file" >"${tmp_dir}/success.log"
grep -Fxq "git show origin/main:.github/rollback-floors/home-cache-capacity-reader" "${tmp_dir}/boundaries.log" || fail "home cache floor must come from current main"
grep -Fxq "git merge-base --is-ancestor ${home_cache_capacity_reader_floor} origin/main" "${tmp_dir}/boundaries.log" || fail "home cache floor must name a merged main commit"
grep -Fxq "git merge-base --is-ancestor ${home_cache_capacity_reader_floor} ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API must accept larger home cache inventories"
grep -Fxq "git show origin/main:.github/rollback-floors/connector-diagnostic-targets" "${tmp_dir}/boundaries.log" || fail "diagnostic floor must come from current main"
grep -Fxq "git merge-base --is-ancestor ${connector_diagnostic_targets_floor} origin/main" "${tmp_dir}/boundaries.log" || fail "diagnostic floor must name a merged main commit"
grep -Fxq "git merge-base --is-ancestor ${connector_diagnostic_targets_floor} ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API must return canonical diagnostic targets"
grep -Fxq "git merge-base --is-ancestor e01702c7d762b5d2a76d557db77ccaf19c4f95c8 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must accept structured-only disk telemetry"
grep -Fxq "git merge-base --is-ancestor 625c4607ccdcd2d46a5c7227f61419928035e13f bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" "${tmp_dir}/boundaries.log" || fail "retained Runner artifact must contain the pair-free disk telemetry writer"
grep -Fxq "git merge-base --is-ancestor 5757575757575757575757575757575757575757 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "eligible API artifact must satisfy the canonical VNC producer floor"
grep -Fxq "git merge-base --is-ancestor 52525252525252525252525252525252525252ab ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the Workflow namespace preparation floor"
grep -Fxq "git merge-base --is-ancestor 6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must satisfy the Pi memory retirement floor"
grep -Fxq "git merge-base --is-ancestor 4558c9fac46ce1a96a25745b477b32b70dab7ae6 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the chat thread draft child-only writer floor"
grep -Fxq "git merge-base --is-ancestor 7a187fa0a3fe2f23a134c7cdff66ee9c7e2bdb38 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the chat thread draft owner key floor"
grep -Fxq "git merge-base --is-ancestor 2222222222222222222222222222222222222222 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the public_brand retirement floor"
grep -Fxq "git merge-base --is-ancestor 3d93ff8d4b4a07a5888e3030e69b340f40da0ad4 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the R2-only chat thread snapshot floor"
grep -Fxq "git merge-base --is-ancestor 3333333333333333333333333333333333333333 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the agent_runs heartbeat column drop floor"
grep -Fxq "git merge-base --is-ancestor 4444444444444444444444444444444444444444 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the personal subscription account-only floor"
grep -Fxq "git merge-base --is-ancestor cdeec36c168636b1a2e510e660eb6139c9c4e07a ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the computer-use audit column cutover floor"
grep -Fxq "git merge-base --is-ancestor 98b5515ae2874128734b19a17b96dc8c6c7afe47 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the chat search GIN maintenance removal floor"
grep -Fxq "git merge-base --is-ancestor ee863a302a6c547f94e50ec4069f70910d68bee2 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the advisory replacement protocol floor"
grep -Fxq "git merge-base --is-ancestor 84ac71914345b8360f3df43cc2cd47f0a8af7a23 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the queued run promotion removal floor"
grep -Fxq "git merge-base --is-ancestor 553fc566b7e9be2cd4a8c1de314d55939b99490a ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the unified chat queue release floor"
grep -Fxq "git merge-base --is-ancestor fd5104417a0cf41116ce9cb9c1aeb2fa3b5e14da ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the runner steer endpoints floor"
grep -Fxq "git merge-base --is-ancestor 45b537a596a153a91b76c3bc7223187840f52775 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the video generation retirement floor"
grep -Fxq "git merge-base --is-ancestor 5555555555555555555555555555555555555555 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the chat thread snapshot JSONB drop floor"
grep -Fxq "git merge-base --is-ancestor 6666666666666666666666666666666666666666 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the Stripe Portal purpose-only floor"
grep -Fxq "git merge-base --is-ancestor 8888888888888888888888888888888888888888 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the retired preference column drop floor"
grep -Fxq "git merge-base --is-ancestor 1212121212121212121212121212121212121212 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the retired integration agent table drop floor"
grep -Fxq "git merge-base --is-ancestor eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the video model column drop floor"
grep -Fxq "git merge-base --is-ancestor 1313131313131313131313131313131313131313 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the image model thread column drop floor"
grep -Fxq "git merge-base --is-ancestor 1515151515151515151515151515151515151515 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the video entitlement column drop floor"
grep -Fxq "git log --reverse --first-parent --diff-filter=A --format=%H origin/main -- turbo/packages/db/src/migrations/1330_drop_retired_model_configuration_columns.sql" "${tmp_dir}/boundaries.log" || fail "retired model configuration floor must resolve the canonical main migration"
grep -Fxq "git merge-base --is-ancestor 1616161616161616161616161616161616161616 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the retired model configuration column drop floor"
grep -Fxq "git log --reverse --first-parent --diff-filter=A --format=%H origin/main -- turbo/packages/db/src/migrations/1332_drop_chat_thread_provider_pin_columns.sql" "${tmp_dir}/boundaries.log" || fail "chat thread provider pin floor must resolve the canonical main migration"
grep -Fxq "git merge-base --is-ancestor 1717171717171717171717171717171717171717 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the chat thread provider pin column drop floor"
grep -Fxq "git log --reverse --first-parent --diff-filter=A --format=%H origin/main -- turbo/packages/db/src/migrations/1333_drop_dead_model_provider_columns.sql" "${tmp_dir}/boundaries.log" || fail "dead model provider column floor must resolve the canonical main migration"
grep -Fxq "git merge-base --is-ancestor 1818181818181818181818181818181818181818 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the dead model provider column drop floor"
grep -Fxq "git log --reverse --first-parent --diff-filter=A --format=%H origin/main -- turbo/packages/db/src/migrations/1334_connector_catalog_release_2_contraction.sql" "${tmp_dir}/boundaries.log" || fail "connector catalog Release 2 floor must resolve the canonical main migration"
grep -Fxq "git merge-base --is-ancestor 1919191919191919191919191919191919191919 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the connector catalog Release 2 floor"
grep -Fxq "git log --reverse --first-parent --diff-filter=A --format=%H origin/main -- turbo/packages/db/src/migrations/1338_retire_model_route_state.sql" "${tmp_dir}/boundaries.log" || fail "model route state floor must resolve the canonical main migration"
grep -Fxq "git merge-base --is-ancestor 3737373737373737373737373737373737373737 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the model route state floor"
grep -Fxq "git log --reverse --first-parent --diff-filter=A --format=%H origin/main -- turbo/packages/db/src/migrations/1343_retire_pi_stable_context.sql" "${tmp_dir}/boundaries.log" || fail "Pi stable-context retirement floor must resolve the canonical main migration"
grep -Fxq "git merge-base --is-ancestor 3838383838383838383838383838383838383838 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the Pi stable-context retirement floor"
grep -Fxq "git log --reverse --first-parent --diff-filter=A --format=%H origin/main -- turbo/packages/db/src/runtime/org-members-metadata.ts" "${tmp_dir}/boundaries.log" || fail "Native member runtime floor must resolve the canonical preparation on main"
grep -Fxq "git merge-base --is-ancestor 4747474747474747474747474747474747474747 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the Native member runtime preparation floor"
grep -Fxq "git log --reverse --first-parent --diff-filter=A --format=%H origin/main -- turbo/packages/db/src/migrations/1356_drop_organization_usage_allowance.sql" "${tmp_dir}/boundaries.log" || fail "Usage Allowance floor must resolve the canonical main migration"
grep -Fxq "git log --reverse --first-parent --diff-filter=A --format=%H origin/main -- turbo/packages/db/src/migrations/1365_tailscale_private_ssh.sql" "${tmp_dir}/boundaries.log" || fail "SSH transport floor must resolve the canonical main migration"
grep -Fxq "git log --reverse --first-parent --diff-filter=A --format=%H origin/main -- turbo/packages/db/src/migrations/1382_retire_official_result_email_runtime.sql" "${tmp_dir}/boundaries.log" || fail "Official result-email runtime retirement floor must resolve the canonical main migration"
grep -Fxq "git merge-base --is-ancestor 4949494949494949494949494949494949494949 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the Official result-email runtime retirement floor"
grep -Fxq "git log --reverse --first-parent --diff-filter=A --format=%H origin/main -- turbo/packages/db/src/migrations/1386_drop_official_result_email_storage.sql" "${tmp_dir}/boundaries.log" || fail "Official result-email storage contraction floor must resolve the canonical main migration"
grep -Fxq "git merge-base --is-ancestor 5050505050505050505050505050505050505050 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the Official result-email storage contraction floor"
grep -Fxq "git log --reverse --first-parent --diff-filter=A --format=%H origin/main -- turbo/packages/db/src/runtime/agent-session.ts" "${tmp_dir}/boundaries.log" || fail "Session storage-mount floor must resolve the shipped main runtime mapping"
grep -Fxq "git merge-base --is-ancestor 5252525252525252525252525252525252525252 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the Session storage-mount runtime floor"
grep -Fxq "git merge-base --is-ancestor 4141414141414141414141414141414141414141 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the Usage Allowance retirement floor"
grep -qx "target_commit=${target_commit}" "$output_file" || fail "missing target commit output"
grep -qx "api_deployment_url=https://api-0.vercel.app" "$output_file" || fail "missing API deployment output"
grep -qx "runner_version=1.2.3" "$output_file" || fail "missing Runner version output"
grep -qx "runner_tag=runner-rs-v1.2.3" "$output_file" || fail "missing retained Runner tag output"
grep -Fxq "git merge-base --is-ancestor 968063848aea8cf54acd6f56facdf7cdcbd79051 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "API target must include the independent finalizing source writer"
grep -Fxq "git merge-base --is-ancestor 430cb92b5431e1554d0a1dceed6d9cfb27762921 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "API target must include the wss_ingress_service_active-free Runner state mapping"
grep -Fxq "git merge-base --is-ancestor b610ff61043274157618e3925b13a66dc56ef84b bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" "${tmp_dir}/boundaries.log" || fail "selected Runner tag must independently include the finalizing source reader"
runner_matrix=$(sed -n 's/^runner_matrix=//p' "$output_file")
jq -e 'length == 2 and .[0].id == "arm64" and .[1].id == "x86_64"' >/dev/null <<<"$runner_matrix" || fail "unexpected Runner matrix"

grep -Fxq "git merge-base --is-ancestor a635ec3afa20cdb5df9c8125afe6cec24ef53e16 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the versioned Pi OpenRouter writer floor"
grep -Fxq "git merge-base --is-ancestor b6919718b6d856dfa3a7c500b6e899dd3fde7674 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the model execution capture writer floor"
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the model execution capture writer" \
  run_resolver "${tmp_dir}/model-execution-capture-floor.output" MOCK_MODEL_EXECUTION_CAPTURE_WRITER_FLOOR_VALID=0
[ ! -s "${tmp_dir}/model-execution-capture-floor.output" ] || fail "pre-capture writer must not publish rollback outputs"
if grep -Eq '^(curl|ssh) ' "${tmp_dir}/boundaries.log"; then
  fail "pre-capture writer must fail before artifact or host access"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the structured-only disk telemetry reader" \
  run_resolver "${tmp_dir}/structured-disk-reader-floor.output" MOCK_STRUCTURED_DISK_READER_FLOOR_VALID=0
grep -Fq 'e01702c7d762b5d2a76d557db77ccaf19c4f95c8' "${tmp_dir}/failure.err" || fail "disk telemetry rejection must identify the receiving preparation commit"
[ ! -s "${tmp_dir}/structured-disk-reader-floor.output" ] || fail "required-pair API must not publish rollback outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "required-pair API must fail before artifact or host access"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the independent finalizing source writer" \
  run_resolver "${tmp_dir}/finalizing-source-api-floor.output" MOCK_FINALIZING_SOURCE_API_WRITER_FLOOR_VALID=0
[ ! -s "${tmp_dir}/finalizing-source-api-floor.output" ] || fail "old-source API must not publish rollback outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "old-source API must fail before artifact or host access"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the wss_ingress_service_active-free Runner state mapping" \
  run_resolver "${tmp_dir}/runner-state-wss-ingress-floor.output" MOCK_RUNNER_STATE_WSS_INGRESS_FREE_FLOOR_VALID=0
[ ! -s "${tmp_dir}/runner-state-wss-ingress-floor.output" ] || fail "ingress-mapping API must not publish rollback outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "ingress-mapping API must fail before artifact or host access"
fi

# The preparation remains a valid target independently of the later DROP.
run_resolver "${tmp_dir}/managed-data-runtime-exact.output" \
  TARGET_COMMIT=b220a504c5e633de162791f1216c4458188ffe72 \
  >"${tmp_dir}/managed-data-runtime-exact.log"
grep -qx "target_commit=b220a504c5e633de162791f1216c4458188ffe72" \
  "${tmp_dir}/managed-data-runtime-exact.output" || fail "exact Data runtime preparation must remain eligible"

: >"${tmp_dir}/boundaries.log"
assert_failure "predates the independent finalizing source reader" \
  run_resolver "${tmp_dir}/finalizing-source-runner-floor.output" MOCK_FINALIZING_SOURCE_RUNNER_READER_FLOOR_VALID=0
[ ! -s "${tmp_dir}/finalizing-source-runner-floor.output" ] || fail "strict old Runner must not publish rollback outputs"
if grep -Eq '^curl .*releases/tags/|^ssh ' "${tmp_dir}/boundaries.log"; then
  fail "strict old Runner must fail before Runner artifact or host access"
fi

for storage_reader_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Missing or invalid Run Storage-output reader rollback floor" \
    run_resolver "${tmp_dir}/storage-reader-policy.output" "MOCK_RUN_STORAGE_OUTPUT_READER_COMMIT=${storage_reader_commit}"
  [ ! -s "${tmp_dir}/storage-reader-policy.output" ] || fail "invalid Storage reader policy must not publish outputs"
  if grep -Eq '^(curl|ssh) ' "${tmp_dir}/boundaries.log"; then
    fail "invalid Storage reader policy must fail before artifact or host access"
  fi
done

for storage_reader_case in \
  "MOCK_RUN_STORAGE_OUTPUT_READER_AVAILABLE=0|Cannot read the Run Storage-output reader rollback floor from main" \
  "MOCK_RUN_STORAGE_OUTPUT_READER_ON_MAIN=0|Run Storage-output reader rollback floor is not on main" \
  "MOCK_RUN_STORAGE_OUTPUT_READER_FLOOR_VALID=0|Rollback target predates the Run Storage-output log reader"; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "${storage_reader_case#*|}" \
    run_resolver "${tmp_dir}/storage-reader-floor.output" "${storage_reader_case%%|*}"
  [ ! -s "${tmp_dir}/storage-reader-floor.output" ] || fail "unsupported Storage reader must not publish outputs"
  if grep -Eq '^(curl|ssh) ' "${tmp_dir}/boundaries.log"; then
    fail "unsupported Storage reader must fail before artifact or host access"
  fi
done

: >"${tmp_dir}/boundaries.log"
assert_failure "predates the Guest Storage-output completion writer" \
  run_resolver "${tmp_dir}/completion-writer-floor.output" MOCK_GUEST_STORAGE_COMPLETION_WRITER_FLOOR_VALID=0
[ ! -s "${tmp_dir}/completion-writer-floor.output" ] || fail "old Guest writer must not publish rollback outputs"
if grep -Eq '^ssh |releases/tags/' "${tmp_dir}/boundaries.log"; then
  fail "old Guest writer must fail before Runner artifact or host access"
fi

for context_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged Storage debug contract cleanup on main" \
    run_resolver "${tmp_dir}/context-policy.output" "MOCK_STORAGE_DEBUG_CONTRACTS_COMMIT=${context_commit}"
  [ ! -s "${tmp_dir}/context-policy.output" ] || fail "invalid context policy must not publish outputs"
  if grep -Eq '^(curl|ssh) ' "${tmp_dir}/boundaries.log"; then
    fail "invalid context policy must fail before artifact or host access"
  fi
done

: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the Storage debug contract cleanup" \
  run_resolver "${tmp_dir}/context-floor.output" MOCK_STORAGE_DEBUG_CONTRACTS_FLOOR_VALID=0
[ ! -s "${tmp_dir}/context-floor.output" ] || fail "pre-cleanup API must not publish outputs"
grep -Fq '6161616161616161616161616161616161616161' "${tmp_dir}/failure.err" || fail "context floor must identify its merged cleanup"
grep -Fxq "git log --reverse --first-parent --diff-filter=A --format=%H origin/main -- .github/rollback-floors/storage-debug-contracts" "${tmp_dir}/boundaries.log" || fail "context floor must resolve main history, not target history"
if grep -Eq '^(curl|ssh) ' "${tmp_dir}/boundaries.log"; then
  fail "pre-cleanup API must fail before artifact or host access"
fi

: >"${tmp_dir}/boundaries.log"
run_resolver "${tmp_dir}/context-exact.output" "MOCK_STORAGE_DEBUG_CONTRACTS_COMMIT=${target_commit}" >"${tmp_dir}/context-exact.log"
[ -s "${tmp_dir}/context-exact.output" ] || fail "exact context cleanup artifact must remain eligible"

for completion_reader_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Missing or invalid Guest Storage-output completion reader rollback floor" \
    run_resolver "${tmp_dir}/completion-reader-policy.output" "MOCK_GUEST_STORAGE_COMPLETION_READER_COMMIT=${completion_reader_commit}"
  [ ! -s "${tmp_dir}/completion-reader-policy.output" ] || fail "invalid completion reader policy must not publish outputs"
  if grep -Eq '^(curl|ssh) ' "${tmp_dir}/boundaries.log"; then
    fail "invalid completion reader policy must fail before artifact or host access"
  fi
done

for completion_reader_case in \
  "MOCK_GUEST_STORAGE_COMPLETION_READER_AVAILABLE=0|Cannot read the Guest Storage-output completion reader rollback floor from main" \
  "MOCK_GUEST_STORAGE_COMPLETION_READER_ON_MAIN=0|Guest Storage-output completion reader rollback floor is not on main" \
  "MOCK_GUEST_STORAGE_COMPLETION_READER_FLOOR_VALID=0|Rollback target predates the Guest Storage-output completion reader"; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "${completion_reader_case#*|}" \
    run_resolver "${tmp_dir}/completion-reader-floor.output" "${completion_reader_case%%|*}"
  [ ! -s "${tmp_dir}/completion-reader-floor.output" ] || fail "unsupported completion reader must not publish outputs"
  if grep -Eq '^(curl|ssh) ' "${tmp_dir}/boundaries.log"; then
    fail "unsupported completion reader must fail before artifact or host access"
  fi
done

: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the versioned Pi OpenRouter writer" \
  run_resolver "${tmp_dir}/pi-openrouter-versioned-writer-floor.output" MOCK_PI_OPENROUTER_VERSIONED_WRITER_FLOOR_VALID=0
grep -Fq 'a635ec3afa20cdb5df9c8125afe6cec24ef53e16' "${tmp_dir}/failure.err" || fail "Pi writer rejection must identify the permanent versioned writer commit"
[ ! -s "${tmp_dir}/pi-openrouter-versioned-writer-floor.output" ] || fail "unversioned Pi writer must not publish rollback outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "unversioned Pi writer must fail before artifact or host access"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the chat thread draft child-only writer" \
  run_resolver "${tmp_dir}/chat-thread-draft-floor.output" MOCK_CHAT_THREAD_DRAFT_FLOOR_VALID=0
grep -Fq '4558c9fac46ce1a96a25745b477b32b70dab7ae6' "${tmp_dir}/failure.err" || fail "draft contraction rejection must identify the child-only writer commit"
[ ! -s "${tmp_dir}/chat-thread-draft-floor.output" ] || fail "pre-child-writer API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "pre-child-writer API target must fail before artifact or host access"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the computer-use audit approval column cutover" \
  run_resolver "${tmp_dir}/computer-use-audit-floor.output" MOCK_COMPUTER_USE_AUDIT_FLOOR_VALID=0
grep -Fq 'cdeec36c168636b1a2e510e660eb6139c9c4e07a' "${tmp_dir}/failure.err" || fail "audit column contraction rejection must identify the cutover commit"
[ ! -s "${tmp_dir}/computer-use-audit-floor.output" ] || fail "pre-cutover API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "pre-cutover API target must fail before artifact or host access"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the chat search GIN maintenance removal" \
  run_resolver "${tmp_dir}/chat-search-gin-floor.output" MOCK_CHAT_SEARCH_GIN_FLOOR_VALID=0
grep -Fq '98b5515ae2874128734b19a17b96dc8c6c7afe47' "${tmp_dir}/failure.err" || fail "pgstattuple drop rejection must identify the maintenance removal commit"
[ ! -s "${tmp_dir}/chat-search-gin-floor.output" ] || fail "pre-removal API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "pre-removal API target must fail before artifact or host access"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the advisory lock replacement protocols" \
  run_resolver "${tmp_dir}/advisory-lock-preparation-floor.output" MOCK_ADVISORY_LOCK_PREPARATION_FLOOR_VALID=0
grep -Fq 'ee863a302a6c547f94e50ec4069f70910d68bee2' "${tmp_dir}/failure.err" || fail "advisory retirement rejection must identify the preparation commit"
[ ! -s "${tmp_dir}/advisory-lock-preparation-floor.output" ] || fail "pre-preparation API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "pre-preparation API target must fail before artifact or host access"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the queued run promotion removal" \
  run_resolver "${tmp_dir}/queued-run-promotion-floor.output" MOCK_QUEUED_RUN_PROMOTION_FLOOR_VALID=0
grep -Fq '84ac71914345b8360f3df43cc2cd47f0a8af7a23' "${tmp_dir}/failure.err" || fail "agent_run_queue drop rejection must identify the queued run promotion removal commit"
[ ! -s "${tmp_dir}/queued-run-promotion-floor.output" ] || fail "pre-#37063 API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "pre-#37063 API target must fail before artifact or host access"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the unified chat queue release" \
  run_resolver "${tmp_dir}/unified-chat-queue-floor.output" MOCK_UNIFIED_CHAT_QUEUE_FLOOR_VALID=0
grep -Fq '553fc566b7e9be2cd4a8c1de314d55939b99490a' "${tmp_dir}/failure.err" || fail "active input delivery drop rejection must identify the release 3 merge commit"
[ ! -s "${tmp_dir}/unified-chat-queue-floor.output" ] || fail "pre-#37082 API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "pre-#37082 API target must fail before artifact or host access"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the runner steer endpoints" \
  run_resolver "${tmp_dir}/runner-steer-endpoints-floor.output" MOCK_RUNNER_STEER_ENDPOINTS_FLOOR_VALID=0
grep -Fq 'fd5104417a0cf41116ce9cb9c1aeb2fa3b5e14da' "${tmp_dir}/failure.err" || fail "steer endpoint rejection must identify the release 4 merge commit"
[ ! -s "${tmp_dir}/runner-steer-endpoints-floor.output" ] || fail "pre-#37115 API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "pre-#37115 API target must fail before artifact or host access"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the video generation retirement" \
  run_resolver "${tmp_dir}/video-generation-retirement-floor.output" MOCK_VIDEO_GENERATION_RETIREMENT_FLOOR_VALID=0
grep -Fq '45b537a596a153a91b76c3bc7223187840f52775' "${tmp_dir}/failure.err" || fail "video retirement rejection must identify the #37242 merge commit"
[ ! -s "${tmp_dir}/video-generation-retirement-floor.output" ] || fail "pre-#37242 API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "pre-#37242 API target must fail before artifact or host access"
fi

for cutover_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged Stripe Portal purpose-only cutover" \
    run_resolver "${tmp_dir}/stripe-portal-history.output" "MOCK_STRIPE_PORTAL_COMMIT=${cutover_commit}"
  [ ! -s "${tmp_dir}/stripe-portal-history.output" ] || fail "invalid Stripe Portal history must not publish outputs"
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the Stripe Portal purpose-only cutover" \
  run_resolver "${tmp_dir}/stripe-portal-floor.output" MOCK_STRIPE_PORTAL_FLOOR_VALID=0
[ ! -s "${tmp_dir}/stripe-portal-floor.output" ] || fail "pre-cutover API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "Stripe Portal cutover floor must fail before artifact or host access"
fi

for retirement_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged Chat Event schema header retirement" \
    run_resolver "${tmp_dir}/chat-event-schema-header-history.output" "MOCK_CHAT_EVENT_SCHEMA_HEADER_COMMIT=${retirement_commit}"
  [ ! -s "${tmp_dir}/chat-event-schema-header-history.output" ] || fail "invalid Chat Event schema header history must not publish outputs"
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the Chat Event schema header retirement" \
  run_resolver "${tmp_dir}/chat-event-schema-header-floor.output" MOCK_CHAT_EVENT_SCHEMA_HEADER_FLOOR_VALID=0
[ ! -s "${tmp_dir}/chat-event-schema-header-floor.output" ] || fail "pre-retirement API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "Chat Event schema header floor must fail before artifact or host access"
fi

for drop_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged retired preference column drop" \
    run_resolver "${tmp_dir}/retired-preference-columns-history.output" "MOCK_RETIRED_PREFERENCE_COLUMNS_COMMIT=${drop_commit}"
  [ ! -s "${tmp_dir}/retired-preference-columns-history.output" ] || fail "invalid retired preference column drop history must not publish outputs"
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the retired preference column drop" \
  run_resolver "${tmp_dir}/retired-preference-columns-floor.output" MOCK_RETIRED_PREFERENCE_COLUMNS_FLOOR_VALID=0
[ ! -s "${tmp_dir}/retired-preference-columns-floor.output" ] || fail "pre-drop API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "retired preference column drop floor must fail before artifact or host access"
fi

for drop_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged video model column drop" \
    run_resolver "${tmp_dir}/video-model-columns-history.output" "MOCK_VIDEO_MODEL_COLUMNS_COMMIT=${drop_commit}"
  [ ! -s "${tmp_dir}/video-model-columns-history.output" ] || fail "invalid video model column drop history must not publish outputs"
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the video model column drop" \
  run_resolver "${tmp_dir}/video-model-columns-floor.output" MOCK_VIDEO_MODEL_COLUMNS_FLOOR_VALID=0
[ ! -s "${tmp_dir}/video-model-columns-floor.output" ] || fail "pre-drop API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "video model column drop floor must fail before artifact or host access"
fi

for drop_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged image model thread column drop" \
    run_resolver "${tmp_dir}/image-model-thread-columns-history.output" "MOCK_IMAGE_MODEL_THREAD_COLUMNS_COMMIT=${drop_commit}"
  [ ! -s "${tmp_dir}/image-model-thread-columns-history.output" ] || fail "invalid image model thread column drop history must not publish outputs"
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the image model thread column drop" \
  run_resolver "${tmp_dir}/image-model-thread-columns-floor.output" MOCK_IMAGE_MODEL_THREAD_COLUMNS_FLOOR_VALID=0
[ ! -s "${tmp_dir}/image-model-thread-columns-floor.output" ] || fail "pre-drop API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "image model thread column drop floor must fail before artifact or host access"
fi

# This is the current rollback safety boundary, not retired-feature absence.
for drop_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged video entitlement column drop" \
    run_resolver "${tmp_dir}/video-entitlement-history.output" "MOCK_VIDEO_ENTITLEMENT_COMMIT=${drop_commit}"
  [ ! -s "${tmp_dir}/video-entitlement-history.output" ] || fail "invalid video entitlement history must not publish outputs"
  if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
    fail "invalid video entitlement history must fail before artifact or host access"
  fi
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the video entitlement column drop" \
  run_resolver "${tmp_dir}/video-entitlement-floor.output" MOCK_VIDEO_ENTITLEMENT_FLOOR_VALID=0
grep -Fq '1515151515151515151515151515151515151515' "${tmp_dir}/failure.err" || fail "video entitlement rejection must identify the canonical drop commit"
[ ! -s "${tmp_dir}/video-entitlement-floor.output" ] || fail "incompatible entitlement API must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "video entitlement floor must fail before artifact or host access"
fi

for drop_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged retired model configuration column drop" \
    run_resolver "${tmp_dir}/retired-model-configuration-history.output" "MOCK_RETIRED_MODEL_CONFIGURATION_COMMIT=${drop_commit}"
  [ ! -s "${tmp_dir}/retired-model-configuration-history.output" ] || fail "invalid retired model configuration history must not publish outputs"
  if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
    fail "invalid retired model configuration history must fail before artifact or host access"
  fi
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the retired model configuration column drop" \
  run_resolver "${tmp_dir}/retired-model-configuration-floor.output" MOCK_RETIRED_MODEL_CONFIGURATION_FLOOR_VALID=0
grep -Fq '1616161616161616161616161616161616161616' "${tmp_dir}/failure.err" || fail "retired model configuration rejection must identify the canonical main commit"
[ ! -s "${tmp_dir}/retired-model-configuration-floor.output" ] || fail "pre-drop API must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "retired model configuration floor must fail before artifact or host access"
fi

for drop_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged chat thread provider pin column drop" \
    run_resolver "${tmp_dir}/chat-thread-provider-pin-history.output" "MOCK_CHAT_THREAD_PROVIDER_PIN_COMMIT=${drop_commit}"
  [ ! -s "${tmp_dir}/chat-thread-provider-pin-history.output" ] || fail "invalid chat thread provider pin history must not publish outputs"
  if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
    fail "invalid chat thread provider pin history must fail before artifact or host access"
  fi
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the chat thread provider pin column drop" \
  run_resolver "${tmp_dir}/chat-thread-provider-pin-floor.output" MOCK_CHAT_THREAD_PROVIDER_PIN_FLOOR_VALID=0
grep -Fq '1717171717171717171717171717171717171717' "${tmp_dir}/failure.err" || fail "chat thread provider pin rejection must identify the canonical main commit"
[ ! -s "${tmp_dir}/chat-thread-provider-pin-floor.output" ] || fail "pre-drop API must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "chat thread provider pin floor must fail before artifact or host access"
fi

for drop_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged dead model provider column drop" \
    run_resolver "${tmp_dir}/dead-model-provider-columns-history.output" "MOCK_DEAD_MODEL_PROVIDER_COLUMNS_COMMIT=${drop_commit}"
  [ ! -s "${tmp_dir}/dead-model-provider-columns-history.output" ] || fail "invalid dead model provider column history must not publish outputs"
  if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
    fail "invalid dead model provider column history must fail before artifact or host access"
  fi
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the dead model provider column drop" \
  run_resolver "${tmp_dir}/dead-model-provider-columns-floor.output" MOCK_DEAD_MODEL_PROVIDER_COLUMNS_FLOOR_VALID=0
grep -Fq '1818181818181818181818181818181818181818' "${tmp_dir}/failure.err" || fail "dead model provider column rejection must identify the canonical main commit"
[ ! -s "${tmp_dir}/dead-model-provider-columns-floor.output" ] || fail "pre-drop API must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "dead model provider column floor must fail before artifact or host access"
fi

for drop_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged connector catalog Release 2 contraction" \
    run_resolver "${tmp_dir}/connector-catalog-release-2-history.output" "MOCK_CONNECTOR_CATALOG_RELEASE_2_COMMIT=${drop_commit}"
  [ ! -s "${tmp_dir}/connector-catalog-release-2-history.output" ] || fail "invalid connector catalog Release 2 history must not publish outputs"
  if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
    fail "invalid connector catalog Release 2 history must fail before artifact or host access"
  fi
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the connector catalog Release 2 contraction" \
  run_resolver "${tmp_dir}/connector-catalog-release-2-floor.output" MOCK_CONNECTOR_CATALOG_RELEASE_2_FLOOR_VALID=0
grep -Fq '1919191919191919191919191919191919191919' "${tmp_dir}/failure.err" || fail "connector catalog Release 2 rejection must identify the canonical main commit"
[ ! -s "${tmp_dir}/connector-catalog-release-2-floor.output" ] || fail "pre-Release 2 API must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "connector catalog Release 2 floor must fail before artifact or host access"
fi

for drop_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged model route state retirement" \
    run_resolver "${tmp_dir}/model-route-state-history.output" "MOCK_MODEL_ROUTE_STATE_COMMIT=${drop_commit}"
  [ ! -s "${tmp_dir}/model-route-state-history.output" ] || fail "invalid model route state history must not publish outputs"
  if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
    fail "invalid model route state history must fail before artifact or host access"
  fi
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the model route state retirement" \
  run_resolver "${tmp_dir}/model-route-state-floor.output" MOCK_MODEL_ROUTE_STATE_FLOOR_VALID=0
grep -Fq '3737373737373737373737373737373737373737' "${tmp_dir}/failure.err" || fail "model route state rejection must identify the canonical main commit"
[ ! -s "${tmp_dir}/model-route-state-floor.output" ] || fail "pre-retirement API must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "model route state floor must fail before artifact or host access"
fi

for drop_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged Pi stable-context retirement" \
    run_resolver "${tmp_dir}/pi-stable-context-history.output" "MOCK_PI_STABLE_CONTEXT_COMMIT=${drop_commit}"
  [ ! -s "${tmp_dir}/pi-stable-context-history.output" ] || fail "invalid Pi stable-context retirement history must not publish outputs"
  if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
    fail "invalid Pi stable-context retirement history must fail before artifact or host access"
  fi
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the Pi stable-context retirement" \
  run_resolver "${tmp_dir}/pi-stable-context-floor.output" MOCK_PI_STABLE_CONTEXT_FLOOR_VALID=0
grep -Fq '3838383838383838383838383838383838383838' "${tmp_dir}/failure.err" || fail "Pi stable-context retirement rejection must identify the canonical main commit"
[ ! -s "${tmp_dir}/pi-stable-context-floor.output" ] || fail "pre-retirement API must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "Pi stable-context retirement floor must fail before artifact or host access"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the chat thread provenance runtime removal" \
  run_resolver "${tmp_dir}/chat-thread-provenance-floor.output" MOCK_CHAT_THREAD_PROVENANCE_FLOOR_VALID=0
[ ! -s "${tmp_dir}/chat-thread-provenance-floor.output" ] || fail "provenance-dependent API must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "chat thread provenance floor must fail before artifact or host access"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the database-only Agent instructions reader" \
  run_resolver "${tmp_dir}/agent-instructions-api-floor.output" MOCK_AGENT_INSTRUCTIONS_API_FLOOR_VALID=0
grep -Fq 'b4a90a6b3f79527f91836df6a2bcc8fe81c622e8' "${tmp_dir}/failure.err" || fail "Agent instruction rejection must identify the database-only reader commit"
[ ! -s "${tmp_dir}/agent-instructions-api-floor.output" ] || fail "Storage instruction reader must not publish rollback outputs"
if grep -Eq '^(curl|ssh|git rev-list) ' "${tmp_dir}/boundaries.log"; then
  fail "Agent instruction API floor must fail before artifact or host access"
fi
assert_failure "predates inline Agent instructions" \
  run_resolver "${tmp_dir}/agent-instructions-runner-floor.output" MOCK_AGENT_INSTRUCTIONS_RUNNER_FLOOR_VALID=0
[ ! -s "${tmp_dir}/agent-instructions-runner-floor.output" ] || fail "old instruction Runner must not publish rollback outputs"

: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates immutable content bundle publication" \
  run_resolver "${tmp_dir}/content-bundle-api-floor.output" MOCK_CONTENT_BUNDLE_API_VALID=0
grep -Fq 'fc8f99468cc7946843620ff655ae22c09f9cb2ae' "${tmp_dir}/failure.err" || fail "content bundle API rejection must identify the preparation commit"
[ ! -s "${tmp_dir}/content-bundle-api-floor.output" ] || fail "legacy-only publisher must not publish rollback outputs"
if grep -Eq '^(curl|ssh|git rev-list) ' "${tmp_dir}/boundaries.log"; then
  fail "content bundle API floor must fail before artifact or host access"
fi
: >"${tmp_dir}/boundaries.log"
assert_failure "predates hash-addressed content bundles" \
  run_resolver "${tmp_dir}/content-bundle-runner-floor.output" MOCK_CONTENT_BUNDLE_RUNNER_VALID=0
grep -Fq 'fc8f99468cc7946843620ff655ae22c09f9cb2ae' "${tmp_dir}/failure.err" || fail "content bundle Runner rejection must identify the preparation commit"
[ ! -s "${tmp_dir}/content-bundle-runner-floor.output" ] || fail "legacy-only Runner must not publish rollback outputs"
if grep -Eq '^ssh ' "${tmp_dir}/boundaries.log"; then
  fail "content bundle Runner floor must fail before host access"
fi

for preparation_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged content bundle archive reader" \
    run_resolver "${tmp_dir}/bundle-archive-history.output" "MOCK_CONTENT_BUNDLE_ARCHIVE_READER_COMMIT=${preparation_commit}"
  [ ! -s "${tmp_dir}/bundle-archive-history.output" ] || fail "invalid archive reader history must not publish outputs"
  if grep -Eq '^(curl|ssh) ' "${tmp_dir}/boundaries.log"; then
    fail "invalid archive reader history must fail before provider access"
  fi
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Content bundle archive reader rollback floor is not on main" \
  run_resolver "${tmp_dir}/bundle-archive-main.output" MOCK_CONTENT_BUNDLE_ARCHIVE_READER_ON_MAIN=0
[ ! -s "${tmp_dir}/bundle-archive-main.output" ] || fail "unmerged archive reader must not publish outputs"
if grep -Eq '^(curl|ssh) ' "${tmp_dir}/boundaries.log"; then
  fail "unmerged archive reader must fail before provider access"
fi
: >"${tmp_dir}/boundaries.log"
assert_failure "predates bounded content bundle archive delivery" \
  run_resolver "${tmp_dir}/bundle-archive-runner.output" MOCK_CONTENT_BUNDLE_ARCHIVE_RUNNER_VALID=0
[ ! -s "${tmp_dir}/bundle-archive-runner.output" ] || fail "per-file archive Runner must not publish outputs"
if grep -Eq '^ssh |api.github.com/repos/' "${tmp_dir}/boundaries.log"; then
  fail "per-file archive Runner must fail before Runner artifact or host access"
fi
run_resolver "${tmp_dir}/bundle-archive-older-api.output" MOCK_CONTENT_BUNDLE_ARCHIVE_API_VALID=0 >/dev/null
grep -Fq "target_commit=${target_commit}" "${tmp_dir}/bundle-archive-older-api.output" || fail "older compatible API with corrected Runner must remain eligible"

for preparation_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged Workflow namespace preparation" \
    run_resolver "${tmp_dir}/workflow-name-scopes-history.output" "MOCK_WORKFLOW_NAME_SCOPES_COMMIT=${preparation_commit}"
  [ ! -s "${tmp_dir}/workflow-name-scopes-history.output" ] || fail "invalid Workflow namespace history must not publish outputs"
  if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
    fail "invalid Workflow namespace history must fail before artifact or host access"
  fi
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the Workflow namespace preparation" \
  run_resolver "${tmp_dir}/workflow-name-scopes-floor.output" MOCK_WORKFLOW_NAME_SCOPES_FLOOR_VALID=0
grep -Fq '52525252525252525252525252525252525252ab' "${tmp_dir}/failure.err" || fail "Workflow namespace rejection must identify the canonical preparation commit"
[ ! -s "${tmp_dir}/workflow-name-scopes-floor.output" ] || fail "name-only API must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "Workflow namespace floor must fail before artifact or host access"
fi

for preparation_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged Computer Use session-only host mapping" \
    run_resolver "${tmp_dir}/computer-use-host-history.output" "MOCK_COMPUTER_USE_HOST_SESSION_ONLY_COMMIT=${preparation_commit}"
  [ ! -s "${tmp_dir}/computer-use-host-history.output" ] || fail "invalid host preparation history must not publish outputs"
  if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
    fail "invalid host preparation history must fail before artifact or host access"
  fi
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the Computer Use session-only host mapping" \
  run_resolver "${tmp_dir}/computer-use-host-floor.output" MOCK_COMPUTER_USE_HOST_SESSION_ONLY_FLOOR_VALID=0
grep -Fq '4545454545454545454545454545454545454545' "${tmp_dir}/failure.err" || fail "host preparation rejection must identify the canonical main commit"
[ ! -s "${tmp_dir}/computer-use-host-floor.output" ] || fail "token-hash-dependent API must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "host preparation floor must fail before artifact or host access"
fi

for preparation_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged Native Morning Brief member runtime preparation" \
    run_resolver "${tmp_dir}/native-brief-member-history.output" "MOCK_NATIVE_BRIEF_MEMBER_RUNTIME_COMMIT=${preparation_commit}"
  [ ! -s "${tmp_dir}/native-brief-member-history.output" ] || fail "invalid Native member preparation history must not publish outputs"
  if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
    fail "invalid Native member preparation history must fail before artifact or host access"
  fi
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the Native Morning Brief member runtime preparation" \
  run_resolver "${tmp_dir}/native-brief-member-floor.output" MOCK_NATIVE_BRIEF_MEMBER_RUNTIME_FLOOR_VALID=0
grep -Fq '4747474747474747474747474747474747474747' "${tmp_dir}/failure.err" || fail "Native member preparation rejection must identify the canonical main commit"
[ ! -s "${tmp_dir}/native-brief-member-floor.output" ] || fail "fence-dependent API must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "Native member runtime floor must fail before artifact or host access"
fi

for preparation_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged connector catalog payload-independent API" \
    run_resolver "${tmp_dir}/connector-catalog-payload-independent-history.output" "MOCK_CONNECTOR_CATALOG_PAYLOAD_INDEPENDENT_COMMIT=${preparation_commit}"
  [ ! -s "${tmp_dir}/connector-catalog-payload-independent-history.output" ] || fail "invalid catalog preparation history must not publish outputs"
  if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
    fail "invalid catalog preparation history must fail before artifact or host access"
  fi
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the connector catalog payload-independent API" \
  run_resolver "${tmp_dir}/connector-catalog-payload-independent-floor.output" MOCK_CONNECTOR_CATALOG_PAYLOAD_INDEPENDENT_FLOOR_VALID=0
grep -Fq '4040404040404040404040404040404040404040' "${tmp_dir}/failure.err" || fail "catalog preparation rejection must identify the canonical main commit"
[ ! -s "${tmp_dir}/connector-catalog-payload-independent-floor.output" ] || fail "payload-dependent API must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "catalog preparation floor must fail before artifact or host access"
fi

for drop_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged Pi debug trace retirement" \
    run_resolver "${tmp_dir}/pi-debug-trace-history.output" "MOCK_PI_DEBUG_TRACE_COMMIT=${drop_commit}"
  [ ! -s "${tmp_dir}/pi-debug-trace-history.output" ] || fail "invalid Pi debug trace retirement history must not publish outputs"
  if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
    fail "invalid Pi debug trace retirement history must fail before artifact or host access"
  fi
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the Pi debug trace retirement" \
  run_resolver "${tmp_dir}/pi-debug-trace-floor.output" MOCK_PI_DEBUG_TRACE_FLOOR_VALID=0
grep -Fq '3939393939393939393939393939393939393939' "${tmp_dir}/failure.err" || fail "Pi debug trace rejection must identify the canonical main commit"
[ ! -s "${tmp_dir}/pi-debug-trace-floor.output" ] || fail "pre-retirement API must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "Pi debug trace floor must fail before artifact or host access"
fi

for drop_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged Usage Allowance retirement" \
    run_resolver "${tmp_dir}/usage-allowance-history.output" "MOCK_USAGE_ALLOWANCE_COMMIT=${drop_commit}"
  [ ! -s "${tmp_dir}/usage-allowance-history.output" ] || fail "invalid Usage Allowance retirement history must not publish outputs"
  if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
    fail "invalid Usage Allowance retirement history must fail before artifact or host access"
  fi
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the Usage Allowance retirement" \
  run_resolver "${tmp_dir}/usage-allowance-floor.output" MOCK_USAGE_ALLOWANCE_FLOOR_VALID=0
grep -Fq '4141414141414141414141414141414141414141' "${tmp_dir}/failure.err" || fail "Usage Allowance rejection must identify the canonical main commit"
[ ! -s "${tmp_dir}/usage-allowance-floor.output" ] || fail "pre-Allowance-retirement API must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "Usage Allowance floor must fail before artifact or host access"
fi

for canonical_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged canonical SSH transport" \
    run_resolver "${tmp_dir}/ssh-canonical-history.output" "MOCK_SSH_CANONICAL_TRANSPORT_COMMIT=${canonical_commit}"
  [ ! -s "${tmp_dir}/ssh-canonical-history.output" ] || fail "invalid SSH canonical history must not publish outputs"
  if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
    fail "invalid SSH canonical history must fail before artifact or host access"
  fi
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates canonical SSH transport" \
  run_resolver "${tmp_dir}/ssh-canonical-floor.output" MOCK_SSH_CANONICAL_TRANSPORT_FLOOR_VALID=0
grep -Fq '4848484848484848484848484848484848484848' "${tmp_dir}/failure.err" || fail "SSH transport rejection must identify the canonical main commit"
[ ! -s "${tmp_dir}/ssh-canonical-floor.output" ] || fail "pre-canonical SSH API must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "SSH transport floor must fail before artifact or host access"
fi

for retirement_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged Official result-email runtime retirement" \
    run_resolver "${tmp_dir}/official-result-email-history.output" "MOCK_OFFICIAL_RESULT_EMAIL_RUNTIME_COMMIT=${retirement_commit}"
  [ ! -s "${tmp_dir}/official-result-email-history.output" ] || fail "invalid Official result-email history must not publish outputs"
  if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
    fail "invalid Official result-email history must fail before artifact or host access"
  fi
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the Official result-email runtime retirement" \
  run_resolver "${tmp_dir}/official-result-email-floor.output" MOCK_OFFICIAL_RESULT_EMAIL_RUNTIME_FLOOR_VALID=0
grep -Fq '4949494949494949494949494949494949494949' "${tmp_dir}/failure.err" || fail "Official result-email rejection must identify the canonical main commit"
[ ! -s "${tmp_dir}/official-result-email-floor.output" ] || fail "pre-retirement Official result-email API must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "Official result-email floor must fail before artifact or host access"
fi

for contraction_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged Official result-email storage contraction" \
    run_resolver "${tmp_dir}/official-result-email-contraction-history.output" "MOCK_OFFICIAL_RESULT_EMAIL_STORAGE_CONTRACTION_COMMIT=${contraction_commit}"
  [ ! -s "${tmp_dir}/official-result-email-contraction-history.output" ] || fail "invalid Official result-email contraction history must not publish outputs"
  if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
    fail "invalid Official result-email contraction history must fail before artifact or host access"
  fi
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the Official result-email storage contraction" \
  run_resolver "${tmp_dir}/official-result-email-contraction-floor.output" MOCK_OFFICIAL_RESULT_EMAIL_STORAGE_CONTRACTION_FLOOR_VALID=0
grep -Fq '5050505050505050505050505050505050505050' "${tmp_dir}/failure.err" || fail "Official result-email contraction rejection must identify the canonical main commit"
[ ! -s "${tmp_dir}/official-result-email-contraction-floor.output" ] || fail "API that names the dropped Official result-email storage must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "Official result-email contraction floor must fail before artifact or host access"
fi

for preparation_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged needs_rebind-independent SSH preparation" \
    run_resolver "${tmp_dir}/ssh-preparation-history.output" "MOCK_SSH_NEEDS_REBIND_INDEPENDENT_COMMIT=${preparation_commit}"
  [ ! -s "${tmp_dir}/ssh-preparation-history.output" ] || fail "invalid SSH preparation history must not publish outputs"
  if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
    fail "invalid SSH preparation history must fail before artifact or host access"
  fi
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the needs_rebind-independent SSH preparation" \
  run_resolver "${tmp_dir}/ssh-preparation-floor.output" MOCK_SSH_NEEDS_REBIND_INDEPENDENT_FLOOR_VALID=0
grep -Fq '5151515151515151515151515151515151515151' "${tmp_dir}/failure.err" || fail "SSH preparation rejection must identify the canonical main commit"
[ ! -s "${tmp_dir}/ssh-preparation-floor.output" ] || fail "legacy-dependent SSH API must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "SSH preparation floor must fail before artifact or host access"
fi

# The producer artifact itself is eligible, as well as the descendant covered
# by the ordinary successful resolver case above.
: >"${tmp_dir}/boundaries.log"
run_resolver "${tmp_dir}/vnc-canonical-exact.output" "MOCK_VNC_CANONICAL_METADATA_COMMIT=${target_commit}" >"${tmp_dir}/vnc-canonical-exact.log"
[ -s "${tmp_dir}/vnc-canonical-exact.output" ] || fail "exact VNC producer artifact must remain eligible"
grep -Fxq "git merge-base --is-ancestor ${target_commit} ${target_commit}" "${tmp_dir}/boundaries.log" || fail "exact VNC producer must be checked against the requested artifact"

for producer_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged VNC canonical metadata producer" \
    run_resolver "${tmp_dir}/vnc-canonical-history.output" "MOCK_VNC_CANONICAL_METADATA_COMMIT=${producer_commit}"
  [ ! -s "${tmp_dir}/vnc-canonical-history.output" ] || fail "invalid VNC producer history must not publish outputs"
  if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
    fail "VNC history must be validated before artifact or host access"
  fi
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the VNC canonical metadata producer" \
  run_resolver "${tmp_dir}/vnc-canonical-floor.output" MOCK_VNC_CANONICAL_METADATA_FLOOR_VALID=0
[ ! -s "${tmp_dir}/vnc-canonical-floor.output" ] || fail "B-F API must not publish rollback outputs"
grep -Fq '5757575757575757575757575757575757575757' "${tmp_dir}/failure.err" || fail "VNC floor must identify its merged producer"
grep -Fxq "git log --reverse --first-parent --diff-filter=A --format=%H origin/main -- .github/rollback-floors/vnc-native-networks-canonical-metadata" "${tmp_dir}/boundaries.log" || fail "VNC floor must resolve main history, not target history"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "VNC floor must fail before artifact or host access"
fi

# WeChat retirement rejects incompatible artifacts before provider or host access.
for producer_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged WeChat Workflows-only receiver" \
    run_resolver "${tmp_dir}/wechat-history.output" "MOCK_WECHAT_WORKFLOWS_ONLY_COMMIT=${producer_commit}"
  [ ! -s "${tmp_dir}/wechat-history.output" ] || fail "invalid WeChat history must not publish outputs"
  if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
    fail "WeChat history must be validated before artifact or host access"
  fi
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the WeChat Workflows-only receiver" \
  run_resolver "${tmp_dir}/wechat-floor.output" MOCK_WECHAT_WORKFLOWS_ONLY_FLOOR_VALID=0
[ ! -s "${tmp_dir}/wechat-floor.output" ] || fail "legacy WeChat API must not publish rollback outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "WeChat floor must fail before artifact or host access"
fi
run_resolver "${tmp_dir}/wechat-exact.output" "MOCK_WECHAT_WORKFLOWS_ONLY_COMMIT=${target_commit}" >"${tmp_dir}/wechat-exact.log"
[ -s "${tmp_dir}/wechat-exact.output" ] || fail "exact WeChat cutover artifact must remain eligible"

# A native producer excludes Session-dependent rollback artifacts before any
# deployment/artifact side effects are attempted.
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates native-only Session/Conversation retirement" \
  run_resolver "${tmp_dir}/session-conversation-floor.output" MOCK_SESSION_CONVERSATION_RUNTIME_FLOOR_VALID=0
[ ! -s "${tmp_dir}/session-conversation-floor.output" ] || fail "Session-dependent API must not publish rollback outputs"
grep -Fxq "git log --reverse --first-parent --diff-filter=A --format=%H origin/main -- .github/rollback-floors/session-conversation-runtime" "${tmp_dir}/boundaries.log" || fail "Native cutover floor must use main's marker history"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "Native cutover floor must fail before artifact or host access"
fi

for session_mount_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged Session storage-mount runtime preparation" \
    run_resolver "${tmp_dir}/session-storage-mount-history.output" "MOCK_SESSION_STORAGE_MOUNT_RUNTIME_COMMIT=${session_mount_commit}"
  [ ! -s "${tmp_dir}/session-storage-mount-history.output" ] || fail "invalid Session mount history must not publish outputs"
  if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
    fail "invalid Session mount history must fail before artifact or host access"
  fi
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the Session storage-mount runtime preparation" \
  run_resolver "${tmp_dir}/session-storage-mount-floor.output" MOCK_SESSION_STORAGE_MOUNT_RUNTIME_FLOOR_VALID=0
grep -Fq '5252525252525252525252525252525252525252' "${tmp_dir}/failure.err" || fail "Session mount rejection must identify the shipped preparation commit"
[ ! -s "${tmp_dir}/session-storage-mount-floor.output" ] || fail "Session mount reader must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "Session mount floor must fail before artifact or host access"
fi

for v8_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged Chat Event V8 migration" \
    run_resolver "${tmp_dir}/chat-event-v8-history.output" "MOCK_CHAT_EVENT_V8_COMMIT=${v8_commit}"
  [ ! -s "${tmp_dir}/chat-event-v8-history.output" ] || fail "invalid Chat Event V8 history must not publish outputs"
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the Chat Event V8 migration" \
  run_resolver "${tmp_dir}/chat-event-v8-floor.output" MOCK_CHAT_EVENT_V8_FLOOR_VALID=0
[ ! -s "${tmp_dir}/chat-event-v8-floor.output" ] || fail "pre-V8 API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "Chat Event V8 floor must fail before artifact or host access"
fi

for mutation_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged Browser session mutation contract" \
    run_resolver "${tmp_dir}/browser-session-mutations-history.output" "MOCK_BROWSER_SESSION_MUTATIONS_COMMIT=${mutation_commit}"
  [ ! -s "${tmp_dir}/browser-session-mutations-history.output" ] || fail "invalid Browser mutation history must not publish outputs"
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the Browser session mutation contract" \
  run_resolver "${tmp_dir}/browser-session-mutations-floor.output" MOCK_BROWSER_SESSION_MUTATIONS_FLOOR_VALID=0
[ ! -s "${tmp_dir}/browser-session-mutations-floor.output" ] || fail "incompatible Browser mutation API must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "Browser mutation floor must fail before artifact or host access"
fi

for routing_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged hosted-site URL routing contract" \
    run_resolver "${tmp_dir}/hosted-site-url-history.output" "MOCK_HOSTED_SITE_URL_ROUTING_COMMIT=${routing_commit}"
  [ ! -s "${tmp_dir}/hosted-site-url-history.output" ] || fail "invalid hosted-site URL history must not publish outputs"
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the hosted-site URL routing contract" \
  run_resolver "${tmp_dir}/hosted-site-url-floor.output" MOCK_HOSTED_SITE_URL_ROUTING_FLOOR_VALID=0
[ ! -s "${tmp_dir}/hosted-site-url-floor.output" ] || fail "incompatible hosted-site API must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "hosted-site URL routing floor must fail before artifact or host access"
fi

for migration_hop_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged Desktop migration-hop policy" \
    run_resolver "${tmp_dir}/desktop-migration-hop-history.output" "MOCK_DESKTOP_MIGRATION_HOP_COMMIT=${migration_hop_commit}"
  [ ! -s "${tmp_dir}/desktop-migration-hop-history.output" ] || fail "invalid migration-hop history must not publish outputs"
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the frozen Desktop migration-hop policy" \
  run_resolver "${tmp_dir}/desktop-migration-hop-floor.output" MOCK_DESKTOP_MIGRATION_HOP_FLOOR_VALID=0
[ ! -s "${tmp_dir}/desktop-migration-hop-floor.output" ] || fail "dynamic Squirrel API must not publish rollback outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "Desktop migration-hop floor must fail before artifact or host access"
fi

for notification_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged Computer Use command notification contract" \
    run_resolver "${tmp_dir}/computer-use-notifications-history.output" "MOCK_COMPUTER_USE_COMMAND_NOTIFICATIONS_COMMIT=${notification_commit}"
  [ ! -s "${tmp_dir}/computer-use-notifications-history.output" ] || fail "invalid Computer Use notification history must not publish outputs"
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the Computer Use command notification contract" \
  run_resolver "${tmp_dir}/computer-use-notifications-floor.output" MOCK_COMPUTER_USE_COMMAND_NOTIFICATIONS_FLOOR_VALID=0
[ ! -s "${tmp_dir}/computer-use-notifications-floor.output" ] || fail "incompatible Computer Use API must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "Computer Use notification floor must fail before artifact or host access"
fi

for drop_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged retired integration agent table drop" \
    run_resolver "${tmp_dir}/retired-integration-agent-tables-history.output" "MOCK_RETIRED_INTEGRATION_AGENT_TABLES_COMMIT=${drop_commit}"
  [ ! -s "${tmp_dir}/retired-integration-agent-tables-history.output" ] || fail "invalid retired integration agent table drop history must not publish outputs"
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the retired integration agent table drop" \
  run_resolver "${tmp_dir}/retired-integration-agent-tables-floor.output" MOCK_RETIRED_INTEGRATION_AGENT_TABLES_FLOOR_VALID=0
[ ! -s "${tmp_dir}/retired-integration-agent-tables-floor.output" ] || fail "pre-drop API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "retired integration agent table drop floor must fail before artifact or host access"
fi

for retirement_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged public_brand retirement" \
    run_resolver "${tmp_dir}/public-brand-history.output" "MOCK_PUBLIC_BRAND_RETIREMENT_COMMIT=${retirement_commit}"
  [ ! -s "${tmp_dir}/public-brand-history.output" ] || fail "invalid public_brand history must not publish outputs"
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the public_brand retirement" \
  run_resolver "${tmp_dir}/public-brand-floor.output" MOCK_PUBLIC_BRAND_RETIREMENT_FLOOR_VALID=0
[ ! -s "${tmp_dir}/public-brand-floor.output" ] || fail "pre-retirement API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "public_brand retirement floor must fail before artifact or host access"
fi

for drop_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged agent_runs heartbeat column drop" \
    run_resolver "${tmp_dir}/agent-run-heartbeat-history.output" "MOCK_AGENT_RUN_HEARTBEAT_DROP_COMMIT=${drop_commit}"
  [ ! -s "${tmp_dir}/agent-run-heartbeat-history.output" ] || fail "invalid agent_runs heartbeat drop history must not publish outputs"
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the agent_runs heartbeat column drop" \
  run_resolver "${tmp_dir}/agent-run-heartbeat-floor.output" MOCK_AGENT_RUN_HEARTBEAT_DROP_FLOOR_VALID=0
[ ! -s "${tmp_dir}/agent-run-heartbeat-floor.output" ] || fail "pre-drop API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "agent_runs heartbeat column drop floor must fail before artifact or host access"
fi

for account_only_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged personal subscription account-only migration" \
    run_resolver "${tmp_dir}/personal-subscription-history.output" "MOCK_PERSONAL_SUBSCRIPTION_COMMIT=${account_only_commit}"
  [ ! -s "${tmp_dir}/personal-subscription-history.output" ] || fail "invalid personal subscription history must not publish outputs"
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the personal subscription account-only store" \
  run_resolver "${tmp_dir}/personal-subscription-floor.output" MOCK_PERSONAL_SUBSCRIPTION_FLOOR_VALID=0
[ ! -s "${tmp_dir}/personal-subscription-floor.output" ] || fail "pre-account-only API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "personal subscription account-only floor must fail before artifact or host access"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the R2-only chat thread snapshot API" \
  run_resolver "${tmp_dir}/snapshot-r2-only-floor.output" MOCK_CHAT_THREAD_SNAPSHOT_R2_ONLY_FLOOR_VALID=0
grep -Fq '3d93ff8d4b4a07a5888e3030e69b340f40da0ad4' "${tmp_dir}/failure.err" || fail "R2-only rejection must identify the #36945 merge commit"
[ ! -s "${tmp_dir}/snapshot-r2-only-floor.output" ] || fail "pre-R2-only API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "R2-only floor must fail before artifact or host access"
fi

for drop_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged chat thread snapshot JSONB drop" \
    run_resolver "${tmp_dir}/snapshot-jsonb-history.output" "MOCK_SNAPSHOT_JSONB_DROP_COMMIT=${drop_commit}"
  [ ! -s "${tmp_dir}/snapshot-jsonb-history.output" ] || fail "invalid snapshot JSONB drop history must not publish outputs"
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the chat thread snapshot JSONB drop" \
  run_resolver "${tmp_dir}/snapshot-jsonb-floor.output" MOCK_SNAPSHOT_JSONB_DROP_FLOOR_VALID=0
[ ! -s "${tmp_dir}/snapshot-jsonb-floor.output" ] || fail "pre-drop API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "snapshot JSONB drop floor must fail before artifact or host access"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the chat thread draft owner key writer" \
  run_resolver "${tmp_dir}/chat-thread-draft-owner-key-floor.output" MOCK_CHAT_THREAD_DRAFT_OWNER_KEY_FLOOR_VALID=0
grep -Fq '7a187fa0a3fe2f23a134c7cdff66ee9c7e2bdb38' "${tmp_dir}/failure.err" || fail "draft owner key rejection must identify the owner key commit"
[ ! -s "${tmp_dir}/chat-thread-draft-owner-key-floor.output" ] || fail "pre-owner-key API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "pre-owner-key API target must fail before artifact or host access"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "predates structured provider balance failures" \
  run_resolver "${tmp_dir}/balance-runner.output" MOCK_BALANCE_RUNNER_FLOOR_VALID=0
[ ! -s "${tmp_dir}/balance-runner.output" ] || fail "incompatible retained Runner must not publish outputs"
if grep -Eq '^ssh |api.github.com/repos/.*/releases/tags/' "${tmp_dir}/boundaries.log"; then
  fail "incompatible retained Runner must fail before Runner artifact or host access"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "predates the pair-free disk telemetry writer" \
  run_resolver "${tmp_dir}/pair-free-disk-writer.output" MOCK_PAIR_FREE_DISK_WRITER_FLOOR_VALID=0
grep -Fq '625c4607ccdcd2d46a5c7227f61419928035e13f' "${tmp_dir}/failure.err" || fail "disk writer rejection must identify the producer commit"
[ ! -s "${tmp_dir}/pair-free-disk-writer.output" ] || fail "dual-writing Runner must not publish rollback outputs"
if grep -Eq '^ssh |api.github.com/repos/.*/releases/tags/' "${tmp_dir}/boundaries.log"; then
  fail "dual-writing Runner must fail before Runner artifact or host access"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "found 0" run_resolver "${tmp_dir}/zero.output" MOCK_VERCEL_MATCH_COUNT=0
[ ! -s "${tmp_dir}/zero.output" ] || fail "failed resolution must not publish outputs"

: >"${tmp_dir}/boundaries.log"
assert_failure "predates the Link wallet grant metadata writer" \
  run_resolver "${tmp_dir}/link-grant-writer.output" MOCK_LINK_GRANT_WRITER_FLOOR_VALID=0

assert_failure "predates bundled-only CLI startup" \
  run_resolver "${tmp_dir}/bundled-cli-runner.output" MOCK_BUNDLED_CLI_RUNNER_FLOOR_VALID=0
[ ! -s "${tmp_dir}/bundled-cli-runner.output" ] || fail "incompatible CLI Runner must not publish outputs"
if grep -Eq '^ssh |api.github.com/repos/.*/releases/tags/' "${tmp_dir}/boundaries.log"; then
  fail "incompatible CLI Runner must fail before Runner artifact or host access"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "found 2" run_resolver "${tmp_dir}/multiple.output" MOCK_VERCEL_MATCH_COUNT=2
[ ! -s "${tmp_dir}/multiple.output" ] || fail "ambiguous API resolution must not publish outputs"

: >"${tmp_dir}/boundaries.log"
assert_failure "is missing runner-v1.2.3-x86_64-linux" run_resolver "${tmp_dir}/missing-runner.output" MOCK_RUNNER_ASSETS_VALID=0
[ ! -s "${tmp_dir}/missing-runner.output" ] || fail "missing Runner asset must not publish outputs"

invalid_commit=not-a-full-sha
target_commit_before=$target_commit
target_commit=$invalid_commit
: >"${tmp_dir}/boundaries.log"
assert_failure "must be a full lowercase SHA-1" run_resolver "${tmp_dir}/invalid.output"
target_commit=$target_commit_before
[ ! -s "${tmp_dir}/boundaries.log" ] || fail "invalid target must fail before external boundaries"

: >"${tmp_dir}/boundaries.log"
assert_failure "Runner release runner-rs-v1.2.3 predates the blank sandbox status reader" \
  run_resolver "${tmp_dir}/blank-runner-floor.output" MOCK_BLANK_RUNNER_FLOOR_VALID=0
[ ! -s "${tmp_dir}/blank-runner-floor.output" ] || fail "old Runner artifact must not publish outputs"
if grep -q 'api.github.com/repos/.*/releases/tags/' "${tmp_dir}/boundaries.log"; then
  fail "blank reader artifact rejection must precede asset resolution"
fi

release_target_script="${tmp_dir}/resolve-release-target.sh"
ruby -e '
  require "json"
  require "yaml"
  workflow = YAML.safe_load(File.read(ARGV[0]), aliases: true)
  release_job = workflow.fetch("jobs").fetch("release-please")
  release_target_step = release_job.fetch("steps").find { |step| step["id"] == "release-target" }
  raise "missing release target resolver step" unless release_target_step

  resolver_env = release_target_step.fetch("env")
  unless resolver_env.keys == ["RELEASE_SHAS"]
    raise "release target resolver environment must contain only RELEASE_SHAS"
  end

  projection = resolver_env.fetch("RELEASE_SHAS")
  projected_paths = projection.scan(/steps\.release\.outputs\[\x27([^\x27]+)--sha\x27\]/).flatten
  output_reference_count = projection.scan(/steps\.release\.outputs/).length
  unless output_reference_count == projected_paths.length
    raise "release bodies, changelogs, and complete outputs must not enter the release target resolver environment"
  end

  # Version-managed private packages do not emit a release SHA or tag.
  configured_paths = JSON.parse(File.read(ARGV[1])).fetch("packages")
    .reject { |_, config| config["skip-github-release"] == true }.keys
  missing_paths = configured_paths - projected_paths
  unknown_paths = projected_paths - configured_paths
  duplicate_paths = projected_paths.group_by(&:itself).select { |_, paths| paths.length > 1 }.keys
  unless missing_paths.empty? && unknown_paths.empty? && duplicate_paths.empty?
    raise "release SHA projection mismatch: missing=#{missing_paths.sort}, unknown=#{unknown_paths.sort}, duplicates=#{duplicate_paths.sort}"
  end

  puts release_target_step.fetch("run")
' \
  "${repo_root}/.github/workflows/release-please.yml" \
  "${repo_root}/release-please-config.json" \
  >"$release_target_script"

release_target=cccccccccccccccccccccccccccccccccccccccc
release_target_output="${tmp_dir}/release-target.output"
RELEASE_SHAS="$(jq -nc --arg target "$release_target" '[null, "", $target, null]')" \
  GITHUB_OUTPUT="$release_target_output" \
  bash "$release_target_script"
grep -qx "sha=${release_target}" "$release_target_output" || fail "release target resolver did not publish the unique release SHA"

missing_release_target_output="${tmp_dir}/missing-release-target.output"
assert_failure \
  "release-please returned no release SHA" \
  env \
  RELEASE_SHAS='["", ""]' \
  GITHUB_OUTPUT="$missing_release_target_output" \
  bash "$release_target_script"
[ ! -s "$missing_release_target_output" ] || fail "missing release SHA must not publish an output"

invalid_release_target_output="${tmp_dir}/invalid-release-target.output"
assert_failure \
  "release-please returned invalid release SHA" \
  env \
  RELEASE_SHAS='["cccccccccccccccccccccccccccccccccccccccc", "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"]' \
  GITHUB_OUTPUT="$invalid_release_target_output" \
  bash "$release_target_script"
[ ! -s "$invalid_release_target_output" ] || fail "invalid release SHA must not publish an output"

multiple_release_targets=$(jq -nc '[
  "cccccccccccccccccccccccccccccccccccccccc",
  "dddddddddddddddddddddddddddddddddddddddd"
]')
multiple_release_target_output="${tmp_dir}/multiple-release-target.output"
assert_failure \
  "release-please returned multiple release SHAs" \
  env \
  RELEASE_SHAS="$multiple_release_targets" \
  GITHUB_OUTPUT="$multiple_release_target_output" \
  bash "$release_target_script"
[ ! -s "$multiple_release_target_output" ] || fail "ambiguous release SHAs must not publish an output"

release_tags_script="${tmp_dir}/resolve-release-tags.sh"
ruby -e '
  require "json"
  require "yaml"
  workflow = YAML.safe_load(File.read(ARGV[0]), aliases: true)
  release_job = workflow.fetch("jobs").fetch("release-please")
  release_tags_step = release_job.fetch("steps").find { |step| step["id"] == "release-tags" }
  raise "missing current release tag resolver step" unless release_tags_step

  resolver_env = release_tags_step.fetch("env")
  unless resolver_env.keys == ["RELEASE_TAGS", "DESKTOP_RELEASE_CREATED", "DESKTOP_VERSION"]
    raise "release tag resolver environment has unexpected inputs"
  end

  projection = resolver_env.fetch("RELEASE_TAGS")
  projected_paths = projection.scan(/steps\.release\.outputs\[\x27([^\x27]+)--tag_name\x27\]/).flatten
  output_reference_count = projection.scan(/steps\.release\.outputs/).length
  unless output_reference_count == projected_paths.length
    raise "release bodies, changelogs, and complete outputs must not enter the release tag resolver environment"
  end

  # Version-managed private packages do not emit a release SHA or tag.
  configured_paths = JSON.parse(File.read(ARGV[1])).fetch("packages")
    .reject { |_, config| config["skip-github-release"] == true }.keys
  missing_paths = configured_paths - projected_paths
  unknown_paths = projected_paths - configured_paths
  duplicate_paths = projected_paths.group_by(&:itself).select { |_, paths| paths.length > 1 }.keys
  unless missing_paths.empty? && unknown_paths.empty? && duplicate_paths.empty?
    raise "release tag projection mismatch: missing=#{missing_paths.sort}, unknown=#{unknown_paths.sort}, duplicates=#{duplicate_paths.sort}"
  end

  desktop_release_created = "$" + "{{ steps.release.outputs[\x27desktop--release_created\x27] }}"
  desktop_version = "$" + "{{ steps.release.outputs[\x27desktop--version\x27] }}"
  unless resolver_env.fetch("DESKTOP_RELEASE_CREATED") == desktop_release_created &&
      resolver_env.fetch("DESKTOP_VERSION") == desktop_version
    raise "release tag resolver must derive the Okou Desktop tag from the Desktop release outputs"
  end

  puts release_tags_step.fetch("run")
' \
  "${repo_root}/.github/workflows/release-please.yml" \
  "${repo_root}/release-please-config.json" \
  >"$release_tags_script"

release_tags_output="${tmp_dir}/release-tags.output"
RELEASE_TAGS='[null,"","api-v1.2.3","app-v4.5.6"]' \
  DESKTOP_RELEASE_CREATED='' \
  DESKTOP_VERSION='' \
  GITHUB_OUTPUT="$release_tags_output" \
  bash "$release_tags_script"
grep -Fqx 'tags=["api-v1.2.3","app-v4.5.6"]' "$release_tags_output" || \
  fail "release tag resolver did not publish the current release tags"

desktop_release_tags_output="${tmp_dir}/desktop-release-tags.output"
RELEASE_TAGS='["desktop-v4.5.6"]' \
  DESKTOP_RELEASE_CREATED=true \
  DESKTOP_VERSION=4.5.6 \
  GITHUB_OUTPUT="$desktop_release_tags_output" \
  bash "$release_tags_script"
grep -Fqx 'tags=["desktop-v4.5.6","okou-desktop-v4.5.6"]' "$desktop_release_tags_output" || \
  fail "release tag resolver did not publish the derived Okou Desktop tag"

missing_release_tags_output="${tmp_dir}/missing-release-tags.output"
assert_failure \
  "release-please returned no release tag" \
  env \
  RELEASE_TAGS='[null,""]' \
  DESKTOP_RELEASE_CREATED='' \
  DESKTOP_VERSION='' \
  GITHUB_OUTPUT="$missing_release_tags_output" \
  bash "$release_tags_script"
[ ! -s "$missing_release_tags_output" ] || fail "missing release tags must not publish an output"

non_string_release_tags_output="${tmp_dir}/non-string-release-tags.output"
assert_failure \
  "release-please returned non-string release tag" \
  env \
  RELEASE_TAGS='["api-v1.2.3",123]' \
  DESKTOP_RELEASE_CREATED='' \
  DESKTOP_VERSION='' \
  GITHUB_OUTPUT="$non_string_release_tags_output" \
  bash "$release_tags_script"
[ ! -s "$non_string_release_tags_output" ] || fail "non-string release tags must not publish an output"

invalid_release_tags_output="${tmp_dir}/invalid-release-tags.output"
assert_failure \
  "release-please returned invalid release tag" \
  env \
  RELEASE_TAGS='["not-a-version-tag"]' \
  DESKTOP_RELEASE_CREATED='' \
  DESKTOP_VERSION='' \
  GITHUB_OUTPUT="$invalid_release_tags_output" \
  bash "$release_tags_script"
[ ! -s "$invalid_release_tags_output" ] || fail "invalid release tags must not publish an output"

duplicate_release_tags_output="${tmp_dir}/duplicate-release-tags.output"
assert_failure \
  "release-please returned duplicate release tags: api-v1.2.3" \
  env \
  RELEASE_TAGS='["api-v1.2.3","api-v1.2.3"]' \
  DESKTOP_RELEASE_CREATED='' \
  DESKTOP_VERSION='' \
  GITHUB_OUTPUT="$duplicate_release_tags_output" \
  bash "$release_tags_script"
[ ! -s "$duplicate_release_tags_output" ] || fail "duplicate release tags must not publish an output"

ruby - \
  "${repo_root}/.github/workflows/rollback-production.yml" \
  "${repo_root}/.github/workflows/release-please.yml" \
  "${repo_root}/.github/workflows/turbo.yml" <<'RUBY'
  require "yaml"
  rollback_config = YAML.safe_load(File.read(ARGV[0]), aliases: true)
  release_config = YAML.safe_load(File.read(ARGV[1]), aliases: true)
  turbo_config = YAML.safe_load(File.read(ARGV[2]), aliases: true)
  raise "rollback must not use lossy GitHub concurrency" if rollback_config.key?("concurrency")
  raise "release must not use lossy GitHub concurrency" if release_config.key?("concurrency")
  rollback = rollback_config.fetch("jobs")
  release = release_config.fetch("jobs")
  turbo = turbo_config.fetch("jobs")
  canonical_api_backend_source = "$" + "{{ vars.OKOU_API_BACKEND_URL }}"
  release_api_step = release.fetch("promote-api-production").fetch("steps").find do |step|
    step["name"] == "Resolve API production environment"
  end
  raise "missing release API production environment step" unless release_api_step
  release_runner_step = release.fetch("build-runner-production").fetch("steps").find do |step|
    step["name"] == "Build rootfs and snapshot on production hosts"
  end
  raise "missing release Runner build step" unless release_runner_step
  rollback_runner_step = rollback.fetch("rollback-runner").fetch("steps").find do |step|
    step["name"] == "Roll back Runner on production hosts"
  end
  raise "missing production Runner rollback step" unless rollback_runner_step

  selected_api_backend_sources = [
    release_api_step.fetch("with").fetch("api-backend-url"),
    release_runner_step.fetch("env").fetch("API_URL"),
    rollback_runner_step.fetch("env").fetch("API_URL"),
  ]
  unless selected_api_backend_sources == Array.new(3, canonical_api_backend_source)
    raise "production API backend sources must use only the canonical GitHub variable"
  end

  neutral_api_url = "$" + "{API_URL}"
  {
    "release Runner build" => release_runner_step,
    "production Runner rollback" => rollback_runner_step,
  }.each do |boundary, step|
    env = step.fetch("env")
    if env.key?("OKOU_API_BACKEND_URL")
      raise "#{boundary} must retain the neutral API_URL shell boundary"
    end
    unless step.fetch("run").include?("-e \"api_url=#{neutral_api_url}\"")
      raise "#{boundary} must retain the neutral Ansible api_url input"
    end
  end
  raise "rollback resolver must wait for queue" unless rollback.fetch("resolve-target").fetch("needs") == "queue-production-deploy"
  raise "Runner must wait for resolver" unless rollback.fetch("rollback-runner").fetch("needs") == "resolve-target"
  raise "API must wait for resolver" unless rollback.fetch("rollback-api").fetch("needs") == "resolve-target"
  release_job = release.fetch("release-please")
  release_needs = Array(release_job.fetch("needs"))
  raise "release must wait for production queue" unless release_needs.include?("queue-production-deploy")
  raise "release must wait for release detection" unless release_needs.include?("detect-release-commit")
  queue_needs = Array(release.fetch("queue-production-deploy").fetch("needs"))
  raise "production queue must wait for release detection" unless queue_needs.include?("detect-release-commit")
  release_target_output = "$" + "{{ steps.release-target.outputs.sha }}"
  raise "release job must expose the resolved release target" unless release_job.fetch("outputs").fetch("release_target") == release_target_output
  release_tags_output = "$" + "{{ steps.release-tags.outputs.tags }}"
  raise "release job must expose the current release tags" unless release_job.fetch("outputs").fetch("release_tags") == release_tags_output
  raise "release workflow must not use the triggering workflow SHA as a release target" if File.read(ARGV[1]).include?("github.event.workflow_run.head_sha")

  expected_target = "$" + "{{ needs.release-please.outputs.release_target }}"
  expected_tags = "$" + "{{ needs.release-please.outputs.release_tags }}"
  workflow_source = "$" + "{{ github.sha }}"
  checkout_ref_exceptions = {
    "queue-production-deploy" => "main",
    "refresh-release-pull-request" => "main",
    "update-rollback-dashboard" => workflow_source,
  }
  release.each do |job_name, job|
    checkout_steps = job.fetch("steps", []).select do |step|
      step["uses"].to_s.start_with?("actions/checkout@")
    end
    checkout_steps.each do |checkout_step|
      expected_ref = checkout_ref_exceptions.fetch(job_name, expected_target)
      actual_ref = checkout_step.fetch("with", {})["ref"]
      unless actual_ref == expected_ref
        raise "#{job_name} checkout must use #{expected_ref.inspect}, got #{actual_ref.inspect}"
      end
    end
  end

  host_worker_step = release.fetch("detect-host-worker-deploy-inputs").fetch("steps").find { |step| step["id"] == "detect" }
  raise "Host Worker detection must use the resolved release target" unless host_worker_step.fetch("run").include?("HEAD_SHA=\"#{expected_target}\"")
  host_worker = release.fetch("deploy-host-worker-production")
  unless Array(host_worker.fetch("needs")).include?("promote-api-production") &&
      host_worker.fetch("if").include?("needs.promote-api-production.result == \x27success\x27")
    raise "Host Worker authority must wait for successful API promotion"
  end
  schema_step = release.fetch("deploy-api-schema").fetch("steps").find { |step| step["name"] == "Publish Runtime API Schema" }
  raise "Runtime API Schema must use the resolved release target" unless schema_step.fetch("env").fetch("RELEASE_SHA") == expected_target
  dashboard_step = release.fetch("update-rollback-dashboard").fetch("steps").find { |step| step["name"] == "Update rollback dashboard issue" }
  dashboard_job = release.fetch("update-rollback-dashboard")
  dashboard_needs = Array(dashboard_job.fetch("needs"))
  raise "rollback dashboard must wait for Desktop promotion" unless dashboard_needs.include?("promote-desktop-release")
  dashboard_condition = dashboard_job.fetch("if")
  unless dashboard_condition.include?("needs.release-please.outputs.desktop_release_created != \x27true\x27") &&
      dashboard_condition.include?("needs.promote-desktop-release.result == \x27success\x27")
    raise "rollback dashboard must require successful applicable Desktop promotion"
  end
  raise "rollback dashboard must use the resolved release target" unless dashboard_step.fetch("env").fetch("RELEASE_TARGET") == expected_target
  raise "rollback dashboard must use the current release tags" unless dashboard_step.fetch("env").fetch("RELEASE_TAGS") == expected_tags
  raise "rollback dashboard must pass the current release tags to the helper" unless dashboard_step.fetch("run").include?("\"$RELEASE_TAGS\"")

  artifact_fetch_helper = "fetch-okou-app-artifact.sh"
  release_app_step = release.fetch("promote-app-worker-production").fetch("steps").find { |step| step["id"] == "worker-production" }
  release_app_run = release_app_step.fetch("run")
  raise "release App deployment must use the shared artifact fetcher" unless release_app_run.include?(artifact_fetch_helper)
  raise "release App deployment must not fall back to per-file artifacts" if release_app_run.include?("--recursive")

  api_release_steps = release.fetch("promote-api-production").fetch("steps")
  before = api_release_steps.index { |step| step["id"] == "production-migrations" }
  deploy = api_release_steps.index { |step| step["id"] == "deploy" }
  unless before && deploy && before < deploy
    raise "production migrations must finish before API deployment"
  end

  artifact_upload_step = turbo.fetch("deploy-app").fetch("steps").find { |step| step["name"] == "Upload canonical app artifact" }
  artifact_upload_run = artifact_upload_step.fetch("run")
  raise "deploy-app must upload the archived App artifact" unless artifact_upload_run.include?("/dist.tar.gz")
  raise "deploy-app must not upload per-file App artifacts" if artifact_upload_run.include?("aws s3 cp turbo/apps/platform/dist")
RUBY

assert_failure "Rollback target predates Pi memory storage retirement" \
  run_resolver "${tmp_dir}/pi-memory-retired-floor.output" MOCK_PI_MEMORY_RETIRED_FLOOR_VALID=0
[ ! -s "${tmp_dir}/pi-memory-retired-floor.output" ] || fail "incompatible Pi memory API must not publish rollback outputs"

: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the Stripe invoice-paid automation retirement" \
  run_resolver "${tmp_dir}/stripe-invoice-paid-floor.output" MOCK_STRIPE_INVOICE_PAID_RETIREMENT_FLOOR_VALID=0
[ ! -s "${tmp_dir}/stripe-invoice-paid-floor.output" ] || fail "table-dependent API must not publish rollback outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "Stripe invoice-paid retirement must reject before artifact or host access"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the Run output memory citation retirement" \
  run_resolver "${tmp_dir}/memory-citation-floor.output" MOCK_RUN_OUTPUT_MEMORY_CITATION_RETIREMENT_FLOOR_VALID=0
[ ! -s "${tmp_dir}/memory-citation-floor.output" ] || fail "citation-dependent API must not publish rollback outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "Run output memory citation retirement must reject before artifact or host access"
fi
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the retired member preference mapping" \
  run_resolver "${tmp_dir}/member-preference-floor.output" MOCK_MEMBER_PREFERENCE_RETIREMENT_FLOOR_VALID=0
[ ! -s "${tmp_dir}/member-preference-floor.output" ] || fail "member-preference-dependent API must not publish rollback outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "Retired member preference mapping must reject before artifact or host access"
fi

assert_failure "Cannot resolve the merged direct Workflow attachment runtime" \
  run_resolver "${tmp_dir}/workflow-attachment-missing.output" MOCK_WORKFLOW_ATTACHMENT_COMMIT=
[ ! -s "${tmp_dir}/workflow-attachment-missing.output" ] || fail "missing Workflow floor must not publish outputs"
assert_failure "Rollback target predates direct Workflow attachment ownership" \
  run_resolver "${tmp_dir}/workflow-attachment-api.output" MOCK_WORKFLOW_ATTACHMENT_API_VALID=0
[ ! -s "${tmp_dir}/workflow-attachment-api.output" ] || fail "legacy Workflow API must not publish outputs"
assert_failure "predates verified Workflow attachment delivery" \
  run_resolver "${tmp_dir}/workflow-attachment-runner.output" MOCK_WORKFLOW_ATTACHMENT_RUNNER_VALID=0
[ ! -s "${tmp_dir}/workflow-attachment-runner.output" ] || fail "unverified Workflow Runner must not publish outputs"


: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates explicit Run reference cleanup" \
  run_resolver "${tmp_dir}/run-reference-preparation.output" MOCK_RUN_REFERENCE_PREPARATION_VALID=0
[ ! -s "${tmp_dir}/run-reference-preparation.output" ] || fail "cascade-dependent API must not publish rollback outputs"
if grep -Eq '^(curl|ssh) ' "${tmp_dir}/boundaries.log"; then
  fail "Run reference preparation must reject before provider or host access"
fi

for run_reference_case in \
  "MOCK_RUN_REFERENCE_PREPARATION_AVAILABLE=0|Cannot read the Run reference preparation rollback floor from main" \
  "MOCK_RUN_REFERENCE_PREPARATION_COMMIT=invalid|Missing or invalid Run reference preparation rollback floor" \
  "MOCK_RUN_REFERENCE_PREPARATION_ON_MAIN=0|Run reference preparation rollback floor is not on main"; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "${run_reference_case#*|}" \
    run_resolver "${tmp_dir}/run-reference-policy.output" "${run_reference_case%%|*}"
  [ ! -s "${tmp_dir}/run-reference-policy.output" ] || fail "invalid Run policy must not publish outputs"
  if grep -Eq '^(curl|ssh) ' "${tmp_dir}/boundaries.log"; then
    fail "invalid Run policy must reject before provider or host access"
  fi
done

echo "resolve-production-rollback-target tests passed"
