import { claimedContentBundlesSchema } from "./content-bundle";
import {
  array,
  boolean,
  coerce,
  discriminatedUnion,
  literal,
  number,
  object,
  record,
  string,
  union,
  url,
  uuid,
  enum as zEnum,
  ZodIssueCode,
  unknown as zUnknown,
  type RefinementCtx,
  type infer as zInfer,
} from "zod";

import {
  workflowDownloadSchema,
  workflowSkillReferenceSchema,
} from "./workflow-attachments";

import {
  executionFirewallInlineEntrySchema,
  executionFirewallsSchema,
  firewallApiSchema,
  firewallSchema,
  networkPoliciesSchema,
  networkPolicySchema,
} from "@okouai/connectors/firewall-contracts";
import { authHeadersSchema, initContract } from "./base";
import { connectorSlugSchema } from "./connector-identity";
import { apiErrorSchema } from "./errors";
import { modelProviderCodexRuntimeConfigSchema } from "./model-providers";
import {
  CANONICAL_GUEST_HOME_DIR,
  CANONICAL_WORKING_DIR,
  runnerGroupSchema,
  runnerHeartbeatGenerationSchema,
  runnerHostnameSchema,
} from "./runner-primitives";

export { BUILTIN_FIREWALL_CATALOG_MAX_BYTES } from "@okouai/connectors/connector-catalog/contracts";

export {
  CANONICAL_GUEST_HOME_DIR,
  CANONICAL_WORKING_DIR,
  homeReuseResultSchema,
  OFFICIAL_RUNNER_TOKEN_PREFIX,
  RUNNER_HOSTNAME_MAX_LENGTH,
  RUNNER_VERSION_MAX_LENGTH,
  runnerGroupSchema,
  runnerHeartbeatGenerationSchema,
  runnerHostnameSchema,
  runnerVersionSchema,
  sandboxReuseResultSchema,
  sandboxStartupPathSchema,
  type HomeReuseResult,
  type SandboxReuseResult,
  type SandboxStartupPath,
} from "./runner-primitives";

const c = initContract();

export const MIN_EPOCH_MS_TIMESTAMP = 1_000_000_000_000;
const apiStartTimeSchema = number().int().min(MIN_EPOCH_MS_TIMESTAMP);

