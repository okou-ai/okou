import { oomEvidenceSchema } from "./oom-evidence";
import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { connectorSlugSchema } from "./connector-identity";
import { apiErrorSchema } from "./errors";
import { runFailureReasonTokenSchema } from "./run-failure-reasons";
import { piMemoryCitationSchema } from "./pi-memory-citations";
import {
  X_RESOURCE_USAGE_MAX_IDS,
  xResourceUsageEventSchema,
} from "./x-resource-usage";
import {
  artifactMissingRootPolicySchema,
  RESUME_SESSION_HISTORY_MAX_BYTES,
  runnerHostnameSchema,
  runnerVersionSchema,
  sandboxReuseResultSchema,
  sessionHistoryDownloadSourceSchema,
  sessionHistoryEncodingSchema,
  sessionHistorySizeBucketSchema,
  secretConnectorMetadataMapSchema,
  workspaceReuseResultSchema,
} from "./runners";
import { eventSequenceNumberSchema, networkLogEntrySchema } from "./runs";
import {
  presignedUploadSchema,
  storageChangesSchema,
  storageManifestFilesSchema,
} from "./storages";

export {
  sandboxReuseResultSchema,
  workspaceReuseResultSchema,
  type SandboxReuseResult,
  type WorkspaceReuseResult,
} from "./runners";

const c = initContract();

// Hash-backed resume history is keyed and verified as lowercase SHA-256 hex.
// Accepting other 64-character strings would defer bad input until runner claim.
const sha256HexSchema = z
  .string()
  .regex(
    /^[a-f0-9]{64}$/,
    "hash must be a lowercase 64-character SHA-256 hex string",
  );

const piMemoryPhase2CheckpointAttestationSchema = z
  .object({
    schemaVersion: z.literal(2),
    leaseToken: z.uuid(),
    claimedRevision: z.number().int().positive(),
    claimedBaseVersionId: sha256HexSchema,
    selectionDigest: sha256HexSchema,
    validatedVersionId: sha256HexSchema,
  })
  .strict();

const thirdPartyWebhookErrorSchema = z.object({ error: z.string() });
const thirdPartyWebhookOkSchema = z.union([
  z.string(),
  z.object({ message: z.literal("pong") }),
]);
const miniMaxWebhookOkSchema = z.union([
  thirdPartyWebhookOkSchema,
  z.object({ challenge: z.string() }),
]);

/**
 * Clerk third-party webhook contract for /api/webhooks/clerk.
 */
export const webhookClerkContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/clerk",
    body: c.type<string>(),
    responses: {
      200: thirdPartyWebhookOkSchema,
      401: thirdPartyWebhookErrorSchema,
      503: thirdPartyWebhookErrorSchema,
    },
    summary: "Handle Clerk organization and user webhooks",
  },
});

/**
 * GitHub App third-party webhook contract for /api/webhooks/github.
 */
export const webhookGithubContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/github",
    body: c.type<string>(),
    responses: {
      200: thirdPartyWebhookOkSchema,
      400: thirdPartyWebhookErrorSchema,
      401: thirdPartyWebhookErrorSchema,
      503: thirdPartyWebhookErrorSchema,
    },
    summary: "Handle GitHub App webhooks",
  },
});

/**
 * Stripe third-party webhook contract for /api/webhooks/stripe.
 */
export const webhookStripeContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/stripe",
    body: c.type<string>(),
    responses: {
      200: thirdPartyWebhookOkSchema,
      401: thirdPartyWebhookErrorSchema,
      503: thirdPartyWebhookErrorSchema,
    },
    summary: "Handle Stripe billing webhooks",
  },
});

/**
 * Stripe Connect automation-event webhook contract. This route is intentionally
 * separate from the platform billing webhook above.
 */
export const webhookStripeAutomationEventsContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/stripe-automation-events",
    body: c.type<string>(),
    responses: {
      200: thirdPartyWebhookOkSchema,
      400: thirdPartyWebhookErrorSchema,
      401: thirdPartyWebhookErrorSchema,
      500: thirdPartyWebhookErrorSchema,
      503: thirdPartyWebhookErrorSchema,
    },
    summary: "Handle Stripe Connect automation events",
  },
});

const gmailWebhookResponseSchema = z.object({
  success: z.literal(true),
  watchStates: z.number(),
  dispatched: z.number(),
  duplicates: z.number(),
});

const googleCalendarWebhookResponseSchema = z.object({
  success: z.literal(true),
  watchStates: z.number(),
  dispatched: z.number(),
  duplicates: z.number(),
});

const googleFormsWebhookResponseSchema = z.object({
  success: z.literal(true),
  watchStates: z.number(),
  dispatched: z.number(),
  duplicates: z.number(),
});

const googleWorkspaceEventsWebhookResponseSchema = z.object({
  success: z.literal(true),
  watchStates: z.number(),
  dispatched: z.number(),
  duplicates: z.number(),
});

const notionWebhookResponseSchema = z.object({
  success: z.literal(true),
  kind: z.enum(["verification", "event"]),
  pending: z.number(),
  refreshed: z.number(),
  duplicates: z.number(),
});

const workflowAutomationWebhookResponseSchema = z.object({
  success: z.literal(true),
  duplicate: z.boolean(),
  runId: z.string().uuid().optional(),
});

