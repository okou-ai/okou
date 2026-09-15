import { z } from "zod";
import { initContract } from "./base";
import { connectorRuntimeTargetsSchema } from "./runners";
import { runFailureReasonTokenSchema } from "./run-failure-reasons";

const c = initContract();

// Test-only support actions for infrastructure fixtures used by API suites.
export const testRuntimeStateErrorSchema = z.object({
  error: z.string(),
});

const builtInModelRuntimeRouteSchema = z.object({
  provider_type: z.string(),
  upstream_model: z.string(),
  model_key_id: z.uuid(),
});

export const testRuntimeStateActionBodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("seed-built-in-default-model-key"),
    fixture_id: z.uuid(),
  }),
  z.object({
    action: z.literal("seed-built-in-model-key"),
    fixture_id: z.uuid(),
    selected_model: z.string(),
  }),
  z.object({
    action: z.literal("delete-built-in-model-key"),
    fixture_id: z.uuid(),
  }),
  z.object({
    action: z.literal("seed-built-in-model-candidate-keys"),
    fixture_id: z.uuid(),
    selected_model: z.string(),
  }),
  z.object({
    action: z.literal("resolve-built-in-model-route"),
    selected_model: z.string(),
  }),
  z.object({
    action: z.literal("set-built-in-candidate-cooldown"),
    selected_model: z.string(),
    provider_type: z.string(),
    upstream_model: z.string(),
    unavailable_until: z.iso.datetime(),
  }),
  z.object({
    action: z.literal("delete-built-in-candidate-cooldown"),
    selected_model: z.string(),
    provider_type: z.string(),
    upstream_model: z.string(),
  }),
  z.object({
    action: z.literal("read-browser-screenshot-schema-state"),
  }),
  z.object({
    action: z.literal("read-usage-pack-invitation-schema-state"),
  }),
  z.object({
    action: z.literal("read-usage-pack-purchase-serialization-schema-state"),
  }),
  z.object({
    action: z.literal("set-run-autonomy-budget"),
    run_id: z.uuid(),
    autonomy_budget: z.int().min(0).max(10),
  }),
  z.object({
    action: z.literal("read-run-autonomy-budget"),
    run_id: z.uuid(),
  }),
  z.object({
    action: z.literal("read-run-failure-reason"),
    run_id: z.uuid(),
  }),
  z.object({
    action: z.literal("set-run-model-provider"),
    run_id: z.uuid(),
    model_provider: z.string().nullable(),
  }),
  z.object({
    action: z.literal("save-run-summary"),
    run_id: z.uuid(),
    trigger_source: z.string(),
    prompt: z.string(),
    result_text: z.string(),
  }),
  z.object({
    action: z.literal("set-workflow-automation-autonomy-budget"),
    automation_id: z.uuid(),
    autonomy_budget: z.int().min(0).max(10),
  }),
  z.object({
    action: z.literal("read-workflow-automation-autonomy-state"),
    automation_id: z.uuid(),
  }),
  z.object({
    action: z.literal("read-latest-workflow-automation-run"),
    automation_id: z.uuid(),
  }),
  z.object({
    action: z.literal("reset-database-pool"),
  }),
  z.object({
    action: z.literal("mutate-runner-job-secret-value-environment-keys"),
    run_id: z.uuid(),
    mode: z.enum(["remove", "invalid"]),
  }),
  z.object({
    action: z.literal("set-runner-job-pi-context-as-versioned-writer"),
    run_id: z.uuid(),
    // Stored rows can come from a future or invalid writer. The claim boundary
    // must validate them, not this test-only fixture endpoint.
    pi_model_config: z.record(z.string(), z.unknown()),
  }),
  z.object({
    action: z.literal("enable-queued-pi-ownership-transfer"),
    run_id: z.uuid(),
  }),
  z.object({
    action: z.literal("mutate-runner-job-connector-permission-baseline"),
    run_id: z.uuid(),
    mode: z.enum([
      "remove",
      "malformed",
      "capability-mismatch",
      "catalog-mismatch",
      "authority-mismatch",
      "inconsistent",
      "incomplete",
    ]),
  }),
  z.object({
    action: z.literal("set-runner-job-connector-runtime-targets"),
    run_id: z.uuid(),
    connector_runtime_targets: connectorRuntimeTargetsSchema,
  }),
  z.object({
    action: z.literal("remove-run-canonical-storage-state"),
    run_id: z.uuid(),
  }),
  z.object({
    action: z.literal("read-runner-job-storage-state"),
    run_id: z.uuid(),
  }),
  z.object({
    action: z.literal("read-run-claim-owner"),
    run_id: z.uuid(),
  }),
  z.object({
    action: z.literal("read-storage-persistence-state"),
    run_id: z.uuid(),
    session_id: z.uuid(),
    checkpoint_id: z.uuid(),
  }),
  z.object({
    action: z.literal("hold-org-admission-lock"),
    org_id: z.string(),
  }),
  z.object({
    action: z.literal("read-org-admission-lock-state"),
  }),
  z.object({
    action: z.literal("release-org-admission-lock"),
  }),
  z.object({
    action: z.literal("read-run-uploaded-file-sources"),
    run_id: z.uuid(),
  }),
  z.object({
    action: z.literal("read-chat-event-snapshot-head"),
    thread_id: z.uuid(),
  }),
  z.object({
    action: z.literal("read-chat-event-rows-as-previous-api"),
    thread_id: z.uuid(),
  }),
  z.object({
    action: z.literal("advance-chat-event-sequence-as-previous-api"),
    thread_id: z.uuid(),
    count: z.int().positive(),
  }),
  z.object({
    action: z.literal("update-chat-event-snapshot-head"),
    thread_id: z.uuid(),
    object_key: z.string().optional(),
    last_seq_id: z.int().nonnegative().optional(),
    last_event_id: z.uuid().optional(),
  }),
  z.object({
    action: z.literal("clear-run-api-start"),
    run_id: z.uuid(),
  }),
  z.object({
    action: z.literal("read-run-api-start"),
    run_id: z.uuid(),
  }),
  z.object({
    action: z.literal("steer-run-time-budget"),
    run_id: z.uuid(),
    elapsed_ms: z.int().nonnegative(),
  }),
  z.object({
    action: z.literal("read-run-launch-snapshot"),
    run_id: z.uuid(),
  }),
  z.object({
    action: z.literal("read-official-workflow-run-state"),
    run_id: z.uuid(),
  }),
  z.object({
    action: z.literal("read-agent-run-family-counts"),
    agent_id: z.uuid(),
  }),
  z.object({
    action: z.literal("corrupt-official-workflow-revision-payload"),
    definition_name: z.string(),
  }),
  z.object({
    action: z.literal("set-official-workflow-automation-admission-state"),
    automation_id: z.uuid(),
    blueprint_key: z.string().min(1).optional(),
    reconciliation_status: z.enum([
      "current",
      "reconciling",
      "needs_reconfiguration",
      "failed",
    ]),
    applied_fingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  }),
  z.object({
    action: z.literal("retarget-workflow-automation"),
    automation_id: z.uuid(),
    workflow_id: z.uuid(),
  }),
  z.object({
    action: z.literal(
      "assert-official-workflow-automation-final-admission-rejected",
    ),
    automation_id: z.uuid(),
    official_workflow_id: z.uuid(),
  }),
  z.object({
    action: z.literal("hold-official-workflow-run-gate"),
    gate: z.enum(["observation", "final-admission", "bootstrap-requirement"]),
  }),
  z.object({
    action: z.literal("read-official-workflow-run-gate-state"),
  }),
  z.object({
    action: z.literal("release-official-workflow-run-gate"),
  }),
  z.object({
    action: z.literal("read-thread-session-binding"),
    thread_id: z.uuid(),
  }),
  z.object({
    action: z.literal("read-thread-session-conversation"),
    thread_id: z.uuid(),
  }),
  z.object({
    action: z.literal("insert-legacy-artifact-catalog-file"),
    user_id: z.string(),
    org_id: z.string(),
    filename: z.string(),
    url: z.url(),
  }),
  z.object({
    action: z.literal("insert-hosted-site-as-previous-api"),
    user_id: z.string(),
    org_id: z.string(),
    run_id: z.uuid(),
    site: z.string(),
    public_slug: z.string(),
  }),
  z.object({
    action: z.literal("insert-hosted-deployment-as-previous-api"),
    user_id: z.string(),
    org_id: z.string(),
    run_id: z.uuid(),
    hosted_site_id: z.uuid(),
  }),
  z.object({
    action: z.literal("set-computer-use-host-as-previous-api"),
    thread_id: z.uuid(),
    computer_use_host_id: z.uuid(),
  }),
  z.object({
    action: z.literal("set-browser-tab-snapshot-as-previous-api"),
    thread_id: z.uuid(),
    tab_urls: z.array(z.string().max(8192)).max(50),
  }),
  z.object({
    action: z.literal("set-runner-job-context-profile-as-previous-api"),
    run_id: z.uuid(),
    profile: z.string(),
  }),
  z.object({
    action: z.literal(
      "clear-workflow-automation-event-connector-as-previous-api",
    ),
    automation_id: z.uuid(),
  }),
  z.object({
    action: z.literal("set-custom-connector-auth-template-fixture"),
    connector_id: z.uuid(),
    value_template: z.string(),
  }),
  z.object({
    action: z.literal("reconcile-socialkit-downloads"),
    download_ids: z.array(z.uuid()).min(1).max(2),
  }),
]);