export const CANONICAL_CLAUDE_CONFIG_DIR = `${CANONICAL_GUEST_HOME_DIR}/.claude`;
export const CANONICAL_CODEX_HOME_DIR = `${CANONICAL_GUEST_HOME_DIR}/.codex`;
export const CANONICAL_CODEX_SESSIONS_DIR = `${CANONICAL_CODEX_HOME_DIR}/sessions`;
const CANONICAL_CLAUDE_PROJECT_NAME = CANONICAL_WORKING_DIR.replace(
  /^\//,
  "",
).replace(/\//g, "-");
export const CANONICAL_CLAUDE_MEMORY_MOUNT_PATH = `${CANONICAL_CLAUDE_CONFIG_DIR}/projects/-${CANONICAL_CLAUDE_PROJECT_NAME}/memory`;
export const CANONICAL_CODEX_MEMORY_MOUNT_PATH = `${CANONICAL_CODEX_HOME_DIR}/memories`;
export const PI_AGENT_DIR = `${CANONICAL_GUEST_HOME_DIR}/.pi/agent`;
export const CANONICAL_PI_MEMORY_MOUNT_PATH = `${PI_AGENT_DIR}/memory`;
export const CANONICAL_PI_SESSION_DIR = `${PI_AGENT_DIR}/sessions/--home-user-workspace--`;
// Shared resume history size contract. Rust consumers import the generated
// binding from `api_contracts::generated::constants`.
export const RESUME_SESSION_HISTORY_MAX_BYTES = 128 * 1024 * 1024;
export const ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES = 1024 * 1024;
// Shared by the runner's enforced deadline and the agent-facing system prompt
// so the documented execution budget cannot drift from runtime behavior.
export const AGENT_EXECUTION_TIMEOUT_SECONDS = 2 * 60 * 60;
// Keep telemetry's nested deadlines in one source for the API and generated
// Rust consumers. HTTP includes API/transport headroom beyond downstream ingest.
export const AGENT_TELEMETRY_INGEST_TIMEOUT_MS = 10_000;
export const AGENT_TELEMETRY_HTTP_TIMEOUT_MS =
  AGENT_TELEMETRY_INGEST_TIMEOUT_MS + 5_000;
// Emergency evidence is persisted locally and independently recovered by the
// host, so its best-effort delivery keeps a shorter per-attempt allowance.
export const AGENT_TELEMETRY_INCIDENT_ATTEMPTS = 2;
export const AGENT_TELEMETRY_INCIDENT_TIMEOUT_MS = 2_000;
// Final shutdown may await an in-flight periodic request before its final pass.
// The aggregate cap also includes incident delivery and local position writes.
export const AGENT_FINAL_TELEMETRY_FLUSH_TIMEOUT_MS =
  2 *
    (AGENT_TELEMETRY_HTTP_TIMEOUT_MS +
      AGENT_TELEMETRY_INCIDENT_ATTEMPTS * AGENT_TELEMETRY_INCIDENT_TIMEOUT_MS) +
  1_000;
// Terminal cleanup is shared with Guest exec; keep each phase in the sum so
// predecessor waiting follows the same allowance as the actual cleanup path.
export const GUEST_EXEC_PROCESS_CONTAINMENT_TERM_GRACE_MS = 500;
export const GUEST_EXEC_PROCESS_CONTAINMENT_KILL_EMPTY_TIMEOUT_MS = 1_000;
export const GUEST_EXEC_PROCESS_CONTAINMENT_REMOVE_TIMEOUT_MS = 250;
export const GUEST_EXEC_OUTPUT_DRAIN_DEADLINE_MS = 5_000;
export const GUEST_EXEC_TERMINAL_CLEANUP_BUDGET_MS =
  GUEST_EXEC_PROCESS_CONTAINMENT_TERM_GRACE_MS +
  GUEST_EXEC_PROCESS_CONTAINMENT_KILL_EMPTY_TIMEOUT_MS +
  GUEST_EXEC_PROCESS_CONTAINMENT_REMOVE_TIMEOUT_MS +
  GUEST_EXEC_OUTPUT_DRAIN_DEADLINE_MS;
export const RUNNER_JOB_TERMINAL_HOST_SLACK_MS = 3_250;
export const RUNNER_JOB_TERMINAL_GRACE_MS =
  GUEST_EXEC_TERMINAL_CLEANUP_BUDGET_MS + RUNNER_JOB_TERMINAL_HOST_SLACK_MS;
// A completed exact producer can retain its home until Guest exit is observed.
// This dedicated window does not extend ordinary home/idle routing preference.
export const RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS =
  AGENT_FINAL_TELEMETRY_FLUSH_TIMEOUT_MS + RUNNER_JOB_TERMINAL_GRACE_MS;
// Separate stage: acceptance after both host finalization and successor waiting
// have begun. Accepted handoff readiness is not limited by this grace.
export const RUNNER_FINALIZING_HANDOFF_ACCEPTANCE_GRACE_MS = 1_500;
export const SESSION_HISTORY_ENCODING_IDENTITY = "identity";
export const SESSION_HISTORY_ENCODING_GZIP = "gzip";
export const SESSION_HISTORY_ENCODING_ZSTD = "zstd";
export const CONNECTOR_RUNTIME_SYNC_TARGETS_MAX = 256;
export const CONNECTOR_RUNTIME_SYNC_RUN_TERMINAL_ERROR_CODE = "RUN_TERMINAL";
export const RUNNER_CANCELLATION_RECOVERY_GRACE_MS = 90_000;
export const CANCELLATION_RECOVERY_STALE_AFTER_MS =
  RUNNER_CANCELLATION_RECOVERY_GRACE_MS + 30_000;
export const BUILTIN_FIREWALL_CATALOG_CACHE_SCHEMA_VERSION = 1;
export const RUNNER_BUILTIN_FIREWALL_RESOLVE_NAMES_MAX = 512;
// Existing versioned writers stay on generation 2 until their activation slice.
export const PI_MODEL_CONFIG_CURRENT_GENERATION = 2;
export const PI_MODEL_CONFIG_DIALECT_TIER_GENERATION = 3;
// Generation 4 was the retired native carrier; Runners built before its
// removal may still advertise it, so OpenRouter Chat Completions skips to 5.
export const PI_MODEL_CONFIG_CHAT_COMPLETIONS_GENERATION = 5;
export const RUNNER_CLAIM_PI_MODEL_CONFIG_GENERATIONS_MAX = 8;
/** Release versions are exact `MAJOR.MINOR.PATCH`; nothing here is a range. */
export const releaseVersionSchema = string().regex(
  /^\d+\.\d+\.\d+$/,
  "Release versions are MAJOR.MINOR.PATCH",
);
export function elapsedSinceApiStartMs(
  apiStartTimeMs: number | undefined,
  nowMs: number,
): number | undefined {
  if (
    apiStartTimeMs === undefined ||
    !Number.isInteger(apiStartTimeMs) ||
    apiStartTimeMs < MIN_EPOCH_MS_TIMESTAMP
  ) {
    return undefined;
  }

  return Math.max(0, nowMs - apiStartTimeMs);
}

export const runnerClaimPollReasonSchema = zEnum([
  "immediate",
  "deferred",
  "wakeup_retry",
  "slow",
  "fast",
]);

const runnerProcessIdentitySchema = object({
  runnerId: uuid(),
  heartbeatGeneration: runnerHeartbeatGenerationSchema,
}).strict();

export const runnerClaimCapabilitiesSchema = object({
  piModelConfigGenerations: array(number().int().positive().max(255))
    .min(1)
    .max(RUNNER_CLAIM_PI_MODEL_CONFIG_GENERATIONS_MAX)
    .refine((generations) => {
      return new Set(generations).size === generations.length;
    }, "Pi model-config generations must be unique"),
})
  .strict()
  .readonly();

/**
 * Versions of the Okou CLI bundled into a Runner and installed into its rootfs.
 * Advertised on claim for attribution.
 */
export const runnerInstalledVersionsSchema = object({
  cli: releaseVersionSchema,
  piAgentRuntime: releaseVersionSchema,
  piSdk: string().min(1).max(64),
})
  .strict()
  .readonly();

/**
 * Atomic advisory decision for cross-runner reuse coordination. A preferred
 * runner is not an exclusive assignee; another runner with a better compatible
 * local resource remains eligible to claim.
 */
export const runnerPreferenceSchema = union([
  object({
    kind: literal("preference"),
    runnerIdentity: runnerProcessIdentitySchema,
    tier: zEnum(["exactSandbox", "finalizingPredecessor"]),
    expiresAt: string().datetime({ offset: true }),
    predecessorRunId: uuid(),
  }).strict(),
  object({
    kind: literal("preference"),
    runnerIdentity: runnerProcessIdentitySchema,
    tier: literal("predecessorHome"),
    predecessorRunId: uuid(),
    expiresAt: string().datetime({ offset: true }),
    home: discriminatedUnion("evidence", [
      object({ evidence: literal("advertised") }).strict(),
      object({
        evidence: literal("expected"),
        homeWaitUntil: string().datetime({ offset: true }),
      }).strict(),
      object({ evidence: literal("location") }).strict(),
    ]),
  }).strict(),
  object({
    kind: literal("preference"),
    runnerIdentity: runnerProcessIdentitySchema,
    tier: zEnum(["reusableSandbox", "homeCache"]),
    expiresAt: string().datetime({ offset: true }),
  }).strict(),
  object({
    kind: literal("noPreference"),
    reason: zEnum(["noReuseKey", "expired", "noViableHolder", "lookupError"]),
  }).strict(),
]);

export const runnerPreferenceClaimStateSchema = zEnum([
  "active",
  "expired",
  "cleared",
]);

const runnerClaimDiscoverySourceSchema = zEnum(["ably", "poll"]);
const runnerClaimTelemetrySchema = object({
  discoverySource: runnerClaimDiscoverySourceSchema.optional(),
  jobDiscoveredToClaimRequestMs: number().int().nonnegative().optional(),
  localAdmissionToClaimRequestMs: number().int().nonnegative().optional(),
  directCandidateNotificationToEnqueueMs: number()
    .int()
    .nonnegative()
    .optional(),
  directCandidateInboxWaitMs: number().int().nonnegative().optional(),
  providerDiscoveryToMainLoopMs: number().int().nonnegative().optional(),
  mainLoopToLocalAdmissionMs: number().int().nonnegative().optional(),
  pollDueToJobDiscoveredMs: number().int().nonnegative().optional(),
  pollHttpRequestMs: number().int().nonnegative().optional(),
  pollReason: runnerClaimPollReasonSchema.optional(),
  runnerPreference: runnerPreferenceSchema.optional().catch(undefined),
  runnerPreferenceClaimState: runnerPreferenceClaimStateSchema.optional(),
}).catch({});

const runnerPollTelemetrySchema = object({
  pollReason: runnerClaimPollReasonSchema.optional(),
}).catch({});

const runnerProfileListSchema = array(string());
const runnerSupportedProfileListSchema = runnerProfileListSchema.min(1);
export const RUNNER_POLL_EXCLUDED_RUN_IDS_MAX = 128;

const networkPolicyRefreshSchema = object({
  nextRefreshAt: string().datetime({ offset: true }),
});

const networkPolicyRefreshesSchema = record(
  string(),
  networkPolicyRefreshSchema,
);

export const connectorRuntimeBuiltinTargetSchema = object({
  kind: literal("builtin"),
  connectorSlug: connectorSlugSchema,
});

export const connectorRuntimeCustomTargetSchema = object({
  kind: literal("custom"),
  customConnectorId: uuid(),
});

export const connectorRuntimeTargetSchema = discriminatedUnion("kind", [
  connectorRuntimeBuiltinTargetSchema,
  connectorRuntimeCustomTargetSchema,
]);

export const connectorRuntimeCustomTargetRegistrationSchema =
  connectorRuntimeCustomTargetSchema.extend({
    baseUrlVars: record(string(), string()),
    sourceId: uuid().optional(),
  });

export const connectorRuntimeBuiltinTargetRegistrationSchema =
  connectorRuntimeBuiltinTargetSchema.extend({
    baseUrlVars: record(string(), string()).optional(),
    sourceId: uuid().optional(),
  });

export const connectorRuntimeTargetRegistrationSchema = discriminatedUnion(
  "kind",
  [
    connectorRuntimeBuiltinTargetRegistrationSchema,
    connectorRuntimeCustomTargetRegistrationSchema,
  ],
);

export function connectorRuntimeTargetKey(
  target:
    | zInfer<typeof connectorRuntimeTargetSchema>
    | zInfer<typeof connectorRuntimeTargetRegistrationSchema>,
): string {
  return target.kind === "builtin"
    ? `builtin:${target.connectorSlug}`
    : `custom:${target.customConnectorId}`;
}

function uniqueConnectorRuntimeTargets(
  targets: readonly zInfer<typeof connectorRuntimeTargetRegistrationSchema>[],
  context: RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, target] of targets.entries()) {
    const key = connectorRuntimeTargetKey(target);
    if (seen.has(key)) {
      context.addIssue({
        code: "custom",
        path: [index],
        message: "Connector runtime targets must be unique",
      });
      continue;
    }
    seen.add(key);
  }
}