/**
 * Gmail Pub/Sub push webhook contract for /api/webhooks/gmail.
 */
export const webhookGmailContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/gmail",
    body: c.type<string>(),
    responses: {
      200: gmailWebhookResponseSchema,
      400: thirdPartyWebhookErrorSchema,
      401: thirdPartyWebhookErrorSchema,
      429: thirdPartyWebhookErrorSchema,
      503: thirdPartyWebhookErrorSchema,
    },
    summary: "Handle Gmail Pub/Sub push notifications",
  },
});

/**
 * Google Forms Pub/Sub push webhook contract.
 */
export const webhookGoogleFormsContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/google-forms",
    body: c.type<string>(),
    responses: {
      200: googleFormsWebhookResponseSchema,
      400: thirdPartyWebhookErrorSchema,
      401: thirdPartyWebhookErrorSchema,
      429: thirdPartyWebhookErrorSchema,
      503: thirdPartyWebhookErrorSchema,
    },
    summary: "Handle Google Forms Pub/Sub push notifications",
  },
});

/**
 * Google Calendar push webhook contract for /api/webhooks/google-calendar.
 */
export const webhookGoogleCalendarContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/google-calendar",
    body: c.type<string>(),
    responses: {
      200: googleCalendarWebhookResponseSchema,
      400: thirdPartyWebhookErrorSchema,
      401: thirdPartyWebhookErrorSchema,
      429: thirdPartyWebhookErrorSchema,
      503: thirdPartyWebhookErrorSchema,
    },
    summary: "Handle Google Calendar push notifications",
  },
});

/**
 * Google Workspace Events Pub/Sub push webhook contract for
 * /api/webhooks/google-workspace-events.
 */
export const webhookGoogleWorkspaceEventsContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/google-workspace-events",
    body: c.type<string>(),
    responses: {
      200: googleWorkspaceEventsWebhookResponseSchema,
      400: thirdPartyWebhookErrorSchema,
      401: thirdPartyWebhookErrorSchema,
      429: thirdPartyWebhookErrorSchema,
      503: thirdPartyWebhookErrorSchema,
    },
    summary: "Handle Google Workspace Events Pub/Sub push notifications",
  },
});

/**
 * Notion webhook contract for /api/webhooks/notion.
 */
export const webhookNotionContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/notion",
    body: c.type<string>(),
    responses: {
      200: notionWebhookResponseSchema,
      400: thirdPartyWebhookErrorSchema,
      401: thirdPartyWebhookErrorSchema,
      503: thirdPartyWebhookErrorSchema,
    },
    summary: "Handle Notion webhook events",
  },
});

const workflowAutomationWebhookPostRoute = {
  method: "POST" as const,
  pathParams: z.object({
    token: z.string().min(1),
  }),
  body: c.type<string>(),
  responses: {
    200: workflowAutomationWebhookResponseSchema,
    400: thirdPartyWebhookErrorSchema,
    401: thirdPartyWebhookErrorSchema,
    404: thirdPartyWebhookErrorSchema,
    413: thirdPartyWebhookErrorSchema,
    429: thirdPartyWebhookErrorSchema,
    500: thirdPartyWebhookErrorSchema,
  },
};

/**
 * Workflow automation inbound webhook contract for
 * /api/webhooks/workflow-automations/:token.
 */
export const webhookWorkflowAutomationContract = c.router({
  post: {
    ...workflowAutomationWebhookPostRoute,
    path: "/api/webhooks/workflow-automations/:token",
    summary: "Handle inbound workflow automation webhooks",
  },
});

export const webhookBuiltInGenerationFalContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/built-in-generations/fal/:generationId",
    pathParams: z.object({
      generationId: z.uuid(),
    }),
    query: z.object({
      token: z.string().min(1),
      visualKey: z.string().min(1).optional(),
    }),
    body: c.type<string>(),
    responses: {
      200: thirdPartyWebhookOkSchema,
      400: thirdPartyWebhookErrorSchema,
      401: thirdPartyWebhookErrorSchema,
      503: thirdPartyWebhookErrorSchema,
    },
    summary: "Handle fal built-in generation webhooks",
  },
});

export const webhookBuiltInGenerationBytePlusContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/built-in-generations/byteplus/:generationId",
    pathParams: z.object({
      generationId: z.uuid(),
    }),
    query: z.object({
      token: z.string().min(1),
      visualKey: z.string().min(1).optional(),
    }),
    body: c.type<string>(),
    responses: {
      200: thirdPartyWebhookOkSchema,
      400: thirdPartyWebhookErrorSchema,
      401: thirdPartyWebhookErrorSchema,
      503: thirdPartyWebhookErrorSchema,
    },
    summary: "Handle BytePlus built-in generation webhooks",
  },
});

export const webhookBuiltInGenerationMiniMaxContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/built-in-generations/minimax/:generationId",
    pathParams: z.object({
      generationId: z.uuid(),
    }),
    query: z.object({
      token: z.string().min(1),
      visualKey: z.string().min(1).optional(),
    }),
    body: c.type<string>(),
    responses: {
      200: miniMaxWebhookOkSchema,
      400: thirdPartyWebhookErrorSchema,
      401: thirdPartyWebhookErrorSchema,
      503: thirdPartyWebhookErrorSchema,
    },
    summary: "Handle MiniMax built-in generation webhooks",
  },
});

export const webhookBuiltInGenerationJoggAiContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/built-in-generations/joggai",
    body: c.type<string>(),
    responses: {
      200: thirdPartyWebhookOkSchema,
      400: thirdPartyWebhookErrorSchema,
      401: thirdPartyWebhookErrorSchema,
      503: thirdPartyWebhookErrorSchema,
    },
    summary: "Handle registered JoggAI built-in generation webhooks",
  },
});

const currentSandboxReuseMissSchema = z.enum([
  "noReuseKey",
  "poolMiss",
  "profileMismatch",
  "deviceLimitMismatch",
  "unparkFailed",
]);

export const ACTIVE_INPUT_DELIVERY_RECEIPT_MAX_IDS = 1024;

const activeInputDeliveryIdsSchema = z
  .array(
    z
      .string()
      .uuid()
      .refine((id) => {
        return id === id.toLowerCase();
      }, "active input delivery IDs must use canonical lowercase UUIDs"),
  )
  .max(ACTIVE_INPUT_DELIVERY_RECEIPT_MAX_IDS)
  .superRefine((ids, context) => {
    const seen = new Set<string>();
    ids.forEach((id, index) => {
      if (seen.has(id)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "active input delivery IDs must be unique",
        });
      }
      seen.add(id);
    });
  });

/**
 * Artifact snapshots schema — canonical
 * `Array<{name, version, mountPath, missingRootPolicy?}>` form. Legacy
 * `Record<name, version>` support was removed in #10913 after the DB
 * migration and guest-agent writer flip completed.
 */
const artifactSnapshotsSchema = z.array(
  z.object({
    name: z.string(),
    version: z.string(),
    mountPath: z.string(),
    missingRootPolicy: artifactMissingRootPolicySchema.optional(),
  }),
);

/**
 * Volume versions snapshot schema
 */
const volumeVersionsSnapshotSchema = z.object({
  versions: z.record(z.string(), z.string()),
});

const checkpointMetadataShape = {
  cliAgentType: z.string().min(1, "cliAgentType is required"),
  cliAgentSessionId: z.string().min(1, "cliAgentSessionId is required"),
  cliAgentSessionHistoryHash: sha256HexSchema.optional(),
  cliAgentSessionHistoryDisposition: z
    .enum(["discarded_oversized", "unavailable"])
    .optional(),
  // Multi-artifact snapshots are folded into canonical checkpoint mounts
  // and projected back into the legacy response shape.
  artifactSnapshots: artifactSnapshotsSchema.optional(),
  volumeVersionsSnapshot: volumeVersionsSnapshotSchema.optional(),
} as const;

function requireCheckpointHistory(
  body: {
    readonly cliAgentSessionHistoryHash?: string;
    readonly cliAgentSessionHistoryDisposition?: string;
  },
  context: z.RefinementCtx,
): void {
  const hasHash = body.cliAgentSessionHistoryHash !== undefined;
  const hasDisposition = body.cliAgentSessionHistoryDisposition !== undefined;
  if (hasHash === hasDisposition) {
    context.addIssue({
      code: "custom",
      path: ["cliAgentSessionHistoryHash"],
      message: "Exactly one session history hash or disposition is required",
    });
  }
}

const webhookCheckpointMetadataSchema = z
  .object(checkpointMetadataShape)
  .strict()
  .superRefine(requireCheckpointHistory);

const webhookCheckpointCreateBodySchema = z
  .object({
    runId: z.string().min(1, "runId is required"),
    ...checkpointMetadataShape,
  })
  .strict()
  .superRefine(requireCheckpointHistory);

const webhookCompleteBodySchema = z
  .object({
    runId: z.string().min(1, "runId is required"),
    exitCode: z.number(),
    error: z.string().optional(),
    failureReason: runFailureReasonTokenSchema.optional(),
    lastEventSequence: eventSequenceNumberSchema.optional(),
    // Sandbox id the run executed against. Optional because a run that fails
    // before sandbox creation has no sandbox. Persisted to agent_runs.sandbox_id;
    // the 255-char cap matches the DB column (defense in depth).
    sandboxId: z.string().max(255).optional(),
    sandboxReuseResult: sandboxReuseResultSchema.optional(),
    workspaceReuseResult: workspaceReuseResultSchema.optional(),
    activeInputDeliveryIds: activeInputDeliveryIdsSchema.optional(),
    checkpoint: webhookCheckpointMetadataSchema.optional(),
  })
  .superRefine((body, context) => {
    const workspaceResult = body.workspaceReuseResult;
    if (workspaceResult === undefined) {
      return;
    }
    const sandboxResult = body.sandboxReuseResult;
    const coherentSandboxReuse =
      sandboxResult === "reused" && workspaceResult === "sandboxReused";
    const coherentSandboxMiss =
      sandboxResult !== undefined &&
      currentSandboxReuseMissSchema.safeParse(sandboxResult).success &&
      workspaceResult !== "sandboxReused";
    if (!coherentSandboxReuse && !coherentSandboxMiss) {
      context.addIssue({
        code: "custom",
        path: ["workspaceReuseResult"],
        message: "workspace reuse result does not match sandbox reuse result",
      });
    }
  });