export const testRuntimeStateActionResponseSchema = z.object({
  ok: z.literal(true),
  processed: z.int().nonnegative().optional(),
  selected_model: z.string().optional(),
  built_in_model_route: builtInModelRuntimeRouteSchema.nullable().optional(),
  browser_screenshot_schema_available: z.boolean().optional(),
  usage_pack_invitation_schema_available: z.boolean().optional(),
  usage_pack_purchase_serialization_schema_available: z.boolean().optional(),
  autonomy_budget: z.int().min(0).max(10).nullable().optional(),
  failure_reason: runFailureReasonTokenSchema.nullable().optional(),
  workflow_automation_state: z
    .object({
      autonomy_budget: z.int().min(0).max(10),
      enabled: z.boolean(),
      event_connector_id: z.uuid().nullable(),
      last_run_id: z.uuid().nullable(),
      official_blueprint_key: z.string().nullable(),
      official_result_email_enabled: z.boolean().nullable(),
    })
    .nullable()
    .optional(),
  workflow_automation_run: z
    .object({
      run_id: z.uuid(),
      autonomy_budget: z.int().min(0).max(10),
    })
    .nullable()
    .optional(),
  admission_lock_held: z.boolean().optional(),
  admission_lock_waiting: z.boolean().optional(),
  uploaded_file_sources: z.array(z.string()).optional(),
  chat_event_snapshot_head: z
    .object({
      archive_schema_version: z.int().positive(),
      last_event_id: z.uuid(),
      last_seq_id: z.int().nonnegative(),
      terminal_event_id: z.uuid().nullable(),
      terminal_seq_id: z.int().nonnegative().nullable(),
      object_key: z.string(),
      snapshot_count: z.int().positive(),
    })
    .nullable()
    .optional(),
  previous_api_chat_event_rows: z
    .array(
      z.object({
        id: z.uuid(),
        event_type: z.string(),
        revokes_event_id: z.uuid().nullable(),
        payload_keys: z.array(z.string()),
      }),
    )
    .optional(),
  api_started_at: z.string().nullable().optional(),
  run_time_budget: z
    .object({
      scanned: z.int().nonnegative(),
      steered: z.int().nonnegative(),
    })
    .optional(),
  run_launch_snapshot: z
    .object({
      exists: z.boolean(),
      launch_snapshot: z
        .discriminatedUnion("schemaVersion", [
          z
            .object({
              schemaVersion: z.literal(1),
              framework: z.enum(["claude-code", "codex", "pi"]),
              runnerProfile: z.string().min(1).max(255),
            })
            .strict(),
          z
            .object({
              schemaVersion: z.literal(2),
              framework: z.enum(["claude-code", "codex", "pi"]),
              runnerProfile: z.string().min(1).max(255),
              piMemoryGenerationEnabled: z.boolean(),
            })
            .strict(),
          z
            .object({
              schemaVersion: z.literal(3),
              framework: z.enum(["claude-code", "codex", "pi"]),
              runnerProfile: z.string().min(1).max(255),
            })
            .strict(),
          z.strictObject({
            schemaVersion: z.literal(4),
            framework: z.literal("pi"),
            executionMode: z.literal("api-inference"),
            inferenceContractVersion: z.literal(1),
          }),
        ])
        .nullable(),
    })
    .optional(),
  official_workflow_run_state: z
    .object({
      status: z.string(),
      model_provider: z.string().nullable(),
      provenance: z
        .object({
          schemaVersion: z.literal(1),
          definitions: z.array(
            z.object({
              name: z.string(),
              revision: z.string().regex(/^[0-9a-f]{64}$/),
              artifact: z.object({
                orgId: z.string(),
                userId: z.string(),
                storageName: z.string(),
                storageId: z.uuid(),
                storageVersion: z.string().regex(/^[0-9a-f]{64}$/),
              }),
            }),
          ),
        })
        .nullable(),
      storage_mounts: z
        .array(
          z.object({
            org_id: z.string(),
            user_id: z.string(),
            name: z.string(),
            storage_id: z.uuid(),
            version: z.string().optional(),
            mount_path: z.string(),
            writeback: z.boolean().optional(),
          }),
        )
        .nullable(),
      runner_job_count: z.int().nonnegative(),
      callback_count: z.int().nonnegative(),
    })
    .nullable()
    .optional(),
  agent_run_family_counts: z
    .object({
      run_count: z.int().nonnegative(),
      callback_count: z.int().nonnegative(),
      runner_job_count: z.int().nonnegative(),
      launch_queue_count: z.int().nonnegative(),
    })
    .optional(),
  official_workflow_run_gate_state: z
    .object({
      gate: z.enum(["observation", "final-admission", "bootstrap-requirement"]),
      arrivals: z.int().nonnegative(),
      shared_catalog_holder_count: z.int().nonnegative(),
      exclusive_catalog_waiter_count: z.int().nonnegative(),
      blocked_waiter_count: z.int().nonnegative(),
      bootstrap_requirement: z
        .object({
          workflow_ids: z.array(z.uuid()),
          queue_first_kind: z
            .enum(["user_message", "automation_event"])
            .nullable(),
          workflow_automation_id: z.uuid().nullable(),
        })
        .nullable(),
    })
    .nullable()
    .optional(),
  thread_session_binding: z
    .object({
      agent_session_id: z.uuid().nullable(),
      agent_session_run_id: z.uuid().nullable(),
      run_session_id: z.uuid().nullable(),
    })
    .optional(),
  thread_session_conversation: z
    .object({
      agent_session_id: z.uuid().nullable(),
      conversation_id: z.uuid().nullable(),
      conversation_run_id: z.uuid().nullable(),
    })
    .optional(),
  file_id: z.uuid().optional(),
  hosted_site_id: z.uuid().optional(),
  hosted_deployment_scope_blocked: z.boolean().optional(),
  storage_persistence: z
    .object({
      run_canonical: z.boolean(),
      session_canonical: z.boolean(),
      checkpoint_canonical: z.boolean(),
    })
    .optional(),
  runner_job_storage_state: z
    .object({
      has_stored_storage_manifest: z.boolean(),
      canonical_mount_count: z.number().int().nonnegative(),
      has_run_context_storage: z.boolean(),
    })
    .optional(),
  runner_claim_owner: z
    .object({
      runner_id: z.uuid().nullable(),
      heartbeat_generation: z
        .number()
        .int()
        .positive()
        .max(Number.MAX_SAFE_INTEGER)
        .nullable(),
    })
    .optional(),
});

export const testRuntimeStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/runtime-state/action",
    body: testRuntimeStateActionBodySchema,
    responses: {
      200: testRuntimeStateActionResponseSchema,
      400: testRuntimeStateErrorSchema,
      404: z.string(),
    },
    summary: "Mutate API test support state",
  },
});

export type TestRuntimeStateContract = typeof testRuntimeStateContract;
export type TestRuntimeStateActionBody = z.infer<
  typeof testRuntimeStateActionBodySchema
>;
export type TestRuntimeStateActionResponse = z.infer<
  typeof testRuntimeStateActionResponseSchema
>;