export const connectorRuntimeTargetsSchema = array(
  connectorRuntimeTargetRegistrationSchema,
).superRefine(uniqueConnectorRuntimeTargets);

export const agentRunConnectorDiagnosticRegistrationPayloadSchema = object({
  version: literal(1),
  targets: connectorRuntimeTargetsSchema,
}).strict();

const connectorRuntimeSyncTargetsSchema = connectorRuntimeTargetsSchema
  .min(1)
  .max(CONNECTOR_RUNTIME_SYNC_TARGETS_MAX);

export const connectorRuntimeCustomUnresolvedReasonSchema = zEnum([
  "permission-bundle-unavailable",
  "runtime-configuration-unavailable",
]);

export const connectorRuntimeBuiltinAbsentReasonSchema = literal(
  "connector-unavailable",
);

export const connectorRuntimeCustomAbsentReasonSchema = literal(
  "connector-unavailable",
);

const connectorRuntimeResultBaseSchema = object({
  nextSyncAt: string().datetime({ offset: true }).optional(),
});

export const connectorRuntimeBuiltinAvailableResultSchema =
  connectorRuntimeResultBaseSchema.extend({
    target: connectorRuntimeBuiltinTargetSchema,
    state: literal("available"),
    networkPolicy: networkPolicySchema,
  });

export const connectorRuntimeBuiltinUnresolvedResultSchema =
  connectorRuntimeResultBaseSchema.extend({
    target: connectorRuntimeBuiltinTargetSchema,
    state: literal("unresolved"),
    reason: literal("connector-unavailable"),
  });

export const connectorRuntimeBuiltinAbsentResultSchema =
  connectorRuntimeResultBaseSchema.extend({
    target: connectorRuntimeBuiltinTargetSchema,
    state: literal("absent"),
    reason: connectorRuntimeBuiltinAbsentReasonSchema,
  });

export const connectorRuntimeCustomAvailableResultSchema =
  connectorRuntimeResultBaseSchema.extend({
    target: connectorRuntimeCustomTargetSchema,
    state: literal("available"),
    firewall: executionFirewallInlineEntrySchema.extend({
      customConnectorId: uuid(),
      firewall: firewallSchema.extend({
        apis: array(
          firewallApiSchema.extend({
            id: string().min(1),
          }),
        ),
      }),
    }),
    networkPolicy: networkPolicySchema,
    baseUrlVars: record(string(), string()),
  });

export const connectorRuntimeCustomUnresolvedResultSchema =
  connectorRuntimeResultBaseSchema.extend({
    target: connectorRuntimeCustomTargetSchema,
    state: literal("unresolved"),
    reason: connectorRuntimeCustomUnresolvedReasonSchema,
  });

export const connectorRuntimeCustomAbsentResultSchema =
  connectorRuntimeResultBaseSchema.extend({
    target: connectorRuntimeCustomTargetSchema,
    state: literal("absent"),
    reason: connectorRuntimeCustomAbsentReasonSchema,
  });

export const connectorRuntimeSyncResultSchema = union([
  connectorRuntimeBuiltinAvailableResultSchema,
  connectorRuntimeBuiltinUnresolvedResultSchema,
  connectorRuntimeBuiltinAbsentResultSchema,
  connectorRuntimeCustomAvailableResultSchema,
  connectorRuntimeCustomUnresolvedResultSchema,
  connectorRuntimeCustomAbsentResultSchema,
]);
const runnerBuiltinFirewallNameSchema = string()
  .min(1)
  .max(128)
  .regex(/^(?:[a-z0-9][a-z0-9-]*|model-provider:[a-z0-9][a-z0-9-]*)$/);
const runnerBuiltinFirewallsResolveBodySchema = object({
  names: array(runnerBuiltinFirewallNameSchema)
    .min(1)
    .max(RUNNER_BUILTIN_FIREWALL_RESOLVE_NAMES_MAX)
    .optional(),
}).strict();
const runnerBuiltinFirewallsResolveResponseSchema = object({
  catalogDigest: string().regex(/^sha256:[a-f0-9]{64}$/),
  catalogVersion: string().min(1),
  firewalls: record(runnerBuiltinFirewallNameSchema, firewallSchema),
});

/**
 * Default profile when none is specified.
 * Must stay in sync with Rust: crates/runner/src/profile.rs → DEFAULT_PROFILE
 */
export const DEFAULT_PROFILE = "vm0/default";

const runnersPollBodySchema = object({
  runnerId: uuid().optional(),
  group: runnerGroupSchema,
  supportedProfiles: runnerSupportedProfileListSchema,
  excludedRunIds: array(uuid())
    .max(RUNNER_POLL_EXCLUDED_RUN_IDS_MAX)
    .optional(),
  telemetry: runnerPollTelemetrySchema.optional(),
});

/**
 * Job schema for polling response
 */
export const jobSchema = object({
  runId: uuid(),
  prompt: string(),
  appendSystemPrompt: string().nullable(),
  vars: record(string(), string()).nullable(),
  experimentalProfile: string(),
  cliAgentSessionId: string().nullable().optional(),
  reuseKey: string().nullable().optional(),
  runnerPreference: runnerPreferenceSchema,
});

export const heldSandboxStateSchema = object({
  reuseKey: string(),
  lastCompletedAt: string().datetime({ offset: true }),
  reusableSandbox: object({
    profile: string(),
    sourceRunId: uuid(),
  }),
});

export const activeReuseProducerSchema = object({
  runId: uuid(),
  reuseKey: string(),
  profile: string(),
});

export const heldHomeStateSchema = object({
  reuseKey: string(),
  lastCompletedAt: string().datetime({ offset: true }),
  homeCaches: array(
    object({
      profile: string(),
      homeAffinityVersion: literal(1),
      sourceRunId: uuid(),
    }),
  )
    .min(1)
    .max(8),
});