/**
 * Agent event schema for webhook events
 * Note: Claude Code JSONL events have varying structures with different fields
 * depending on the event type (system, assistant, user, result, etc.)
 * We require `type` and `sequenceNumber`, and allow any other fields to pass through
 */
const agentEventSchema = z
  .object({
    type: z.string(),
    sequenceNumber: eventSequenceNumberSchema,
  })
  .passthrough();

const piMemoryCitationTransportSchema = z
  .object({
    schemaVersion: z.literal(1),
    citations: z
      .array(
        z
          .object({
            sequenceNumber: eventSequenceNumberSchema,
            citation: piMemoryCitationSchema,
          })
          .strict(),
      )
      .max(32),
  })
  .strict()
  .superRefine((transport, context) => {
    const sequences = transport.citations.map((citation) => {
      return citation.sequenceNumber;
    });
    if (new Set(sequences).size !== sequences.length) {
      context.addIssue({
        code: "custom",
        path: ["citations"],
        message: "memory citation sequences must be unique",
      });
    }
  });

const webhookSessionOutputBodySchema = z
  .object({
    runId: z.uuid(),
    threadId: z.uuid(),
    runEventId: z.string().min(1).max(512),
    chunkIndex: z.number().int().nonnegative().max(4_294_967_295),
    delta: z.string().min(1).max(4096),
  })
  .strict();

const webhookEventsBodySchema = z
  .object({
    runId: z.string().min(1, "runId is required"),
    events: z.array(agentEventSchema).min(1, "events array cannot be empty"),
    piMemoryCitationTransport: piMemoryCitationTransportSchema.optional(),
  })
  .superRefine((body, context) => {
    if (!body.piMemoryCitationTransport) {
      return;
    }
    const eventSequences = new Set(
      body.events.map((event) => {
        return event.sequenceNumber;
      }),
    );
    for (const [
      index,
      citation,
    ] of body.piMemoryCitationTransport.citations.entries()) {
      if (!eventSequences.has(citation.sequenceNumber)) {
        context.addIssue({
          code: "custom",
          path: [
            "piMemoryCitationTransport",
            "citations",
            index,
            "sequenceNumber",
          ],
          message: "memory citation sequence must belong to this event batch",
        });
      }
    }
  });

const firewallAuthErrorSchema = z.object({
  error: z.object({
    message: z.string(),
    code: z.string(),
    connectors: z.array(z.string()).optional(),
    failureReason: z
      .enum(["upstream_provider", "reconnect_required"])
      .optional(),
  }),
});

const firewallAwsSigv4AuthSchema = z
  .object({
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
    sessionToken: z.string().min(1).optional(),
  })
  .strict();

const firewallAuthResponseSchema = z.object({
  headers: z.record(z.string(), z.string()),
  base: z.string().optional(),
  query: z.record(z.string(), z.string()).optional(),
  awsSigv4: firewallAwsSigv4AuthSchema.optional(),
  // Effective addon cache expiry as Unix seconds. Access token expiry is the
  // normal source; billable firewall auth can shorten it to force credit
  // re-authorization. Null means non-expiring only for non-billable auth.
  expiresAt: z.number().nullable(),
  resolvedSecrets: z.array(z.string()),
  refreshedConnectors: z.array(z.string()),
  refreshedSecrets: z.array(z.string()),
});

const matchedFirewallAuthContextSchema = z
  .object({
    name: z.string().min(1),
    apiId: z.string().min(1),
    connectorSlug: connectorSlugSchema.optional(),
    customConnectorId: z.uuid().optional(),
    sourceId: z.uuid().optional(),
    routingVariables: z.record(z.string(), z.string()),
  })
  .refine(
    (context) => {
      return (
        Number(context.connectorSlug !== undefined) +
          Number(context.customConnectorId !== undefined) ===
        1
      );
    },
    { message: "Matched firewall must identify exactly one connector" },
  );

