import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  executionFirewallBuiltinEntrySchema,
  executionFirewallInlineEntrySchema,
  networkPoliciesSchema,
} from "@okouai/connectors/firewall-contracts";
import {
  getRunResponseSchema,
  cancelRunResponseSchema,
  agentEventsResponseSchema,
  queueResponseSchema,
  unifiedRunRequestSchema,
  networkLogsResponseSchema,
  createLogPaginationQuerySchema,
} from "./runs";
import { modelProviderWriteTypeSchema } from "./model-providers";
import {
  runnerHeartbeatGenerationSchema,
  runnerHostnameSchema,
  runnerVersionSchema,
  sandboxReuseResultSchema,
  workspaceReuseResultSchema,
} from "./runner-primitives";

/**
 * Agent run request schema — subset of unified schema.
 * Server-side defaults are injected by agent-runs-create.service.ts:
 * artifacts, disallowedTools.
 * Fields not used by unattended workflow runs are omitted:
 * triggerSource, vars, secrets, volumeVersions, permissionPolicies.
 */
export const runCreateBodySchema = unifiedRunRequestSchema
  .omit({
    triggerSource: true,
    artifacts: true,
    disallowedTools: true,
    volumeVersions: true,
    vars: true,
    secrets: true,
    appendSystemPrompt: true,
    modelProviderType: true,
    permissionPolicies: true,
  })
  .extend({
    // This endpoint owns the source; never strip an obsolete execution request
    // into an ordinary launch. Callers must omit source authority entirely.
    triggerSource: z.never().optional(),
    modelProvider: modelProviderWriteTypeSchema.optional(),
  });

const c = initContract();

const agentEventPaginationQuerySchema = createLogPaginationQuerySchema({
  cursorKind: "sequence",
});

const networkLogPaginationQuerySchema = createLogPaginationQuerySchema({
  cursorKind: "time",
  maxLimit: 500,
  defaultLimit: 500,
  defaultOrder: "asc",
});

/**
 * Agent runs by ID contract (GET /api/runs/:id)
 */
export const runsByIdContract = c.router({
  getById: {
    method: "GET",
    path: "/api/runs/:id",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.uuid("Run ID must be a valid UUID"),
    }),
    responses: {
      200: getRunResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get agent run by ID",
  },
});

/**
 * Agent runs cancel contract (POST /api/runs/:id/cancel)
 */
export const runsCancelContract = c.router({
  cancel: {
    method: "POST",
    path: "/api/runs/:id/cancel",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.uuid("Run ID must be a valid UUID").toLowerCase(),
    }),
    body: z.undefined(),
    responses: {
      200: cancelRunResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Cancel a pending or running run",
  },
});

/**
 * Agent runs queue contract (GET /api/runs/queue)
 */
export const runsQueueContract = c.router({
  getQueue: {
    method: "GET",
    path: "/api/runs/queue",
    headers: authHeadersSchema,
    responses: {
      200: queueResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Get org run queue status",
  },
});

/**
 * Agent run telemetry events contract (GET /api/runs/:id/telemetry/agent)
 */
export const runAgentEventsContract = c.router({
  getAgentEvents: {
    method: "GET",
    path: "/api/runs/:id/telemetry/agent",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.uuid("Run ID must be a valid UUID"),
    }),
    query: agentEventPaginationQuerySchema,
    responses: {
      200: agentEventsResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get agent events with pagination",
  },
});

/**
 * Run context snapshot — launch-time execution context for debugging.
 * Environment secret values are redacted. Firewall auth retains the prepared
 * execution templates, including secret references, but never resolves them.
 * Dynamic fields (environment, firewalls, volumes, artifact) are stored in Axiom.
 * Static fields (prompt, vars, secretNames) are merged from agent_runs at query time.
 */
const runContextVolumeSchema = z.object({
  name: z.string(),
  mountPath: z.string(),
  vasStorageName: z.string(),
  vasVersionId: z.string(),
});

const runContextArtifactSchema = z.object({
  mountPath: z.string(),
  vasStorageName: z.string(),
  vasVersionId: z.string(),
});