/**
 * Runners poll contract - POST /api/runners/poll
 * Long-polling endpoint to fetch pending jobs for a runner group
 *
 * NOTE: Uses POST instead of GET to avoid CDN caching issues on preview deployments.
 * POST requests are never cached, ensuring the Authorization header is always read fresh.
 */
export const runnersPollContract = c.router({
  poll: {
    method: "POST",
    path: "/api/runners/poll",
    headers: authHeadersSchema,
    body: runnersPollBodySchema,
    responses: {
      200: object({
        job: jobSchema.nullable(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Poll for pending jobs (long-polling with 30s timeout)",
  },
});

const archiveSizeSchema = number().int().min(1).max(Number.MAX_SAFE_INTEGER);

// Optional internal artifact publication behavior for a missing artifact root. Absence
// is equivalent to "fail".
export const artifactMissingRootPolicySchema = zEnum([
  "fail",
  "preserveParentVersion",
]);

/**
 * Canonical resolved Storage mount emitted to runners.
 */
export const storageMountEntrySchema = object({
  name: string(),
  storageId: string(),
  versionId: string(),
  mountPath: string(),
  archiveUrl: string().optional(),
  archiveSize: archiveSizeSchema.optional(),
  empty: boolean().optional(),
  missingRootPolicy: artifactMissingRootPolicySchema.optional(),
  writeback: boolean().optional(),
}).superRefine((mount, ctx) => {
  const writeback = mount.writeback ?? false;
  if (mount.archiveUrl === undefined && !(writeback && mount.empty === true)) {
    ctx.addIssue({
      code: ZodIssueCode.custom,
      path: ["archiveUrl"],
      message:
        "archiveUrl is required unless an empty writeback mount is requested",
    });
  }
  if (!writeback && mount.empty === true) {
    ctx.addIssue({
      code: ZodIssueCode.custom,
      path: ["empty"],
      message: "empty is only valid for writeback mounts",
    });
  }
  if (!writeback && mount.missingRootPolicy !== undefined) {
    ctx.addIssue({
      code: ZodIssueCode.custom,
      path: ["missingRootPolicy"],
      message: "missingRootPolicy is only valid for writeback mounts",
    });
  }
});

/**
 * Canonical resolved Storage mount persisted by the API before claim-time
 * capability negotiation. Ownership is API-only metadata and is intentionally
 * omitted from the Runner wire representation.
 */
export const storedStorageMountEntrySchema = storageMountEntrySchema.extend({
  orgId: string(),
  userId: string(),
});

function uniqueStorageMountPaths<T extends { readonly mountPath: string }>(
  mounts: readonly T[],
  ctx: RefinementCtx,
): void {
  const mountPaths = new Set<string>();
  for (const [index, mount] of mounts.entries()) {
    if (mountPaths.has(mount.mountPath)) {
      ctx.addIssue({
        code: ZodIssueCode.custom,
        path: [index, "mountPath"],
        message: `Duplicate Storage mount path "${mount.mountPath}"`,
      });
    }
    mountPaths.add(mount.mountPath);
  }
}

/** Canonical Runner wire representation. */
export const storageManifestSchema = object({
  workflowSkills: array(workflowSkillReferenceSchema).optional(),
  storageMounts: array(storageMountEntrySchema).superRefine(
    uniqueStorageMountPaths,
  ),
});

/** Retained native files are disposable; Chat remains the recovery source. */
export const nativeContinuationSchema = object({
  sessionId: string()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9_-]+$/)
    .nullable(),
  generationRunId: uuid().nullable(),
  /** Enabled only when native context could not resume, before CLI start. */
  recoveryPrompt: string().min(1).max(4096).nullable(),
})
  .strict()
  .superRefine((native, context) => {
    if ((native.sessionId === null) !== (native.generationRunId === null)) {
      context.addIssue({
        code: "custom",
        path: ["generationRunId"],
        message: "Native identity requires its producing Run",
      });
    }
  });
export type NativeContinuation = zInfer<typeof nativeContinuationSchema>;

export const secretConnectorMetadataSchema = object({
  sourceType: zEnum(["connector", "model-provider", "platform-secret"]),
  sourceUserId: string().optional(),
  // Exact credential owner for sources that support multiple credentials.
  // Older runner payloads omit this and retain the singleton lookup path.
  sourceId: uuid().optional(),
  metadataKey: string().optional(),
});

// Keyed by the same firewall auth secret env aliases as secretConnectorMap.
export const secretConnectorMetadataMapSchema = record(
  string(),
  secretConnectorMetadataSchema,
);

export const PI_SKILLS_ROOT = `${PI_AGENT_DIR}/skills`;

const piResourceSnapshotAgentsFilesSchema = array(
  object({
    path: string().startsWith("/"),
    content: string(),
  })
    .strict()
    .readonly(),
).readonly();

const piResourceSnapshotSkillsSchema = array(
  object({
    name: string().min(1),
    description: string().min(1),
    filePath: string().startsWith("/"),
    baseDir: string().startsWith("/"),
    scope: zEnum(["user", "project", "temporary"]),
    disableModelInvocation: boolean(),
  })
    .strict()
    .readonly(),
).readonly();

export const piResourceSnapshotSchema = object({
  schemaVersion: literal(1),
  agentsFiles: piResourceSnapshotAgentsFilesSchema,
  skills: piResourceSnapshotSkillsSchema,
})
  .strict()
  .readonly();

const piApiKeyCredentialSecretNameSchema = zEnum(["OPENROUTER_API_KEY"]);

const piModelCredentialBindingSchema = discriminatedUnion("kind", [
  object({
    kind: literal("api-key"),
    environment: zEnum(["OPENAI_API_KEY"]),
    secretName: piApiKeyCredentialSecretNameSchema,
  })
    .strict()
    .readonly(),
  object({
    kind: literal("access-token"),
    environment: zEnum(["CHATGPT_ACCESS_TOKEN"]),
    secretName: zEnum(["CHATGPT_ACCESS_TOKEN"]),
  })
    .strict()
    .readonly(),
  object({
    kind: literal("account-id"),
    environment: zEnum(["CHATGPT_ACCOUNT_ID"]),
    secretName: zEnum(["CHATGPT_ACCOUNT_ID"]),
  })
    .strict()
    .readonly(),
]);

/**
 * Shared strict route invariants. Generations are separate wire contracts;
 * adding a reader must not move existing writers to a newer generation.
 */
const piModelConfigVersionedSchema = object({
  schemaVersion: union([
    literal(PI_MODEL_CONFIG_CURRENT_GENERATION),
    literal(PI_MODEL_CONFIG_DIALECT_TIER_GENERATION),
  ]),
  dialect: zEnum(["openai-responses", "openai-codex-responses"]),
  transport: literal("sse"),
  provider: zEnum(["openrouter", "openai-codex"]),
  baseUrl: url(),
  model: string().min(1).max(512),
  catalogModel: string().min(1).max(512).optional(),
  thinkingLevel: zEnum([
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]).optional(),
  serviceTier: zEnum(["priority", "fast"]).optional(),
  credentialBindings: array(piModelCredentialBindingSchema).min(1).max(2),
})
  .strict()
  .superRefine((config, refinement) => {
    const bindingKinds = config.credentialBindings.map((binding) => {
      return binding.kind;
    });
    if (new Set(bindingKinds).size !== bindingKinds.length) {
      refinement.addIssue({
        code: "custom",
        path: ["credentialBindings"],
        message: "Pi credential binding kinds must be unique",
      });
    }

    if (config.dialect === "openai-responses") {
      if (config.provider === "openai-codex") {
        refinement.addIssue({
          code: "custom",
          path: ["provider"],
          message: "Public Responses cannot use the OpenAI Codex catalog",
        });
      }
      if (bindingKinds.length !== 1 || bindingKinds[0] !== "api-key") {
        refinement.addIssue({
          code: "custom",
          path: ["credentialBindings"],
          message: "Public Responses requires exactly one API-key binding",
        });
      }
      return;
    }

    if (config.provider !== "openai-codex") {
      refinement.addIssue({
        code: "custom",
        path: ["provider"],
        message: "Codex Responses requires the OpenAI Codex catalog",
      });
    }
    if (
      bindingKinds.length !== 2 ||
      !bindingKinds.includes("access-token") ||
      !bindingKinds.includes("account-id")
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["credentialBindings"],
        message:
          "Codex Responses requires one access-token and one account-ID binding",
      });
    }
    if (config.catalogModel !== undefined) {
      refinement.addIssue({
        code: "custom",
        path: ["catalogModel"],
        message: "Codex Responses uses its provider model as the catalog model",
      });
    }
    if (
      config.schemaVersion === PI_MODEL_CONFIG_CURRENT_GENERATION &&
      config.serviceTier !== undefined
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["serviceTier"],
        message: "Codex Responses does not accept a public API service tier",
      });
    }
  });