export const webhookFirewallAuthContract = c.router({
  /**
   * POST /api/webhooks/agent/firewall/auth
   * Resolve firewall auth templates and refresh access tokens on demand.
   */
  resolve: {
    method: "POST",
    path: "/api/webhooks/agent/firewall/auth",
    headers: authHeadersSchema,
    body: z.object({
      // Encrypted runtime secret namespace. After decryption, keys are the
      // `NAME` in `${{ secrets.NAME }}`.
      encryptedSecrets: z.string().min(1),
      authHeaders: z.record(z.string(), z.string()),
      authBase: z.string().optional(),
      authQuery: z.record(z.string(), z.string()).optional(),
      authAwsSigv4: firewallAwsSigv4AuthSchema.optional(),
      // Maps firewall auth secret env aliases (the `NAME` in `${{ secrets.NAME }}`)
      // to the connector or provider owner that can refresh/resolve access.
      secretConnectorMap: z.record(z.string(), z.string()).optional(),
      // Same keys as secretConnectorMap; adds source details when the owner
      // alone is not enough to locate access storage.
      secretConnectorMetadataMap: secretConnectorMetadataMapSchema.optional(),
      vars: z.record(z.string(), z.string()).optional(),
      // Stable matched-firewall identity plus exact routing inputs.
      // Inline and model-provider firewalls do not identify a connector.
      matchedFirewall: matchedFirewallAuthContextSchema.optional(),
      // Set by mitm from billableFirewalls. Server uses this only to bound
      // auth cache lifetime by the current credit authorization lease.
      firewallBillable: z.boolean().optional(),
      forceRefresh: z.boolean().optional(),
    }),
    responses: {
      200: firewallAuthResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      424: firewallAuthErrorSchema,
      502: firewallAuthErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Resolve firewall auth templates",
  },
});

/**
 * Best-effort Sandbox session output contract.
 *
 * The sandbox token, rather than body fields, supplies the user and
 * organization that own the realtime channel. The thread ID is only a client
 * display hint inside that run-scoped channel. This path never enters durable
 * event ingestion.
 */
export const webhookSessionOutputContract = c.router({
  send: {
    method: "POST",
    path: "/api/webhooks/agent/session-output",
    headers: authHeadersSchema,
    body: webhookSessionOutputBodySchema,
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Publish transient session output from sandbox",
  },
});

/**
 * Webhook events contract for /api/webhooks/agent/events
 */
export const webhookEventsContract = c.router({
  /**
   * POST /api/webhooks/agent/events
   * Receive agent events from sandbox
   */
  send: {
    method: "POST",
    path: "/api/webhooks/agent/events",
    headers: authHeadersSchema,
    body: webhookEventsBodySchema,
    responses: {
      200: z.object({
        received: z.number(),
        firstSequence: z.number(),
        lastSequence: z.number(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Receive agent events from sandbox",
  },
});

/**
 * Webhook complete contract for /api/webhooks/agent/complete
 */
export const webhookCompleteContract = c.router({
  /**
   * POST /api/webhooks/agent/complete
   * Handle agent run completion (success or failure)
   */
  complete: {
    method: "POST",
    path: "/api/webhooks/agent/complete",
    headers: authHeadersSchema,
    body: webhookCompleteBodySchema,
    responses: {
      200: z.object({
        success: z.boolean(),
        status: z.enum(["completed", "failed"]),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Handle agent run completion",
  },
});

/**
 * Webhook checkpoints contract for /api/webhooks/agent/checkpoints
 */
export const webhookCheckpointsContract = c.router({
  /**
   * POST /api/webhooks/agent/checkpoints
   * Create a recoverable checkpoint for an agent run.
   */
  create: {
    method: "POST",
    path: "/api/webhooks/agent/checkpoints",
    headers: authHeadersSchema,
    body: webhookCheckpointCreateBodySchema,
    responses: {
      200: z.object({
        checkpointId: z.string(),
        agentSessionId: z.string(),
        conversationId: z.string(),
        artifacts: artifactSnapshotsSchema.optional(),
        volumes: z.record(z.string(), z.string()).optional(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create checkpoint for agent run",
  },
});

/**
 * Webhook checkpoint prepare-history contract for /api/webhooks/agent/checkpoints/prepare-history
 * Returns a presigned URL for uploading session history directly to S3,
 * bypassing Vercel's 4.5MB body size limit.
 */
export const webhookCheckpointsPrepareHistoryContract = c.router({
  prepare: {
    method: "POST",
    path: "/api/webhooks/agent/checkpoints/prepare-history",
    headers: authHeadersSchema,
    body: z.object({
      runId: z.string().min(1, "runId is required"),
      hash: sha256HexSchema,
      rawSize: z
        .number()
        .int()
        .positive("rawSize must be a positive integer")
        .max(RESUME_SESSION_HISTORY_MAX_BYTES),
      encodedSize: z
        .number()
        .int()
        .positive("encodedSize must be a positive integer")
        .max(RESUME_SESSION_HISTORY_MAX_BYTES),
      encoding: sessionHistoryEncodingSchema.optional(),
    }),
    responses: {
      200: z.object({
        presignedUrl: z.string().optional(),
        existing: z.boolean(),
        encoding: sessionHistoryEncodingSchema.optional(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get presigned URL for uploading session history to S3",
  },
});

/**
 * Webhook heartbeat contract for /api/webhooks/agent/heartbeat
 */
export const webhookHeartbeatContract = c.router({
  /**
   * POST /api/webhooks/agent/heartbeat
   * Receive heartbeat signals from sandbox
   */
  send: {
    method: "POST",
    path: "/api/webhooks/agent/heartbeat",
    headers: authHeadersSchema,
    body: z.object({
      runId: z.string().min(1, "runId is required"),
    }),
    responses: {
      200: z.object({
        ok: z.boolean(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Receive heartbeat from sandbox",
  },
});

/**
 * Metric data point schema
 */
const metricDataSchema = z.object({
  // A periodic memory snapshot rides along with ordinary metrics. Rejecting it
  // must never discard the system logs, metrics, network logs, and sandbox
  // operations batched in the same request; the dedicated `oomEvidence` field
  // below stays strict because it decides the delivery acknowledgement.
  memory: oomEvidenceSchema.optional().catch(undefined),
  ts: z.string(),
  cpu: z.number(),
  cpu_steal_percent: z.number().optional(),
  scheduled_lag_ms: z.number().optional(),
  mem_used: z.number(),
  mem_total: z.number(),
  disk_used: z.number(),
  disk_total: z.number(),
  control_cpu_usage_usec: z.number().optional(),
  control_cpu_nr_throttled: z.number().optional(),
  control_cpu_throttled_usec: z.number().optional(),
  workload_cpu_usage_usec: z.number().optional(),
  workload_cpu_nr_throttled: z.number().optional(),
  workload_cpu_throttled_usec: z.number().optional(),
});

const sessionHistoryCompressionRatioBucketSchema = z.enum([
  "identity",
  "lt_0_25",
  "0_25_0_5",
  "0_5_0_75",
  "0_75_1",
  "ge_1",
]);

const sessionHistoryPayloadBytesSchema = z
  .number()
  .int()
  .nonnegative()
  .max(RESUME_SESSION_HISTORY_MAX_BYTES);

const sessionHistoryRestoreRepresentationSchema = z.enum(["raw", "codex_zstd"]);

const booleanStringSchema = z.enum(["true", "false"]);

const sessionHistoryContentLengthStateSchema = z.enum([
  "absent",
  "matches_expected",
  "mismatches_expected",
  "present_without_expected",
  "oversized",
]);

const sessionHistoryContentEncodingStateSchema = z.enum([
  "absent",
  "gzip",
  "zstd",
  "other",
]);

const sessionHistoryTransferEncodingStateSchema = z.enum([
  "absent",
  "chunked",
  "other",
]);

const sandboxOperationDownloadSourceSchema = z
  .preprocess((value) => {
    const parsed = sessionHistoryDownloadSourceSchema.safeParse(value);
    if (parsed.success) {
      return parsed.data;
    }
    if (typeof value === "string") {
      return undefined;
    }
    return value;
  }, sessionHistoryDownloadSourceSchema.optional())
  .optional();

export const runnerStartupPathSchema = z.enum(["sandbox", "workspace", "cold"]);

export type RunnerStartupPath = z.infer<typeof runnerStartupPathSchema>;

const runnerPreSpawnConcurrencyBucketSchema = z.enum([
  "1",
  "2",
  "3_4",
  "5_8",
  "9_plus",
]);

export type RunnerPreSpawnConcurrencyBucket = z.infer<
  typeof runnerPreSpawnConcurrencyBucketSchema
>;

const runnerResourceBudgetUtilizationBucketSchema = z.enum([
  "0_25",
  "26_50",
  "51_75",
  "76_100",
  "over_100",
]);

export type RunnerResourceBudgetUtilizationBucket = z.infer<
  typeof runnerResourceBudgetUtilizationBucketSchema
>;

const runnerResourceBudgetLeaseCountBucketSchema = z.enum([
  "0",
  "1",
  "2",
  "3_4",
  "5_8",
  "9_plus",
]);

export type RunnerResourceBudgetLeaseCountBucket = z.infer<
  typeof runnerResourceBudgetLeaseCountBucketSchema
>;

// Decimal text preserves a declared u64 response length beyond JS safe integers.
const archiveSizeBytesSchema = z
  .string()
  .max(20)
  .regex(/^(0|[1-9][0-9]*)$/u);

const archiveSizeMismatchSchema = z.object({
  expected_bytes: archiveSizeBytesSchema,
  response_bytes: archiveSizeBytesSchema,
  source_kind: z.enum(["storage", "artifact"]),
  source_index: z.number().int().nonnegative(),
  content_encoding: z.enum(["absent", "identity", "gzip", "other"]),
});

export type ArchiveSizeMismatch = z.infer<typeof archiveSizeMismatchSchema>;

/**
 * Sandbox operation schema for internal sandbox operations (init, storage, cli, checkpoint, cleanup)
 */
const sandboxOperationSchema = z.object({
  ts: z.string(),
  action_type: z.string(),
  duration_ms: z.number(),
  success: z.boolean(),
  error: z.string().optional(),
  outcome: z.string().max(64).optional(),
  reason: z.string().max(64).optional(),
  archive_size_mismatch: archiveSizeMismatchSchema.optional(),
  dns_readiness_attempt: z.number().int().min(1).max(3).optional(),
  dns_readiness_final_attempt: z.boolean().optional(),
  dns_readiness_guest_duration_ms: z
    .number()
    .int()
    .min(0)
    .max(4_294_967_295)
    .optional(),
  dns_readiness_host_residual_ms: z.number().int().nonnegative().optional(),
  dns_readiness_timing: z
    .enum(["paired", "unavailable", "inconsistent"])
    .optional(),
  runner_startup_path: runnerStartupPathSchema.optional(),
  sandbox_reuse_result: sandboxReuseResultSchema.optional(),
  runner_pre_spawn_concurrency_bucket:
    runnerPreSpawnConcurrencyBucketSchema.optional(),
  runner_resource_budget_vcpu_utilization_bucket:
    runnerResourceBudgetUtilizationBucketSchema.optional(),
  runner_resource_budget_memory_utilization_bucket:
    runnerResourceBudgetUtilizationBucketSchema.optional(),
  runner_resource_budget_lease_count_bucket:
    runnerResourceBudgetLeaseCountBucketSchema.optional(),
  encoding: sessionHistoryEncodingSchema.optional(),
  session_history_raw_size_bucket: sessionHistorySizeBucketSchema.optional(),
  session_history_encoded_size_bucket:
    sessionHistorySizeBucketSchema.optional(),
  session_history_compression_ratio_bucket:
    sessionHistoryCompressionRatioBucketSchema.optional(),
  session_history_ref_seen_recently: booleanStringSchema.optional(),
  session_history_ref_download_inflight: booleanStringSchema.optional(),
  session_history_content_length_state:
    sessionHistoryContentLengthStateSchema.optional(),
  session_history_content_encoding_state:
    sessionHistoryContentEncodingStateSchema.optional(),
  session_history_transfer_encoding_state:
    sessionHistoryTransferEncodingStateSchema.optional(),
  session_history_download_source: sandboxOperationDownloadSourceSchema,
  session_history_framework: z.enum(["claude-code", "codex", "pi"]).optional(),
  session_history_raw_bytes: sessionHistoryPayloadBytesSchema.optional(),
  session_history_source_bytes: sessionHistoryPayloadBytesSchema.optional(),
  // Successful history payload bytes; omitted when a local restore fails.
  session_history_guest_bytes: sessionHistoryPayloadBytesSchema.optional(),
  session_history_source_representation:
    sessionHistoryRestoreRepresentationSchema.optional(),
  session_history_restore_representation:
    sessionHistoryRestoreRepresentationSchema.optional(),
  session_history_restore_reason: z
    .enum(["raw_source", "retained_zstd", "codex_pruning_guard"])
    .optional(),
  session_history_transfer_source: z
    .enum(["workspace_cache", "downloaded", "inline"])
    .optional(),
  session_history_wire_codec: z.enum(["none", "zstd"]).optional(),
  session_history_codec_decision: z
    .enum(["native_zstd", "below_threshold", "above_threshold"])
    .optional(),
  // Draining Runners retain the previous sampling policy and reason field.
  session_history_codec_reason: z
    .enum([
      "native_zstd",
      "below_threshold",
      "sample_rejected",
      "sample_accepted",
    ])
    .optional(),
  // These also describe inline history, whose existing contract has no
  // reference-size ceiling. Keep safe integer measurements without imposing
  // the local/ref 128 MiB limit on that separate restore path.
  session_history_transfer_bytes: z.number().int().nonnegative().optional(),
  session_history_wire_bytes: z.number().int().nonnegative().optional(),
  session_history_write_requests: z.number().int().positive().optional(),
  session_history_selection_ms: z.number().int().nonnegative().optional(),
  session_history_file_gate_wait_ms: z.number().int().nonnegative().optional(),
  session_history_requests_ms: z.number().int().nonnegative().optional(),
  session_history_encoder_pipeline_ms: z
    .number()
    .int()
    .nonnegative()
    .optional(),
  session_history_publication_ms: z.number().int().nonnegative().optional(),
});

/**
 * Webhook telemetry contract for /api/webhooks/agent/telemetry
 */
export const webhookTelemetryContract = c.router({
  /**
   * POST /api/webhooks/agent/telemetry
   * Receive telemetry data (system log, metrics, network logs, and sandbox operations) from sandbox
   */
  send: {
    method: "POST",
    path: "/api/webhooks/agent/telemetry",
    headers: authHeadersSchema,
    body: z.object({
      runId: z.string().min(1, "runId is required"),
      runnerHostname: runnerHostnameSchema.optional(),
      runnerVersion: runnerVersionSchema.optional(),
      systemLog: z.string().optional(),
      oomEvidence: oomEvidenceSchema.optional(),
      sandboxId: z.uuid().optional(),
      metrics: z.array(metricDataSchema).optional(),
      networkLogs: z.array(networkLogEntrySchema).optional(),
      sandboxOperations: z.array(sandboxOperationSchema).optional(),
    }),
    responses: {
      200: z.object({
        success: z.boolean(),
        id: z.string(),
        oomEvidenceVersion: z.literal(1).optional(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Receive telemetry data from sandbox",
  },
});

// ============================================================================
// Direct Upload Contracts (Webhook endpoints for sandbox)
// ============================================================================

/**
 * Webhook storage prepare contract for /api/webhooks/agent/storages/prepare
 *
 * Sandbox version of storage prepare endpoint.
 * Uses JWT sandbox token authentication and verifies runId matches token.
 */
export const webhookStoragesPrepareContract = c.router({
  prepare: {
    method: "POST",
    path: "/api/webhooks/agent/storages/prepare",
    headers: authHeadersSchema,
    body: z.object({
      runId: z.string().min(1, "runId is required"), // Required for webhook auth
      /**
       * Canonical Storage identity authorized against the run's writeback
       * mounts.
       */
      storageId: z.string().uuid(),
      files: storageManifestFilesSchema,
      parentVersionId: z.string().optional(),
      force: z.boolean().optional(),
      baseVersion: z.string().optional(),
      changes: storageChangesSchema.optional(),
      /** Private proof emitted only after sandbox-local Phase 2 validation. */
      maintenanceAttestation:
        piMemoryPhase2CheckpointAttestationSchema.optional(),
    }),
    responses: {
      200: z.object({
        versionId: z.string(),
        existing: z.boolean(),
        uploads: z
          .object({
            archive: presignedUploadSchema,
            manifest: presignedUploadSchema,
          })
          .optional(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      413: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Prepare for direct S3 upload from sandbox",
  },
});

/**
 * Webhook storage commit contract for /api/webhooks/agent/storages/commit
 *
 * Sandbox version of storage commit endpoint.
 * Uses JWT sandbox token authentication and verifies runId matches token.
 */
export const webhookStoragesCommitContract = c.router({
  commit: {
    method: "POST",
    path: "/api/webhooks/agent/storages/commit",
    headers: authHeadersSchema,
    body: z.object({
      runId: z.string().min(1, "runId is required"), // Required for webhook auth
      /**
       * Canonical Storage identity authorized against the run's writeback
       * mounts.
       */
      storageId: z.string().uuid(),
      versionId: z.string().min(1, "Version ID is required"),
      parentVersionId: z.string().optional(),
      files: storageManifestFilesSchema,
      message: z.string().optional(),
      /** Private proof emitted only after sandbox-local Phase 2 validation. */
      maintenanceAttestation:
        piMemoryPhase2CheckpointAttestationSchema.optional(),
    }),
    responses: {
      200: z.object({
        success: z.literal(true),
        versionId: z.string(),
        storageName: z.string(),
        size: z.number(),
        fileCount: z.number(),
        deduplicated: z.boolean().optional(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema, // S3 files missing
      413: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Commit uploaded storage from sandbox",
  },
});

export type WebhookEventsContract = typeof webhookEventsContract;
export type WebhookClerkContract = typeof webhookClerkContract;
export type WebhookGithubContract = typeof webhookGithubContract;
export type WebhookGmailContract = typeof webhookGmailContract;
export type WebhookGoogleFormsContract = typeof webhookGoogleFormsContract;
export type WebhookGoogleCalendarContract =
  typeof webhookGoogleCalendarContract;
export type WebhookGoogleWorkspaceEventsContract =
  typeof webhookGoogleWorkspaceEventsContract;
export type WebhookStripeContract = typeof webhookStripeContract;
export type WebhookStripeAutomationEventsContract =
  typeof webhookStripeAutomationEventsContract;
export type WebhookWorkflowAutomationContract =
  typeof webhookWorkflowAutomationContract;
export type WebhookBuiltInGenerationFalContract =
  typeof webhookBuiltInGenerationFalContract;
export type WebhookBuiltInGenerationBytePlusContract =
  typeof webhookBuiltInGenerationBytePlusContract;
export type WebhookBuiltInGenerationMiniMaxContract =
  typeof webhookBuiltInGenerationMiniMaxContract;
export type WebhookBuiltInGenerationJoggAiContract =
  typeof webhookBuiltInGenerationJoggAiContract;
export type WebhookFirewallAuthContract = typeof webhookFirewallAuthContract;
export type WebhookCompleteContract = typeof webhookCompleteContract;
export type WebhookCheckpointsContract = typeof webhookCheckpointsContract;
export type WebhookCheckpointsPrepareHistoryContract =
  typeof webhookCheckpointsPrepareHistoryContract;
export type WebhookHeartbeatContract = typeof webhookHeartbeatContract;
export type WebhookTelemetryContract = typeof webhookTelemetryContract;
export type WebhookStoragesPrepareContract =
  typeof webhookStoragesPrepareContract;
export type WebhookStoragesCommitContract =
  typeof webhookStoragesCommitContract;

/**
 * Webhook usage event contract for /api/webhooks/agent/usage-event
 *
 * Receives billing usage records from the sandbox for persistence in the
 * `usage_event` ledger. Reporters send `{ runId, events }` batches, and the
 * API prices their quantities from the server-side pricing table.
 */
const webhookUsageEventItemSchema = z
  .object({
    idempotencyKey: z.uuid(),
    kind: z.enum(["connector", "model", "image"]),
    provider: z.string().min(1).max(100),
    category: z.string().min(1).max(100),
    quantity: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const webhookUsageEventContract = c.router({
  send: {
    method: "POST",
    path: "/api/webhooks/agent/usage-event",
    headers: authHeadersSchema,
    body: z
      .object({
        runId: z.string().min(1, "runId is required"),
        events: z
          .array(
            z.union([webhookUsageEventItemSchema, xResourceUsageEventSchema]),
          )
          .min(1)
          .max(100),
      })
      .strict()
      .superRefine((body, ctx) => {
        let resourceCount = 0;
        let hasResourceObservation = false;
        for (const event of body.events) {
          if ("protocol" in event) {
            hasResourceObservation = true;
            resourceCount += event.resources.length;
          }
        }
        if (resourceCount > X_RESOURCE_USAGE_MAX_IDS) {
          ctx.addIssue({
            code: "custom",
            path: ["events"],
            message: "At most 1000 resource identities are allowed per batch",
          });
        }
        if (hasResourceObservation && !z.uuid().safeParse(body.runId).success) {
          ctx.addIssue({
            code: "custom",
            path: ["runId"],
            message: "Resource observations require a UUID run ID",
          });
        }
      }),
    responses: {
      200: z.object({
        success: z.boolean(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      413: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Receive billing usage event data from sandbox",
  },
});

export type WebhookUsageEventContract = typeof webhookUsageEventContract;
