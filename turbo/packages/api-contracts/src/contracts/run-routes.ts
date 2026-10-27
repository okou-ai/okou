import {
  array,
  boolean,
  literal,
  object,
  record,
  string,
  union,
  uuid,
  never as zNever,
  undefined as zUndefined,
  type infer as zInfer,
} from "zod";

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
import { modelProviderTypeSchema } from "./model-provider-types";
import {
  runnerHeartbeatGenerationSchema,
  runnerHostnameSchema,
  runnerVersionSchema,
  sandboxStartupPathSchema,
} from "./runner-primitives";

/**
 * Agent run request schema — subset of unified schema.
 * Server-side defaults are injected by agent-runs-create.service.ts:
 * disallowedTools.
 * Fields not used by unattended workflow runs are omitted:
 * triggerSource, vars, secrets, volumeVersions, permissionPolicies.
 */
export const runCreateBodySchema = unifiedRunRequestSchema
  .omit({
    triggerSource: true,
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
    triggerSource: zNever().optional(),
    modelProvider: modelProviderTypeSchema.optional(),
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
    pathParams: object({
      id: uuid("Run ID must be a valid UUID"),
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
    pathParams: object({
      id: uuid("Run ID must be a valid UUID").toLowerCase(),
    }),
    body: zUndefined(),
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
    pathParams: object({
      id: uuid("Run ID must be a valid UUID"),
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
 * Dynamic fields (environment, firewalls, storageMounts) are stored in Axiom.
 * Static fields (prompt, vars, secretNames) are merged from agent_runs at query time.
 */
export const runContextStorageMountSchema = object({
  name: string(),
  version: string(),
  mountPath: string(),
  writeback: boolean(),
});

const runContextSanitizedFirewallSchema = object({
  name: string(),
  apis: array(
    object({
      base: string(),
      permissions: array(
        object({
          name: string(),
          description: string().optional(),
          rules: array(string()),
        }),
      ).optional(),
    }),
  ),
});

// Keep name/apis at the top level so the previous web client can parse a new
// inline response through runContextSanitizedFirewallSchema during rollout.
const runContextExecutionInlineFirewallSchema =
  executionFirewallInlineEntrySchema.shape.firewall.extend({
    kind: literal("inline"),
    customConnectorId:
      executionFirewallInlineEntrySchema.shape.customConnectorId,
    sourceId: executionFirewallInlineEntrySchema.shape.sourceId,
  });

const runContextFirewallSchema = union([
  executionFirewallBuiltinEntrySchema,
  runContextExecutionInlineFirewallSchema,
  runContextSanitizedFirewallSchema,
]);

export const runContextResponseSchema = object({
  prompt: string(),
  appendSystemPrompt: string().nullable(),
  runId: string(),
  sessionId: string().nullable(),
  cliAgentType: string().optional(),
  secretNames: array(string()),
  vars: record(string(), string()).nullable(),
  environment: record(string(), string()),
  firewalls: array(runContextFirewallSchema),
  networkPolicies: networkPoliciesSchema.nullable(),
  storageMounts: array(runContextStorageMountSchema),
  featureFlags: record(string(), boolean()).nullable(),
});

export type RunContextStorageMount = zInfer<
  typeof runContextStorageMountSchema
>;

/**
 * Agent run context contract (GET /api/runs/:id/context)
 * Returns a launch-time execution context snapshot for debugging
 */
export const runContextContract = c.router({
  getContext: {
    method: "GET",
    path: "/api/runs/:id/context",
    headers: authHeadersSchema,
    pathParams: object({
      id: uuid("Run ID must be a valid UUID"),
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
    pathParams: object({
      id: uuid("Run ID must be a valid UUID"),
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
 * (sandbox startup path and runner identity). Kept separate from logDetailSchema
 * so runner-tab fields can grow without polluting the generic log
 * detail response.
 */
const runRunnerResponseSchema = object({
  sandboxStartupPath: sandboxStartupPathSchema.nullable(),
  runnerHostname: runnerHostnameSchema.nullable().optional(),
  runnerVersion: runnerVersionSchema.nullable().optional(),
  runnerId: uuid().nullable().optional(),
  runnerHeartbeatGeneration: runnerHeartbeatGenerationSchema
    .nullable()
    .optional(),
});

export const runRunnerContract = c.router({
  getRunner: {
    method: "GET",
    path: "/api/runs/:id/runner",
    headers: authHeadersSchema,
    pathParams: object({
      id: uuid("Run ID must be a valid UUID"),
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
export type RunContextResponse = zInfer<typeof runContextResponseSchema>;
export type RunRunnerResponse = zInfer<typeof runRunnerResponseSchema>;

// Type exports
export type RunsByIdContract = typeof runsByIdContract;
export type RunsCancelContract = typeof runsCancelContract;
export type RunsQueueContract = typeof runsQueueContract;
export type RunAgentEventsContract = typeof runAgentEventsContract;
export type RunContextContract = typeof runContextContract;
export type RunNetworkLogsContract = typeof runNetworkLogsContract;
export type RunRunnerContract = typeof runRunnerContract;