export const piModelConfigV2Schema = piModelConfigVersionedSchema
  .safeExtend({
    schemaVersion: literal(PI_MODEL_CONFIG_CURRENT_GENERATION),
    serviceTier: zEnum(["priority"]).optional(),
  })
  .readonly();

/** Additive reader capability only; route writers activate separately in #31803. */
export const piModelConfigV3Schema = discriminatedUnion("dialect", [
  piModelConfigVersionedSchema.safeExtend({
    schemaVersion: literal(PI_MODEL_CONFIG_DIALECT_TIER_GENERATION),
    dialect: literal("openai-responses"),
    transport: zEnum(["sse"]),
    provider: zEnum(["openrouter"]),
    serviceTier: zEnum(["priority"]).optional(),
  }),
  piModelConfigVersionedSchema.safeExtend({
    schemaVersion: literal(PI_MODEL_CONFIG_DIALECT_TIER_GENERATION),
    dialect: literal("openai-codex-responses"),
    transport: zEnum(["sse"]),
    provider: zEnum(["openai-codex"]),
    serviceTier: zEnum(["fast"]).optional(),
  }),
]).readonly();

/**
 * OpenRouter Chat Completions route. It has one public API-key binding and no
 * request service tier; an OpenRouter Preset owns reasoning and routing policy.
 */
export const piModelConfigV5Schema = object({
  schemaVersion: literal(PI_MODEL_CONFIG_CHAT_COMPLETIONS_GENERATION),
  dialect: literal("openai-completions"),
  transport: literal("sse"),
  provider: literal("openrouter"),
  baseUrl: url(),
  model: string().min(1).max(512),
  catalogModel: string().min(1).max(512).optional(),
  thinkingLevel: zEnum([
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]).optional(),
  credentialBindings: array(piModelCredentialBindingSchema)
    .length(1)
    .refine((bindings) => {
      return bindings[0]?.kind === "api-key";
    }, "Chat Completions requires exactly one API-key binding"),
})
  .strict()
  .readonly();

export const piModelConfigSchema = union([
  piModelConfigV2Schema,
  piModelConfigV3Schema,
  piModelConfigV5Schema,
]);

/**
 * Version marker for the sandbox Pi launch contract. Runtime resources are
 * discovered from Pi's canonical filesystem locations by the official loader.
 */
export const piLaunchConfigSchema = object({
  schemaVersion: literal(2),
})
  .strict()
  .readonly();

/**
 * Private launch payload the guest-agent writes for its Pi CLI child.
 *
 * Prompt-sized inputs travel through this file instead of the child's argv or
 * environment. See `crates/guest-contracts/src/env.rs`
 * (`PI_LAUNCH_PAYLOAD_FILE_ENV`) for the writer side of this contract.
 */
export const piLaunchPayloadSchema = object({
  schemaVersion: literal(1),
  appendSystemPrompt: string().nullable(),
  launchConfig: piLaunchConfigSchema,
})
  .strict()
  .readonly();

function requireCompletePiFields(
  context: {
    readonly cliAgentType?: unknown;
    readonly piSessionId?: unknown;
    readonly piLaunchConfig?: unknown;
    readonly piModelConfig?: unknown;
  },
  refinement: RefinementCtx,
): void {
  const expectsPi = context.cliAgentType === "pi";
  for (const field of [
    "piSessionId",
    "piLaunchConfig",
    "piModelConfig",
  ] as const) {
    const fieldPresent = context[field] !== undefined;
    if (!expectsPi && fieldPresent) {
      refinement.addIssue({
        code: "custom",
        path: [field],
        message: `${field} requires cliAgentType pi`,
      });
    } else if (expectsPi && !fieldPresent) {
      refinement.addIssue({
        code: "custom",
        path: [field],
        message: `${field} is required for cliAgentType pi`,
      });
    }
  }
}

/**
 * Stored execution context (subset stored in database for late routing)
 * Contains prepared context without runtime-generated fields
 * Secrets are encrypted with AES-256-GCM before storage
 */
