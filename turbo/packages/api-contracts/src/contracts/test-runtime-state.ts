import { z } from "zod";
import { initContract } from "./base";
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
  // Test-only read boundary for the internal WSS target resolver. The public
  // bootstrap route never exposes a candidate without issuing a ticket.
  z.object({
    action: z.literal("resolve-runner-wss-target"),
    run_id: z.uuid(),
    user_id: z.string(),
    org_id: z.string(),
    now: z.iso.datetime().optional(),
  }),
  // Test-only boundary: DB-clock ticket expiry without giving API tests
  // direct access to database internals.
  z.object({
    action: z.literal("expire-runner-wss-tickets"),
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
    action: z.literal("read-run-uploaded-file-sources"),
    run_id: z.uuid(),
  }),
  z.object({
    action: z.literal("read-chat-event-snapshot-head"),
    thread_id: z.uuid(),
  }),
  z.object({
    action: z.literal("reserve-chat-event-sequence-gap"),
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
    action: z.literal("seed-pending-artifact-catalog-file"),
    user_id: z.string(),
    org_id: z.string(),
    filename: z.string(),
    url: z.url(),
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
    action: z.literal("reconcile-socialkit-downloads"),
    download_ids: z.array(z.uuid()).min(1).max(2),
  }),
]);

export const testRuntimeStateActionResponseSchema = z.object({
  ok: z.literal(true),
  processed: z.int().nonnegative().optional(),
  selected_model: z.string().optional(),
  built_in_model_route: builtInModelRuntimeRouteSchema.nullable().optional(),
  autonomy_budget: z.int().min(0).max(10).nullable().optional(),
  failure_reason: runFailureReasonTokenSchema.nullable().optional(),
  wss_target: z
    .object({
      runId: z.uuid(),
      runnerId: z.uuid(),
      publicOrigin: z.string(),
      ingressVerification: z.literal("not-observed"),
      observedMode: z.enum(["running", "draining"]),
      observedAt: z.iso.datetime(),
    })
    .nullable()
    .optional(),
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
  file_id: z.uuid().optional(),
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