const runContextSanitizedFirewallSchema = z.object({
  name: z.string(),
  apis: z.array(
    z.object({
      base: z.string(),
      permissions: z
        .array(
          z.object({
            name: z.string(),
            description: z.string().optional(),
            rules: z.array(z.string()),
          }),
        )
        .optional(),
    }),
  ),
});

// Keep name/apis at the top level so the previous web client can parse a new
// inline response through runContextSanitizedFirewallSchema during rollout.
const runContextExecutionInlineFirewallSchema =
  executionFirewallInlineEntrySchema.shape.firewall.extend({
    kind: z.literal("inline"),
    customConnectorId:
      executionFirewallInlineEntrySchema.shape.customConnectorId,
    sourceId: executionFirewallInlineEntrySchema.shape.sourceId,
  });

const runContextFirewallSchema = z.union([
  executionFirewallBuiltinEntrySchema,
  runContextExecutionInlineFirewallSchema,
  runContextSanitizedFirewallSchema,
]);

export const runContextResponseSchema = z.object({
  prompt: z.string(),
  appendSystemPrompt: z.string().nullable(),
  runId: z.string(),
  sessionId: z.string().nullable(),
  cliAgentType: z.string().optional(),
  secretNames: z.array(z.string()),
  vars: z.record(z.string(), z.string()).nullable(),
  environment: z.record(z.string(), z.string()),
  firewalls: z.array(runContextFirewallSchema),
  networkPolicies: networkPoliciesSchema.nullable(),
  volumes: z.array(runContextVolumeSchema),
  artifact: runContextArtifactSchema.nullable(),
  featureFlags: z.record(z.string(), z.boolean()).nullable(),
});

/**
 * Agent run context contract (GET /api/runs/:id/context)
 * Returns a launch-time execution context snapshot for debugging
 */
export const runContextContract = c.router({
  getContext: {
    method: "GET",
    path: "/api/runs/:id/context",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.uuid("Run ID must be a valid UUID"),
    }),
    responses: {
      200: runContextResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get run execution context snapshot for debugging",
  },
});

/**
 * Agent run network logs contract (GET /api/runs/:id/network)
 * Returns mitmproxy network logs for a run
 */
export const runNetworkLogsContract = c.router({
  getNetworkLogs: {
    method: "GET",
    path: "/api/runs/:id/network",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.uuid("Run ID must be a valid UUID"),
    }),
    query: networkLogPaginationQuerySchema,
    responses: {
      200: networkLogsResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get network logs for a run",
  },
});

/**
 * Agent run runner contract (GET /api/runs/:id/runner)
 * Returns runner-level metadata about how the run was provisioned
 * (sandbox reuse decision, etc.). Kept separate from logDetailSchema
 * so runner-tab fields can grow without polluting the generic log
 * detail response.
 */
const runRunnerResponseSchema = z.object({
  sandboxReuseResult: sandboxReuseResultSchema.nullable(),
  workspaceReuseResult: workspaceReuseResultSchema.nullable().optional(),
  runnerHostname: runnerHostnameSchema.nullable().optional(),
  runnerVersion: runnerVersionSchema.nullable().optional(),
  runnerId: z.uuid().nullable().optional(),
  runnerHeartbeatGeneration: runnerHeartbeatGenerationSchema
    .nullable()
    .optional(),
});

export const runRunnerContract = c.router({
  getRunner: {
    method: "GET",
    path: "/api/runs/:id/runner",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.uuid("Run ID must be a valid UUID"),
    }),
    responses: {
      200: runRunnerResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get runner-level metadata for a run",
  },
});

// Inferred types from Zod schemas
export type RunContextResponse = z.infer<typeof runContextResponseSchema>;
export type RunRunnerResponse = z.infer<typeof runRunnerResponseSchema>;

// Type exports
export type RunsByIdContract = typeof runsByIdContract;
export type RunsCancelContract = typeof runsCancelContract;
export type RunsQueueContract = typeof runsQueueContract;
export type RunAgentEventsContract = typeof runAgentEventsContract;
export type RunContextContract = typeof runContextContract;
export type RunNetworkLogsContract = typeof runNetworkLogsContract;
export type RunRunnerContract = typeof runRunnerContract;