const storedExecutionContextObjectSchema = object({
  // API-only intent. No custom Workflow body or attachment is frozen here.
  customWorkflowSelection: object({
    agentId: uuid(),
    invokedWorkflowId: uuid().nullable().optional(),
    automationId: uuid().optional(),
    protectedMountPaths: array(string()).optional(),
  })
    .strict()
    .optional(),
  storageMounts: array(storedStorageMountEntrySchema).superRefine(
    uniqueStorageMountPaths,
  ),
  environment: record(string(), string()).nullable(),
  platformEnvironment: record(string(), string()),
  // API-only references used to reconstruct runner masking values from the
  // effective stored agent environment. Null means no persistent secret map, and array
  // order/repetition follows secret-map values.
  // This field must not be included in the runner-facing ExecutionContext.
  secretValueEnvironmentKeys: array(string()).nullable(),
  // Connector-owned runtime vars used by proxy/firewall template resolution.
  // User-provided run vars stay in agent_runs.vars and are merged at claim time.
  vars: record(string(), string()).nullable().optional(),
  nativeContinuation: nativeContinuationSchema,
  // AES-256-GCM encrypted Record<string, string>. Keys are the runtime secret
  // names used by `${{ secrets.NAME }}`; connector/model-provider keys are env
  // aliases, not backing storage secret names.
  encryptedSecrets: string().nullable(),
  // Maps firewall auth secret env aliases (the `NAME` in `${{ secrets.NAME }}`) to
  // their connector or provider owner. Keys are env aliases, not storage secret names.
  secretConnectorMap: record(string(), string()).nullable().optional(),
  // Same keys as secretConnectorMap; adds source details when the owner alone
  // is not enough to locate access storage (for example, personal model providers).
  secretConnectorMetadataMap: secretConnectorMetadataMapSchema
    .nullable()
    .optional(),
  cliAgentType: string(),
  // Preview evaluation escape hatch: bypass preview mock CLIs and use the real
  // agent runtime.
  realAgentInPreview: boolean().optional(),
  // Capture HTTP header names, selected safe header values, request bodies, and response bodies
  // in network logs
  captureNetworkBodies: boolean().optional(),
  // Dispatch timestamp for E2E timing metrics, as Unix epoch milliseconds
  apiStartTime: apiStartTimeSchema.optional(),
  // User's timezone preference (IANA format, e.g., "Asia/Shanghai")
  userTimezone: string().optional(),
  // Firewall entries for proxy-side token replacement. Built-ins stay compact;
  // org custom connectors use inline firewall bodies.
  firewalls: executionFirewallsSchema.optional(),
  // Per-firewall network policies: which permissions are granted + unknownPolicy
  networkPolicies: networkPoliciesSchema.optional(),
  // Per-connector runtime network policy refresh deadlines. Used by runners to refresh
  // active sandbox policy when temporary allow grants expire.
  networkPolicyRefreshes: networkPolicyRefreshesSchema.optional(),
  // Stable connector targets pinned for this run. The runner owns this list
  // after claim independently of whether each target is currently available.
  connectorRuntimeTargets: connectorRuntimeTargetsSchema,
  // Tools to disable in Claude CLI (passed as --disallowed-tools)
  disallowedTools: array(string()).optional(),
  // Tools to make available in Claude CLI (passed as --tools)
  tools: array(string()).optional(),
  // Settings JSON to pass to Claude CLI (passed as --settings)
  settings: string().optional(),
  // Feature flags evaluated at job creation time (all switch states for user/org)
  featureFlags: record(string(), boolean()).optional(),
  billableFirewalls: array(string()).optional(),
  // Provider the proxy reports model token usage under: a Built-in route's
  // `usage_pricing` provider (possibly an alias of the actual model), else the
  // catalog model id. Billing eligibility is decided from API-owned run context.
  modelUsageProvider: string().optional(),
  // Total-input threshold (input + cache read + cache creation) at which
  // `modelUsageProvider` usage bills the `.long_context` categories, captured
  // by the API from the run's Built-in route
  // (`model_routes.long_context_min_total_input_tokens`). `0` explicitly marks
  // a single-tier route. Without a usable positive captured threshold, the
  // addon selects the base tier; it does not reconstruct a threshold. This
  // is not supported pre-catalog pricing compatibility; see
  // docs/deployment-compatibility.md for deployment order and rollback limits.
  modelUsageLongContextMinTotalInputTokens: number()
    .int()
    .nonnegative()
    .optional(),
  // API-owned Codex provider/runtime metadata forwarded through the runner.
  codexRuntimeConfig: modelProviderCodexRuntimeConfigSchema
    .nullable()
    .optional(),
  // Pi runs carry their session, launch config and model as one bundle.
  piSessionId: uuid().optional(),
  piLaunchConfig: piLaunchConfigSchema.optional(),
  piModelConfig: piModelConfigSchema.optional(),
});

/** Reads persisted execution contexts while stripping unknown writer metadata. */
export const storedExecutionContextSchema =
  storedExecutionContextObjectSchema.superRefine(requireCompletePiFields);

/**
 * Claim-time reader that inspects Pi generation support before decoding the
 * generation-specific route. Other stored-context readers remain fully typed.
 */
export const claimCompatibleStoredExecutionContextSchema =
  storedExecutionContextObjectSchema
    .extend({
      piModelConfig: zUnknown().optional(),
    })
    .superRefine(requireCompletePiFields);

/**
 * Execution context returned when claiming a job.
 *
 * This is the canonical producer schema. The runner's `ExecutionContext` is a
 * tolerant consumer projection and intentionally does not mirror every field.
 * See `crates/runner-types/src/types.rs`.
 */
const executionContextObjectSchema = object({
  // Reader preparation; the current API does not emit this section.
  contentBundles: claimedContentBundlesSchema.optional(),
  // Claim-only current Agent body; absent for jobs without an Agent.
  agentInstructions: string().optional(),
  // Response-only telemetry context; unavailable for non-chat or older claims.
  isFirstRun: boolean().optional(),
  runId: uuid(),
  reuseKey: string().nullable().optional(),
  prompt: string(),
  appendSystemPrompt: string().nullable(),
  vars: record(string(), string()).nullable(),
  sandboxToken: string(),
  storageManifest: storageManifestSchema.nullable(),
  environment: record(string(), string()).nullable(),
  platformEnvironment: record(string(), string()),
  nativeContinuation: nativeContinuationSchema,
  // Plain secret values used by the runner for redaction. These are values, not
  // names, and are base64-encoded only when exported through OKOU_SECRET_VALUES.
  secretValues: array(string()).nullable(),
  // AES-256-GCM encrypted Record<string, string>, passed through to mitm-addon
  // for auth resolution. Keys are runtime secret names used by
  // `${{ secrets.NAME }}`; connector/model-provider keys are env aliases, not
  // backing storage secret names.
  encryptedSecrets: string().nullable(),
  // Maps firewall auth secret env aliases (the `NAME` in `${{ secrets.NAME }}`) to
  // their connector or provider owner. Keys are env aliases, not storage secret names.
  secretConnectorMap: record(string(), string()).nullable().optional(),
  // Same keys as secretConnectorMap; adds source details when the owner alone
  // is not enough to locate access storage (for example, personal model providers).
  secretConnectorMetadataMap: secretConnectorMetadataMapSchema
    .nullable()
    .optional(),
  cliAgentType: string(),
  // Preview evaluation escape hatch: bypass preview mock CLIs and use the real
  // agent runtime.
  realAgentInPreview: boolean().optional(),
  // Capture HTTP header names, selected safe header values, request bodies, and response bodies
  // in network logs
  captureNetworkBodies: boolean().optional(),
  // Dispatch timestamp for E2E timing metrics, as Unix epoch milliseconds
  apiStartTime: apiStartTimeSchema.optional(),
  // User's timezone preference (IANA format, e.g., "Asia/Shanghai")
  userTimezone: string().optional(),
  // Firewall entries for proxy-side token replacement. Built-ins stay compact;
  // org custom connectors use inline firewall bodies.
  firewalls: executionFirewallsSchema.optional(),
  // Per-firewall network policies: which permissions are granted + unknownPolicy
  networkPolicies: networkPoliciesSchema.optional(),
  // Per-connector runtime network policy refresh deadlines. Used by runners to refresh
  // active sandbox policy when temporary allow grants expire.
  networkPolicyRefreshes: networkPolicyRefreshesSchema.optional(),
  // Stable connector targets pinned for this run. The runner owns this list
  // after claim independently of whether each target is currently available.
  connectorRuntimeTargets: connectorRuntimeTargetsSchema,
  // Tools to disable in Claude CLI (passed as --disallowed-tools)
  disallowedTools: array(string()).optional(),
  // Tools to make available in Claude CLI (passed as --tools)
  tools: array(string()).optional(),
  // Settings JSON to pass to Claude CLI (passed as --settings)
  settings: string().optional(),
  // Feature flags evaluated at job creation time (all switch states for user/org)
  featureFlags: record(string(), boolean()).optional(),
  billableFirewalls: array(string()).optional(),
  // Provider the proxy reports model token usage under: a Built-in route's
  // `usage_pricing` provider (possibly an alias of the actual model), else the
  // catalog model id. Billing eligibility is decided from API-owned run context.
  modelUsageProvider: string().optional(),
  // Total-input threshold (input + cache read + cache creation) at which
  // `modelUsageProvider` usage bills the `.long_context` categories, captured
  // by the API from the run's Built-in route
  // (`model_routes.long_context_min_total_input_tokens`). `0` explicitly marks
  // a single-tier route. Without a usable positive captured threshold, the
  // addon selects the base tier; it does not reconstruct a threshold. This
  // is not supported pre-catalog pricing compatibility; see
  // docs/deployment-compatibility.md for deployment order and rollback limits.
  modelUsageLongContextMinTotalInputTokens: number()
    .int()
    .nonnegative()
    .optional(),
  // API-owned Codex provider/runtime metadata forwarded through the runner.
  codexRuntimeConfig: modelProviderCodexRuntimeConfigSchema
    .nullable()
    .optional(),
  piSessionId: uuid().optional(),
  piLaunchConfig: piLaunchConfigSchema.optional(),
  piModelConfig: piModelConfigSchema.optional(),
});

