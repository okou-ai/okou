import { z } from "zod";
import { initContract } from "./base";

const c = initContract();

// Test-only support actions for infrastructure fixtures used by API suites.
export const testRuntimeStateErrorSchema = z.object({
  error: z.string(),
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
    action: z.literal("set-run-autonomy-budget"),
    run_id: z.uuid(),
    autonomy_budget: z.int().min(0).max(32),
  }),
  z.object({
    action: z.literal("read-run-autonomy-budget"),
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
    action: z.literal("save-run-summary"),
    run_id: z.uuid(),
    trigger_source: z.string(),
    prompt: z.string(),
    result_text: z.string(),
  }),
  z.object({
    action: z.literal("set-workflow-automation-autonomy-budget"),
    automation_id: z.uuid(),
    autonomy_budget: z.int().min(0).max(32),
  }),
  z.object({
    action: z.literal("read-workflow-automation-autonomy-state"),
    automation_id: z.uuid(),
  }),
  z.object({
    action: z.literal("clear-run-api-start"),
    run_id: z.uuid(),
  }),
  z.object({
    action: z.literal("read-run-launch-snapshot"),
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
]);

export const testRuntimeStateActionResponseSchema = z.object({
  ok: z.literal(true),
  selected_model: z.string().optional(),
  autonomy_budget: z.int().min(0).max(32).nullable().optional(),
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
      autonomy_budget: z.int().min(0).max(32),
      enabled: z.boolean(),
      event_connector_id: z.uuid().nullable(),
      last_run_id: z.uuid().nullable(),
      official_blueprint_key: z.string().nullable(),
      official_result_email_enabled: z.boolean().nullable(),
    })
    .nullable()
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