export const executionContextSchema = executionContextObjectSchema.superRefine(
  (context, refinement) => {
    const piFields = [
      context.piSessionId,
      context.piLaunchConfig,
      context.piModelConfig,
    ];
    const expectsPi = context.cliAgentType === "pi";
    const hasMissingPiField = piFields.some((field) => {
      return field === undefined;
    });
    const hasPiField = piFields.some((field) => {
      return field !== undefined;
    });
    if (expectsPi && hasMissingPiField) {
      refinement.addIssue({
        code: "custom",
        path: ["piSessionId"],
        message:
          "Pi execution requires session, launch config, and model config",
      });
    } else if (!expectsPi && hasPiField) {
      refinement.addIssue({
        code: "custom",
        path: ["piSessionId"],
        message: "Pi execution fields require cliAgentType pi",
      });
    }
  },
);

/**
 * Runners job claim contract - POST /api/runners/jobs/:id/claim
 * Claim a pending job for execution
 * Verifies that the job's agent_run belongs to the authenticated user
 */
export const runnersJobClaimContract = c.router({
  claim: {
    method: "POST",
    path: "/api/runners/jobs/:id/claim",
    headers: authHeadersSchema,
    pathParams: object({
      id: uuid(),
    }),
    query: object({ workflowSkills: literal("2") }),
    body: object({
      runnerIdentity: runnerProcessIdentitySchema.optional(),
      runnerHostname: runnerHostnameSchema.optional(),
      capabilities: runnerClaimCapabilitiesSchema,
      telemetry: runnerClaimTelemetrySchema.optional(),
      installedVersions: runnerInstalledVersionsSchema.optional(),
    }),
    responses: {
      200: executionContextSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema, // Job does not belong to user
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Claim a pending job for execution",
  },
});

export const runnersWorkflowDownloadContract = c.router({
  get: {
    method: "GET",
    path: "/api/runners/runs/:runId/workflows/:workflowId",
    headers: authHeadersSchema,
    pathParams: object({ runId: uuid(), workflowId: uuid() }),
    responses: {
      200: workflowDownloadSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Download current Workflow content for an authenticated Run",
  },
});

export const runnerCancellationModeSchema = zEnum(["cooperative", "hard"]);
export type RunnerCancellationMode = zInfer<
  typeof runnerCancellationModeSchema
>;

const runCancellationIdentitySchema = object({
  protocolVersion: literal(1),
  runId: uuid(),
});

export const runnerCancellationResponseSchema = discriminatedUnion("state", [
  runCancellationIdentitySchema
    .extend({
      state: literal("present"),
      mode: runnerCancellationModeSchema.nullable(),
    })
    .strict(),
  runCancellationIdentitySchema.extend({ state: literal("gone") }).strict(),
  runCancellationIdentitySchema
    .extend({ state: literal("unavailable") })
    .strict(),
]);
export type RunnerCancellationResponse = zInfer<
  typeof runnerCancellationResponseSchema
>;

export const runnersCancellationContract = c.router({
  get: {
    method: "GET",
    path: "/api/runners/runs/:runId/cancellation",
    headers: authHeadersSchema,
    pathParams: object({ runId: uuid() }),
    query: object({
      runnerGroup: runnerGroupSchema,
      runnerId: uuid(),
      heartbeatGeneration: coerce
        .number()
        .pipe(runnerHeartbeatGenerationSchema),
    }).strict(),
    responses: {
      200: runnerCancellationResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Read the stop intent or confirmed absence of a claimed Run",
  },
});

export const STEERED_INPUT_ALREADY_CONSUMED_ERROR_CODE =
  "INPUT_ALREADY_CONSUMED";
export const STEERED_INPUT_RUN_NOT_RUNNING_ERROR_CODE = "RUN_NOT_RUNNING";

export const runnerNextSteerableInputResponseSchema = object({
  input: object({
    eventId: uuid(),
    prompt: string().min(1),
  }).nullable(),
});

export const runnerSteeredInputResponseSchema = object({
  outcome: literal("steered"),
});

/**
 * Read the next steerable prompt or `input.budget` targeting the running run,
 * then declare it steered. The replacement retains the source event type and
 * carries the run ID. Both authenticate with the run's sandbox token.
 */
export const runnersSteerContract = c.router({
  next: {
    method: "GET",
    path: "/api/runners/runs/:runId/steerable-inputs/next",
    headers: authHeadersSchema,
    pathParams: object({
      runId: uuid(),
    }),
    responses: {
      200: runnerNextSteerableInputResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary:
      "Read the next prompt or run-targeted budget a running run may steer",
  },
  steered: {
    method: "POST",
    path: "/api/runners/runs/:runId/steerable-inputs/:eventId/steered",
    headers: authHeadersSchema,
    pathParams: object({
      runId: uuid(),
      eventId: uuid(),
    }),
    body: object({}),
    responses: {
      200: runnerSteeredInputResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema.extend({
        error: apiErrorSchema.shape.error.extend({
          code: zEnum([
            STEERED_INPUT_ALREADY_CONSUMED_ERROR_CODE,
            STEERED_INPUT_RUN_NOT_RUNNING_ERROR_CODE,
          ]),
        }),
      }),
      500: apiErrorSchema,
    },
    summary: "Declare a prompt or run-targeted budget steered into a run",
  },
});

export const runnersConnectorRuntimeSyncContract = c.router({
  sync: {
    method: "POST",
    path: "/api/runners/runs/:runId/connector-runtime/sync",
    headers: authHeadersSchema,
    pathParams: object({
      runId: uuid(),
    }),
    body: object({
      targets: connectorRuntimeSyncTargetsSchema,
    }),
    responses: {
      200: object({
        results: array(connectorRuntimeSyncResultSchema),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema.extend({
        error: apiErrorSchema.shape.error.extend({
          code: literal(CONNECTOR_RUNTIME_SYNC_RUN_TERMINAL_ERROR_CODE),
        }),
      }),
      500: apiErrorSchema,
    },
    summary: "Sync active run connector runtime targets",
  },
});

export const runnersBuiltinFirewallsResolveContract = c.router({
  resolve: {
    method: "POST",
    path: "/api/runners/builtin-firewalls/resolve",
    headers: authHeadersSchema,
    body: runnerBuiltinFirewallsResolveBodySchema,
    responses: {
      200: runnerBuiltinFirewallsResolveResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Resolve builtin firewall definitions for runners",
  },
});

const MAX_HEARTBEAT_HOME_CACHES = 4096;

/**
 * Runner heartbeat body — periodic state report from each runner
 */
export const heartbeatBodySchema = object({
  runnerId: uuid(),
  // Advisory locality, using the same configured identity as winning claims.
  runnerHostname: runnerHostnameSchema.optional(),
  group: runnerGroupSchema,
  snapshotGeneration: runnerHeartbeatGenerationSchema,
  snapshotSequence: number().int().positive().max(Number.MAX_SAFE_INTEGER),
  totalVcpu: number().int().nonnegative(),
  totalMemoryMb: number().int().nonnegative(),
  maxConcurrent: number().int().nonnegative(),
  allocatedVcpu: number().int().nonnegative(),
  allocatedMemoryMb: number().int().nonnegative(),
  runningCount: number().int().nonnegative(),
  admittableProfiles: runnerProfileListSchema,
  heldSandboxStates: array(heldSandboxStateSchema).max(1024),
  heldHomeStates: array(heldHomeStateSchema).max(MAX_HEARTBEAT_HOME_CACHES),
  activeReuseProducers: array(activeReuseProducerSchema).max(1024),
  mode: zEnum(["starting", "running", "draining", "stopping"]),
}).superRefine((heartbeat, ctx) => {
  const homeCacheCount = heartbeat.heldHomeStates.reduce((count, state) => {
    return count + state.homeCaches.length;
  }, 0);
  if (homeCacheCount > MAX_HEARTBEAT_HOME_CACHES) {
    ctx.addIssue({
      code: ZodIssueCode.custom,
      path: ["heldHomeStates"],
      message: `heartbeat may contain at most ${MAX_HEARTBEAT_HOME_CACHES} home caches`,
    });
  }
});

/**
 * Runners heartbeat contract - POST /api/runners/heartbeat
 * Periodic state report from runners for capacity tracking and dispatch
 */
export const runnersHeartbeatContract = c.router({
  heartbeat: {
    method: "POST",
    path: "/api/runners/heartbeat",
    headers: authHeadersSchema,
    body: heartbeatBodySchema,
    responses: {
      200: object({ ok: literal(true) }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Report runner heartbeat with capacity and state",
  },
});

export type RunnersPollContract = typeof runnersPollContract;
export type RunnersJobClaimContract = typeof runnersJobClaimContract;
export type RunnersSteerContract = typeof runnersSteerContract;
export type RunnersConnectorRuntimeSyncContract =
  typeof runnersConnectorRuntimeSyncContract;
export type RunnersHeartbeatContract = typeof runnersHeartbeatContract;
export type RunnersBuiltinFirewallsResolveContract =
  typeof runnersBuiltinFirewallsResolveContract;
export type Job = zInfer<typeof jobSchema>;
export type RunnerPreference = zInfer<typeof runnerPreferenceSchema>;
export type RunnerPreferenceClaimState = zInfer<
  typeof runnerPreferenceClaimStateSchema
>;
export type ActiveReuseProducer = zInfer<typeof activeReuseProducerSchema>;
export type HeldSandboxState = zInfer<typeof heldSandboxStateSchema>;
export type HeldHomeState = zInfer<typeof heldHomeStateSchema>;
export type ExecutionContext = zInfer<typeof executionContextSchema>;
export type StoredExecutionContext = zInfer<
  typeof storedExecutionContextSchema
>;
export type PiModelConfig = zInfer<typeof piModelConfigSchema>;
export type PiModelConfigV2 = zInfer<typeof piModelConfigV2Schema>;
export type PiModelConfigV3 = zInfer<typeof piModelConfigV3Schema>;
export type PiModelConfigV5 = zInfer<typeof piModelConfigV5Schema>;
export type PiModelCredentialBinding = zInfer<
  typeof piModelCredentialBindingSchema
>;
export type RunnerClaimCapabilities = zInfer<
  typeof runnerClaimCapabilitiesSchema
>;
export type RunnerInstalledVersions = zInfer<
  typeof runnerInstalledVersionsSchema
>;
export type PiLaunchConfig = zInfer<typeof piLaunchConfigSchema>;
export type PiResourceSnapshot = zInfer<typeof piResourceSnapshotSchema>;
export type PiLaunchPayload = zInfer<typeof piLaunchPayloadSchema>;
export type ClaimCompatibleStoredExecutionContext = zInfer<
  typeof claimCompatibleStoredExecutionContextSchema
>;
export type NetworkPolicyRefresh = zInfer<typeof networkPolicyRefreshSchema>;
export type ConnectorRuntimeTarget = zInfer<
  typeof connectorRuntimeTargetSchema
>;
export type ConnectorRuntimeTargetRegistration = zInfer<
  typeof connectorRuntimeTargetRegistrationSchema
>;
export type AgentRunConnectorDiagnosticRegistrationPayload = zInfer<
  typeof agentRunConnectorDiagnosticRegistrationPayloadSchema
>;
export type ConnectorRuntimeCustomUnresolvedReason = zInfer<
  typeof connectorRuntimeCustomUnresolvedReasonSchema
>;
export type ConnectorRuntimeCustomAbsentReason = zInfer<
  typeof connectorRuntimeCustomAbsentReasonSchema
>;
export type ConnectorRuntimeSyncResult = zInfer<
  typeof connectorRuntimeSyncResultSchema
>;
export type RunnerBuiltinFirewallsResolveBody = zInfer<
  typeof runnerBuiltinFirewallsResolveBodySchema
>;
export type RunnerBuiltinFirewallsResolveResponse = zInfer<
  typeof runnerBuiltinFirewallsResolveResponseSchema
>;
export type SecretConnectorMetadata = zInfer<
  typeof secretConnectorMetadataSchema
>;
export type StorageMountEntry = zInfer<typeof storageMountEntrySchema>;
export type StoredStorageMountEntry = zInfer<
  typeof storedStorageMountEntrySchema
>;
export type StorageManifest = zInfer<typeof storageManifestSchema>;
export type CanonicalStorageManifest = StorageManifest;
