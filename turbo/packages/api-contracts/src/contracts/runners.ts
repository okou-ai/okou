import { piSandboxContinuationSchema } from "./pi-inference-lifecycle";
import { z } from "zod";
import { piCredentialHeaderSchema } from "./pi-credential";
import { piModelConfigV4Schema } from "./pi-native";

import { authHeadersSchema, initContract } from "./base";
import {
  executionFirewallInlineEntrySchema,
  executionFirewallsSchema,
  firewallApiSchema,
  firewallPolicyValueSchema,
  firewallSchema,
  networkPolicySchema,
  networkPoliciesSchema,
} from "@okouai/connectors/firewall-contracts";
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
import { eventSequenceNumberSchema } from "./runs";

export {
  PI_MODEL_CONFIG_NATIVE_GENERATION,
  piModelConfigV4Schema,
} from "./pi-native";

export { BUILTIN_FIREWALL_CATALOG_MAX_BYTES } from "@okouai/connectors/connector-catalog/contracts";

export {
  CANONICAL_GUEST_HOME_DIR,
  CANONICAL_WORKING_DIR,
  RUNNER_HOSTNAME_MAX_LENGTH,
  OFFICIAL_RUNNER_TOKEN_PREFIX,
  RUNNER_VERSION_MAX_LENGTH,
  runnerGroupSchema,
  runnerHeartbeatGenerationSchema,
  runnerHostnameSchema,
  runnerVersionSchema,
  sandboxReuseResultSchema,
  workspaceReuseResultSchema,
  type SandboxReuseResult,
  type WorkspaceReuseResult,
} from "./runner-primitives";

const c = initContract();

export const MIN_EPOCH_MS_TIMESTAMP = 1_000_000_000_000;
const apiStartTimeSchema = z.number().int().min(MIN_EPOCH_MS_TIMESTAMP);

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
export const CANONICAL_PI_SESSION_DIR = `${PI_AGENT_DIR}/sessions/--home-user-workspace--`;
// Shared resume history size contract. Rust consumers import the generated
// binding from `api_contracts::generated::constants`.
export const RESUME_SESSION_HISTORY_MAX_BYTES = 128 * 1024 * 1024;
export const ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES = 1024 * 1024;
// Shared by the runner's enforced deadline and the agent-facing system prompt
// so the documented execution budget cannot drift from runtime behavior.
export const AGENT_EXECUTION_TIMEOUT_SECONDS = 2 * 60 * 60;
export const SESSION_HISTORY_ENCODING_IDENTITY = "identity";
export const SESSION_HISTORY_ENCODING_GZIP = "gzip";
export const SESSION_HISTORY_ENCODING_ZSTD = "zstd";
export const SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT =
  "configured_public_endpoint";
export const SESSION_HISTORY_DOWNLOAD_SOURCE_DEFAULT_R2_ENDPOINT =
  "default_r2_endpoint";
export const SESSION_HISTORY_GZIP_MIN_BYTES = 64 * 1024;
export const CONNECTOR_RUNTIME_SYNC_TARGETS_MAX = 256;
export const CONNECTOR_RUNTIME_SYNC_RUN_TERMINAL_ERROR_CODE = "RUN_TERMINAL";
export const RUNNER_CANCELLATION_RECOVERY_GRACE_MS = 90_000;
export const CANCELLATION_RECOVERY_STALE_AFTER_MS =
  RUNNER_CANCELLATION_RECOVERY_GRACE_MS + 30_000;
export const BUILTIN_FIREWALL_CATALOG_CACHE_SCHEMA_VERSION = 1;
export const RUNNER_BUILTIN_FIREWALL_RESOLVE_NAMES_MAX = 512;
export const PI_MODEL_CONFIG_LEGACY_GENERATION = 1;
// Existing versioned writers stay on generation 2 until their activation slice.
export const PI_MODEL_CONFIG_CURRENT_GENERATION = 2;
export const PI_MODEL_CONFIG_DIALECT_TIER_GENERATION = 3;
export const RUNNER_CLAIM_PI_MODEL_CONFIG_GENERATIONS_MAX = 8;
export const PI_MEMORY_PHASE2_MAINTENANCE_MAX_SELECTED_CANDIDATES = 256;
export const PI_MEMORY_PHASE2_MAINTENANCE_MAX_SELECTED_UTF8_BYTES = 21_036_800;
export const sessionHistoryEncodingSchema = z.enum([
  SESSION_HISTORY_ENCODING_IDENTITY,
  SESSION_HISTORY_ENCODING_GZIP,
  SESSION_HISTORY_ENCODING_ZSTD,
]);
export const sessionHistoryDownloadSourceSchema = z.enum([
  SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT,
  SESSION_HISTORY_DOWNLOAD_SOURCE_DEFAULT_R2_ENDPOINT,
]);
export const sessionHistorySizeBucketSchema = z.enum([
  "lt_64_kib",
  "64_256_kib",
  "256_kib_1_mib",
  "1_4_mib",
  "4_16_mib",
  "16_64_mib",
  "64_128_mib",
]);

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

export const runnerClaimPollReasonSchema = z.enum([
  "immediate",
  "deferred",
  "wakeup_retry",
  "slow",
  "fast",
]);

const runnerProcessIdentitySchema = z
  .object({
    runnerId: z.uuid(),
    heartbeatGeneration: runnerHeartbeatGenerationSchema,
  })
  .strict();

export const runnerClaimCapabilitiesSchema = z
  .object({
    piModelConfigGenerations: z
      .array(z.number().int().positive().max(255))
      .min(1)
      .max(RUNNER_CLAIM_PI_MODEL_CONFIG_GENERATIONS_MAX)
      .refine((generations) => {
        return new Set(generations).size === generations.length;
      }, "Pi model-config generations must be unique"),
  })
  .strict()
  .readonly();

export const builtInModelProviderConnectionSourceSchema = z.enum([
  "provider_response",
  "upstream_transport",
]);

const BUILT_IN_MODEL_PROVIDER_RETRY_AFTER_MAX_SECONDS = 300;
const builtInModelProviderRetryAfterSecondsSchema = z
  .number()
  .int()
  .positive()
  .max(BUILT_IN_MODEL_PROVIDER_RETRY_AFTER_MAX_SECONDS)
  .optional();

/**
 * Atomic advisory decision for cross-runner reuse coordination. A preferred
 * runner is not an exclusive assignee; another runner with a better compatible
 * local resource remains eligible to claim.
 */
export const runnerPreferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("preference"),
      runnerIdentity: runnerProcessIdentitySchema,
      tier: z.enum([
        "exactSandbox",
        "finalizingPredecessor",
        "reusableSandbox",
        "workspaceCache",
      ]),
      expiresAt: z.string().datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      kind: z.literal("noPreference"),
      reason: z.enum([
        "noReuseKey",
        "expired",
        "noViableHolder",
        "lookupError",
      ]),
    })
    .strict(),
]);

export const runnerPreferenceClaimStateSchema = z.enum([
  "active",
  "expired",
  "cleared",
]);

const runnerClaimDiscoverySourceSchema = z.enum(["ably", "poll"]);
const runnerClaimTelemetrySchema = z
  .object({
    discoverySource: runnerClaimDiscoverySourceSchema.optional(),
    jobDiscoveredToClaimRequestMs: z.number().int().nonnegative().optional(),
    localAdmissionToClaimRequestMs: z.number().int().nonnegative().optional(),
    directCandidateNotificationToEnqueueMs: z
      .number()
      .int()
      .nonnegative()
      .optional(),
    directCandidateInboxWaitMs: z.number().int().nonnegative().optional(),
    providerDiscoveryToMainLoopMs: z.number().int().nonnegative().optional(),
    mainLoopToLocalAdmissionMs: z.number().int().nonnegative().optional(),
    pollDueToJobDiscoveredMs: z.number().int().nonnegative().optional(),
    pollHttpRequestMs: z.number().int().nonnegative().optional(),
    pollReason: runnerClaimPollReasonSchema.optional(),
    runnerPreference: runnerPreferenceSchema.optional().catch(undefined),
    runnerPreferenceClaimState: runnerPreferenceClaimStateSchema.optional(),
  })
  .catch({});

const runnerPollTelemetrySchema = z
  .object({
    pollReason: runnerClaimPollReasonSchema.optional(),
  })
  .catch({});

const runnerProfileListSchema = z.array(z.string());
const runnerSupportedProfileListSchema = runnerProfileListSchema.min(1);
export const RUNNER_POLL_EXCLUDED_RUN_IDS_MAX = 128;

const networkPolicyRefreshSchema = z.object({
  nextRefreshAt: z.string().datetime({ offset: true }),
});

const networkPolicyRefreshesSchema = z.record(
  z.string(),
  networkPolicyRefreshSchema,
);

export const connectorRuntimeBuiltinTargetSchema = z.object({
  kind: z.literal("builtin"),
  connectorSlug: connectorSlugSchema,
});

export const connectorRuntimeCustomTargetSchema = z.object({
  kind: z.literal("custom"),
  customConnectorId: z.uuid(),
});

export const connectorRuntimeTargetSchema = z.discriminatedUnion("kind", [
  connectorRuntimeBuiltinTargetSchema,
  connectorRuntimeCustomTargetSchema,
]);

export const connectorRuntimeCustomTargetRegistrationSchema =
  connectorRuntimeCustomTargetSchema.extend({
    baseUrlVars: z.record(z.string(), z.string()),
    sourceId: z.uuid().optional(),
  });

export const connectorRuntimeBuiltinTargetRegistrationSchema =
  connectorRuntimeBuiltinTargetSchema.extend({
    baseUrlVars: z.record(z.string(), z.string()).optional(),
    sourceId: z.uuid().optional(),
  });

export const connectorRuntimeTargetRegistrationSchema = z.discriminatedUnion(
  "kind",
  [
    connectorRuntimeBuiltinTargetRegistrationSchema,
    connectorRuntimeCustomTargetRegistrationSchema,
  ],
);

export function connectorRuntimeTargetKey(
  target:
    | z.infer<typeof connectorRuntimeTargetSchema>
    | z.infer<typeof connectorRuntimeTargetRegistrationSchema>,
): string {
  return target.kind === "builtin"
    ? `builtin:${target.connectorSlug}`
    : `custom:${target.customConnectorId}`;
}

function uniqueConnectorRuntimeTargets(
  targets: readonly z.infer<typeof connectorRuntimeTargetRegistrationSchema>[],
  context: z.RefinementCtx,
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

export const connectorRuntimeTargetsSchema = z
  .array(connectorRuntimeTargetRegistrationSchema)
  .superRefine(uniqueConnectorRuntimeTargets);

export const agentRunConnectorDiagnosticRegistrationPayloadSchema = z
  .object({
    version: z.literal(1),
    targets: connectorRuntimeTargetsSchema,
  })
  .strict();

const connectorRuntimeSyncTargetsSchema = connectorRuntimeTargetsSchema
  .min(1)
  .max(CONNECTOR_RUNTIME_SYNC_TARGETS_MAX);

export const connectorRuntimeCustomUnresolvedReasonSchema = z.enum([
  "permission-bundle-unavailable",
  "runtime-configuration-unavailable",
]);

export const connectorRuntimeCustomAbsentReasonSchema = z.literal(
  "connector-unavailable",
);

const connectorRuntimeResultBaseSchema = z.object({
  nextSyncAt: z.string().datetime({ offset: true }).optional(),
});

export const connectorRuntimeBuiltinAvailableResultSchema =
  connectorRuntimeResultBaseSchema.extend({
    target: connectorRuntimeBuiltinTargetSchema,
    state: z.literal("available"),
    networkPolicy: networkPolicySchema,
  });

export const connectorRuntimeBuiltinUnresolvedResultSchema =
  connectorRuntimeResultBaseSchema.extend({
    target: connectorRuntimeBuiltinTargetSchema,
    state: z.literal("unresolved"),
    reason: z.literal("connector-unavailable"),
  });

export const connectorRuntimeCustomAvailableResultSchema =
  connectorRuntimeResultBaseSchema.extend({
    target: connectorRuntimeCustomTargetSchema,
    state: z.literal("available"),
    firewall: executionFirewallInlineEntrySchema.extend({
      customConnectorId: z.uuid(),
      firewall: firewallSchema.extend({
        apis: z.array(
          firewallApiSchema.extend({
            id: z.string().min(1),
          }),
        ),
      }),
    }),
    networkPolicy: networkPolicySchema,
    baseUrlVars: z.record(z.string(), z.string()),
  });

export const connectorRuntimeCustomUnresolvedResultSchema =
  connectorRuntimeResultBaseSchema.extend({
    target: connectorRuntimeCustomTargetSchema,
    state: z.literal("unresolved"),
    reason: connectorRuntimeCustomUnresolvedReasonSchema,
  });

export const connectorRuntimeCustomAbsentResultSchema =
  connectorRuntimeResultBaseSchema.extend({
    target: connectorRuntimeCustomTargetSchema,
    state: z.literal("absent"),
    reason: connectorRuntimeCustomAbsentReasonSchema,
  });

export const connectorRuntimeSyncResultSchema = z.union([
  connectorRuntimeBuiltinAvailableResultSchema,
  connectorRuntimeBuiltinUnresolvedResultSchema,
  connectorRuntimeCustomAvailableResultSchema,
  connectorRuntimeCustomUnresolvedResultSchema,
  connectorRuntimeCustomAbsentResultSchema,
]);
const connectorPermissionNameListSchema = z
  .array(z.string().min(1))
  .superRefine((names, context) => {
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: "custom",
        message: "Connector permission names must be unique",
      });
    }
  });
const connectorPermissionDefaultOverridesSchema = z
  .object({
    allow: connectorPermissionNameListSchema.optional(),
    deny: connectorPermissionNameListSchema.optional(),
    ask: connectorPermissionNameListSchema.optional(),
  })
  .strict();
const connectorPermissionBaselineEntrySchema = z
  .object({
    permissionNames: connectorPermissionNameListSchema,
    defaultPolicy: z
      .object({
        permissionDefault: firewallPolicyValueSchema,
        permissionOverrides:
          connectorPermissionDefaultOverridesSchema.optional(),
        unknownPolicy: firewallPolicyValueSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((entry, context) => {
    const permissionNames = new Set(entry.permissionNames);
    const overrideNames = Object.values(
      entry.defaultPolicy.permissionOverrides ?? {},
    ).flat();
    if (new Set(overrideNames).size !== overrideNames.length) {
      context.addIssue({
        code: "custom",
        path: ["defaultPolicy", "permissionOverrides"],
        message: "Connector permission overrides must not overlap",
      });
    }
    for (const permissionName of overrideNames) {
      if (!permissionNames.has(permissionName)) {
        context.addIssue({
          code: "custom",
          path: ["defaultPolicy", "permissionOverrides"],
          message: "Connector permission override must name a permission",
        });
      }
    }
  });
const connectorCatalogDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const connectorCatalogBackendVersionSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u);
const connectorCatalogBuildCommitShaSchema = z
  .string()
  .regex(/^[a-f0-9]{40}$/u);

export const storedConnectorPermissionBaselineSchema = z
  .object({
    version: z.literal(1),
    catalogIdentity: z
      .object({
        sourceId: z.string().min(1),
        schemaVersion: z.number().int().positive(),
        catalogVersion: z.string().min(1),
        catalogDigest: connectorCatalogDigestSchema,
        capabilityDigest: connectorCatalogDigestSchema,
      })
      .strict(),
    validationAuthority: z
      .object({
        backendVersion: connectorCatalogBackendVersionSchema,
        buildCommitSha: connectorCatalogBuildCommitShaSchema.nullable(),
      })
      .strict(),
    connectors: z.record(
      connectorSlugSchema,
      connectorPermissionBaselineEntrySchema,
    ),
  })
  .strict();
const runnerBuiltinFirewallNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^(?:[a-z0-9][a-z0-9-]*|model-provider:[a-z0-9][a-z0-9-]*)$/);
const runnerBuiltinFirewallsResolveBodySchema = z
  .object({
    names: z
      .array(runnerBuiltinFirewallNameSchema)
      .min(1)
      .max(RUNNER_BUILTIN_FIREWALL_RESOLVE_NAMES_MAX)
      .optional(),
  })
  .strict();
const runnerBuiltinFirewallsResolveResponseSchema = z.object({
  catalogDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  catalogVersion: z.string().min(1),
  firewalls: z.record(runnerBuiltinFirewallNameSchema, firewallSchema),
});

/**
 * Default profile when none is specified.
 * Must stay in sync with Rust: crates/runner/src/profile.rs → DEFAULT_PROFILE
 */
export const DEFAULT_PROFILE = "vm0/default";

const runnersPollBodySchema = z.object({
  runnerId: z.uuid().optional(),
  group: runnerGroupSchema,
  supportedProfiles: runnerSupportedProfileListSchema,
  excludedRunIds: z
    .array(z.uuid())
    .max(RUNNER_POLL_EXCLUDED_RUN_IDS_MAX)
    .optional(),
  telemetry: runnerPollTelemetrySchema.optional(),
});

/**
 * Job schema for polling response
 */
export const jobSchema = z.object({
  runId: z.uuid(),
  prompt: z.string(),
  appendSystemPrompt: z.string().nullable(),
  vars: z.record(z.string(), z.string()).nullable(),
  experimentalProfile: z.string(),
  cliAgentSessionId: z.string().nullable().optional(),
  reuseKey: z.string().nullable().optional(),
  historyGenerationRunId: z.uuid().optional(),
  runnerPreference: runnerPreferenceSchema,
});

const heldWorkspaceCacheSchema = z.object({
  profile: z.string(),
  workspaceAffinityVersion: z.literal(1),
});

export const heldSandboxStateSchema = z.object({
  reuseKey: z.string(),
  lastCompletedAt: z.string().datetime({ offset: true }),
  reusableSandbox: z.object({
    profile: z.string(),
    historyGenerationRunId: z.uuid().optional(),
  }),
});

export const heldWorkspaceStateSchema = z.object({
  reuseKey: z.string(),
  lastCompletedAt: z.string().datetime({ offset: true }),
  workspaceCaches: z.array(heldWorkspaceCacheSchema).min(1).max(8),
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
      200: z.object({
        job: jobSchema.nullable(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Poll for pending jobs (long-polling with 30s timeout)",
  },
});

const archiveSizeSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

// Optional internal checkpoint behavior for a missing artifact root. Absence
// is equivalent to "fail".
export const artifactMissingRootPolicySchema = z.enum([
  "fail",
  "preserveParentVersion",
]);

/**
 * Canonical resolved Storage mount emitted to runners.
 */
export const storageMountEntrySchema = z
  .object({
    name: z.string(),
    storageId: z.string(),
    versionId: z.string(),
    mountPath: z.string(),
    archiveUrl: z.string().optional(),
    archiveSize: archiveSizeSchema.optional(),
    empty: z.boolean().optional(),
    baselineCandidate: z.literal(true).optional(),
    instructionsTargetFilename: z.string().optional(),
    missingRootPolicy: artifactMissingRootPolicySchema.optional(),
    writeback: z.boolean().optional(),
  })
  .superRefine((mount, ctx) => {
    const writeback = mount.writeback ?? false;
    if (
      mount.archiveUrl === undefined &&
      !(writeback && mount.empty === true)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["archiveUrl"],
        message:
          "archiveUrl is required unless an empty writeback mount is requested",
      });
    }
    if (!writeback && mount.empty === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["empty"],
        message: "empty is only valid for writeback mounts",
      });
    }
    if (writeback && mount.instructionsTargetFilename !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["instructionsTargetFilename"],
        message: "instructionsTargetFilename is not valid for writeback mounts",
      });
    }
    if (writeback && mount.baselineCandidate === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["baselineCandidate"],
        message: "baselineCandidate is not valid for writeback mounts",
      });
    }
    if (!writeback && mount.missingRootPolicy !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
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
  orgId: z.string(),
  userId: z.string(),
});

function uniqueStorageMountPaths<T extends { readonly mountPath: string }>(
  mounts: readonly T[],
  ctx: z.RefinementCtx,
): void {
  const mountPaths = new Set<string>();
  for (const [index, mount] of mounts.entries()) {
    if (mountPaths.has(mount.mountPath)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "mountPath"],
        message: `Duplicate Storage mount path "${mount.mountPath}"`,
      });
    }
    mountPaths.add(mount.mountPath);
  }
}

/** Canonical Runner wire representation. */
export const storageManifestSchema = z.object({
  storageMounts: z
    .array(storageMountEntrySchema)
    .superRefine(uniqueStorageMountPaths),
});

/**
 * Resume session information. The compatibility wire field is `sessionId`, but
 * its semantic name in API/runner code is `cliAgentSessionId`.
 */
const inlineResumeSessionSchema = z.object({
  sessionId: z.string(),
  sessionHistory: z.string(),
});

const resumeSessionHistoryBlobRefSchema = z.object({
  kind: z.literal("blob"),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});
const resumeSessionHistoryDownloadSourceFieldSchema = {
  downloadSource: sessionHistoryDownloadSourceSchema.optional(),
};
const resumeSessionHistoryRawSizeSchema = z
  .number()
  .int()
  .positive()
  .max(RESUME_SESSION_HISTORY_MAX_BYTES);
const resumeSessionHistoryEncodedSizeSchema = z
  .number()
  .int()
  .positive()
  .max(RESUME_SESSION_HISTORY_MAX_BYTES);

const storedResumeSessionRefSchema = z.object({
  sessionId: z.string(),
  historyGenerationRunId: z.uuid().optional(),
  historyRef: resumeSessionHistoryBlobRefSchema.extend({
    encoding: sessionHistoryEncodingSchema.optional(),
  }),
});

const resumeSessionIdentityHistoryRefSchema = resumeSessionHistoryBlobRefSchema
  .extend({
    url: z.string().url(),
    encoding: z.literal("identity"),
    rawSize: resumeSessionHistoryRawSizeSchema,
    encodedSize: resumeSessionHistoryEncodedSizeSchema,
    ...resumeSessionHistoryDownloadSourceFieldSchema,
  })
  .strict();

const resumeSessionGzipHistoryRefSchema = resumeSessionHistoryBlobRefSchema
  .extend({
    url: z.string().url(),
    encoding: z.literal("gzip"),
    rawSize: resumeSessionHistoryRawSizeSchema,
    encodedSize: resumeSessionHistoryEncodedSizeSchema,
    ...resumeSessionHistoryDownloadSourceFieldSchema,
  })
  .strict();

const resumeSessionZstdHistoryRefSchema = resumeSessionHistoryBlobRefSchema
  .extend({
    url: z.string().url(),
    encoding: z.literal("zstd"),
    rawSize: resumeSessionHistoryRawSizeSchema,
    encodedSize: resumeSessionHistoryEncodedSizeSchema,
    ...resumeSessionHistoryDownloadSourceFieldSchema,
  })
  .strict();

const resumeSessionRefSchema = z.object({
  sessionId: z.string(),
  historyRef: z.union([
    resumeSessionGzipHistoryRefSchema,
    resumeSessionZstdHistoryRefSchema,
    resumeSessionIdentityHistoryRefSchema,
  ]),
});

export const storedResumeSessionSchema = z.union([
  inlineResumeSessionSchema,
  storedResumeSessionRefSchema,
]);

export const resumeSessionSchema = z.union([
  inlineResumeSessionSchema,
  resumeSessionRefSchema,
]);

export const secretConnectorMetadataSchema = z.object({
  sourceType: z.enum(["connector", "model-provider", "platform-secret"]),
  sourceUserId: z.string().optional(),
  // Exact credential owner for sources that support multiple credentials.
  // Older runner payloads omit this and retain the singleton lookup path.
  sourceId: z.uuid().optional(),
  metadataKey: z.string().optional(),
});

// Keyed by the same firewall auth secret env aliases as secretConnectorMap.
export const secretConnectorMetadataMapSchema = z.record(
  z.string(),
  secretConnectorMetadataSchema,
);

export const PI_MEMORY_ROOT = `${PI_AGENT_DIR}/memory`;
export const PI_MEMORY_SUMMARY_PATH = `${PI_MEMORY_ROOT}/memory_summary.md`;
export const PI_MEMORY_SUMMARY_MAX_BYTES = 64 * 1024;
/** Budget for the summary excerpt injected into the prompt, marker included. */
export const PI_MEMORY_SUMMARY_MAX_TOKENS = 2500;
/** Every o200k token decodes to at least one UTF-8 byte. */
const PI_MEMORY_SUMMARY_MIN_TOKEN_BYTES = 1;
/**
 * Finite bound for the exact o200k token count of the full stored summary,
 * derived from the source byte ceiling rather than the injection budget.
 */
export const PI_MEMORY_SUMMARY_SOURCE_MAX_TOKENS =
  PI_MEMORY_SUMMARY_MAX_BYTES / PI_MEMORY_SUMMARY_MIN_TOKEN_BYTES;
export const PI_SKILLS_ROOT = `${PI_AGENT_DIR}/skills`;
export const PI_API_FIRST_TURN_SESSION_MAX_BYTES = 16 * 1024 * 1024;

export const piSessionCheckpointSchema = z
  .object({
    sessionId: z.uuid(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  })
  .strict()
  .readonly();

const piResourceSnapshotAgentsFilesSchema = z
  .array(
    z
      .object({
        path: z.string().startsWith("/"),
        content: z.string(),
      })
      .strict()
      .readonly(),
  )
  .readonly();

const piResourceSnapshotSkillsSchema = z
  .array(
    z
      .object({
        name: z.string().min(1),
        description: z.string().min(1),
        filePath: z.string().startsWith("/"),
        baseDir: z.string().startsWith("/"),
        scope: z.enum(["user", "project", "temporary"]),
        disableModelInvocation: z.boolean(),
      })
      .strict()
      .readonly(),
  )
  .readonly();

const piMemoryRecallIdentityShape = {
  memoryStorageId: z.string().min(1),
  storageVersionId: z.string().min(1),
};

export const piMemoryRecallSelectionSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...piMemoryRecallIdentityShape,
      status: z.literal("no-content"),
    })
    .strict()
    .readonly(),
  z
    .object({
      ...piMemoryRecallIdentityShape,
      status: z.literal("ready"),
      content: z.string().min(1).max(PI_MEMORY_SUMMARY_MAX_BYTES),
      sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
      sourceSize: z.number().int().positive().max(PI_MEMORY_SUMMARY_MAX_BYTES),
      // Exact o200k token count of the full source, not of the injected excerpt.
      tokenCount: z
        .number()
        .int()
        .positive()
        .max(PI_MEMORY_SUMMARY_SOURCE_MAX_TOKENS),
    })
    .strict()
    .readonly(),
]);

const piResourceSnapshotV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    agentsFiles: piResourceSnapshotAgentsFilesSchema,
    skills: piResourceSnapshotSkillsSchema,
  })
  .strict()
  .readonly();

const piResourceSnapshotV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    agentsFiles: piResourceSnapshotAgentsFilesSchema,
    skills: piResourceSnapshotSkillsSchema,
    memoryRecall: piMemoryRecallSelectionSchema,
  })
  .strict()
  .readonly();

export const piResourceSnapshotSchema = z.discriminatedUnion("schemaVersion", [
  piResourceSnapshotV1Schema,
  piResourceSnapshotV2Schema,
]);

export const piLangfuseParentSchema = z
  .object({
    traceId: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .refine((value) => {
        return !/^0+$/.test(value);
      }, "Trace ID must be non-zero"),
    spanId: z
      .string()
      .regex(/^[a-f0-9]{16}$/)
      .refine((value) => {
        return !/^0+$/.test(value);
      }, "Span ID must be non-zero"),
    traceFlags: z.literal(1),
    sessionId: z.uuid(),
    sandboxWaitStartedAt: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();

const piApiFirstTurnSessionSchema = z
  .object({
    sessionId: z.uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    rawSize: z
      .number()
      .int()
      .positive()
      .max(PI_API_FIRST_TURN_SESSION_MAX_BYTES),
  })
  .strict()
  .readonly();

const piSandboxEventSequenceStartSchema = eventSequenceNumberSchema.min(1);

const piApiFirstTurnOwnershipTransferManifestShape = {
  schemaVersion: z.literal(3),
  outcome: z.literal("ownership-transfer"),
  baseSession: piSessionCheckpointSchema,
  session: piApiFirstTurnSessionSchema,
  sandboxEventSequenceStart: piSandboxEventSequenceStartSchema,
  langfuseParent: piLangfuseParentSchema.optional(),
};

export const piApiFirstTurnOwnershipTransferModeSchema = z.enum([
  "sandbox-first",
  "pending-tool-continuation",
  "settled-session-continuation",
]);

const piApiFirstTurnManifestV3Schema = z.discriminatedUnion("mode", [
  z
    .object({
      ...piApiFirstTurnOwnershipTransferManifestShape,
      mode: z.literal("sandbox-first"),
    })
    .strict()
    .readonly(),
  z
    .object({
      ...piApiFirstTurnOwnershipTransferManifestShape,
      mode: z.literal("pending-tool-continuation"),
    })
    .strict()
    .readonly(),
  z
    .object({
      ...piApiFirstTurnOwnershipTransferManifestShape,
      mode: z.literal("settled-session-continuation"),
    })
    .strict()
    .readonly(),
]);

// Large H0 checkpoints bypass API materialization. The sandbox verifies the
// original blob before starting the turn; API-produced H1 stays bounded at 16 MiB.
export const piApiFirstTurnManifestSchema = z.union([
  piApiFirstTurnManifestV3Schema,
  z
    .object({
      ...piApiFirstTurnOwnershipTransferManifestShape,
      schemaVersion: z.literal(4),
      mode: z.literal("sandbox-first"),
      session: piApiFirstTurnSessionSchema
        .unwrap()
        .extend({
          rawSize: z
            .number()
            .int()
            .positive()
            .max(RESUME_SESSION_HISTORY_MAX_BYTES),
        })
        .readonly(),
      history: z
        .object({
          url: z.url(),
          encoding: sessionHistoryEncodingSchema,
          encodedSize: z
            .number()
            .int()
            .positive()
            .max(RESUME_SESSION_HISTORY_MAX_BYTES),
        })
        .strict()
        .readonly(),
    })
    .strict()
    .readonly(),
]);

export const piApiFirstTurnConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    resourceSnapshotDigest: z.string().regex(/^[a-f0-9]{64}$/),
    manifestUrl: z.url(),
    sessionUrl: z.url(),
    deadlineAt: z.number().int().positive(),
    baseSession: piSessionCheckpointSchema,
    sandboxEventSequenceStart: piSandboxEventSequenceStartSchema,
  })
  .strict()
  .readonly();

/** Reader capability is advertised in a header ignored by previous APIs. */
export const PI_DEFERRED_SANDBOX_HEADER = "X-Pi-Deferred-Sandbox";
export const piDeferredSandboxConfigSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    ownerEpoch: z.number().int().positive(),
    generation: z.number().int().positive(),
    deadlineAt: z.number().int().positive(),
    resourceSnapshotDigest: z.string().regex(/^[a-f0-9]{64}$/),
    baseSession: piSessionCheckpointSchema,
    sandboxEventSequenceStart: piSandboxEventSequenceStartSchema,
    continuation: piSandboxContinuationSchema,
    runId: z.uuid(),
    historyHash: z.string().regex(/^[a-f0-9]{64}$/),
    activeInput: z.boolean(),
  })
  .readonly();
export const piDeferredHandoffDataSchema = z.strictObject({
  sessionHistory: z.string().max(PI_API_FIRST_TURN_SESSION_MAX_BYTES),
  resourceSnapshot: piResourceSnapshotSchema,
});
export const piDeferredHandoffChunkSchema = z.strictObject({
  chunk: z.string().max(1_400_000),
  nextOffset: z
    .number()
    .int()
    .nonnegative()
    .max(32 * 1024 * 1024)
    .nullable(),
});
export type PiDeferredSandboxConfig = z.infer<
  typeof piDeferredSandboxConfigSchema
>;

/**
 * Non-secret Pi model metadata forwarded to the Sandbox. `apiKeyEnv` names the
 * runtime environment entry used by the Sandbox, while `credentialSecretName`
 * names the API-owned encrypted secret that backs that entry.
 */

export const piModelConfigLegacySchema = z
  .object({
    provider: z.enum([
      "deepseek",
      "moonshotai",
      "openai",
      "openrouter",
      "vercel-ai-gateway",
      "codex",
    ]),
    baseUrl: z.url(),
    // Request identity can differ from the trusted Pi catalog entry for an
    // organization-configured model provider gateway.
    model: z.string().min(1),
    catalogModel: z.string().min(1).optional(),
    thinkingLevel: z
      .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
      .optional(),
    // Per-run provider request policy. This is not Pi session identity or
    // persisted Pi JSONL metadata.
    serviceTier: z.enum(["priority"]).optional(),
    apiKeyEnv: z.enum([
      "ANTHROPIC_AUTH_TOKEN",
      "OPENAI_API_KEY",
      "CHATGPT_ACCESS_TOKEN",
    ]),
    credentialSecretName: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    // Non-secret gateway request policy. The credential itself remains in the
    // encrypted secret named above and is resolved only at an execution edge.
    credentialHeader: piCredentialHeaderSchema.optional(),
  })
  .strict()
  .readonly();

const piApiKeyCredentialSecretNameSchema = z.enum([
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "VERCEL_AI_GATEWAY_API_KEY",
  "OKOU_MODEL_PROVIDER_API_KEY",
]);

const piModelCredentialBindingSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("api-key"),
      environment: z.enum(["OPENAI_API_KEY"]),
      secretName: piApiKeyCredentialSecretNameSchema,
      credentialHeader: piCredentialHeaderSchema.optional(),
    })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal("access-token"),
      environment: z.enum(["CHATGPT_ACCESS_TOKEN"]),
      secretName: z.enum(["CHATGPT_ACCESS_TOKEN"]),
    })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal("account-id"),
      environment: z.enum(["CHATGPT_ACCOUNT_ID"]),
      secretName: z.enum(["CHATGPT_ACCOUNT_ID"]),
    })
    .strict()
    .readonly(),
]);

/**
 * Shared strict route invariants. Generations are separate wire contracts;
 * adding a reader must not move existing writers to a newer generation.
 */
const piModelConfigVersionedSchema = z
  .object({
    schemaVersion: z.union([
      z.literal(PI_MODEL_CONFIG_CURRENT_GENERATION),
      z.literal(PI_MODEL_CONFIG_DIALECT_TIER_GENERATION),
    ]),
    dialect: z.enum(["openai-responses", "openai-codex-responses"]),
    transport: z.literal("sse"),
    provider: z.enum(["deepseek", "openai", "openrouter", "openai-codex"]),
    baseUrl: z.url(),
    model: z.string().min(1).max(512),
    catalogModel: z.string().min(1).max(512).optional(),
    thinkingLevel: z
      .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
      .optional(),
    serviceTier: z.enum(["priority", "fast"]).optional(),
    credentialBindings: z.array(piModelCredentialBindingSchema).min(1).max(2),
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
    schemaVersion: z.literal(PI_MODEL_CONFIG_CURRENT_GENERATION),
    serviceTier: z.enum(["priority"]).optional(),
  })
  .readonly();

/** Additive reader capability only; route writers activate separately in #31803. */
export const piModelConfigV3Schema = z
  .discriminatedUnion("dialect", [
    piModelConfigVersionedSchema.safeExtend({
      schemaVersion: z.literal(PI_MODEL_CONFIG_DIALECT_TIER_GENERATION),
      dialect: z.literal("openai-responses"),
      transport: z.enum(["sse"]),
      provider: z.enum(["deepseek", "openai", "openrouter"]),
      serviceTier: z.enum(["priority"]).optional(),
    }),
    piModelConfigVersionedSchema.safeExtend({
      schemaVersion: z.literal(PI_MODEL_CONFIG_DIALECT_TIER_GENERATION),
      dialect: z.literal("openai-codex-responses"),
      transport: z.enum(["sse"]),
      provider: z.enum(["openai-codex"]),
      serviceTier: z.enum(["fast"]).optional(),
    }),
  ])
  .readonly();

export const piModelConfigSchema = z.union([
  piModelConfigLegacySchema,
  piModelConfigV2Schema,
  piModelConfigV3Schema,
  piModelConfigV4Schema,
]);

const lowercaseSha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const piMemoryPhase2MaintenanceCandidateSchema = z
  .object({
    piSessionId: z.string().min(1).max(255),
    sourceRunId: z.uuid(),
    sourceHistoryHash: lowercaseSha256Schema,
    sourceCompletedAt: z.string().datetime({ offset: true }),
    rawMemory: z.string(),
    rolloutSummary: z.string(),
    rolloutSlug: z.string().max(255).nullable(),
  })
  .strict()
  .readonly();

/**
 * Authenticated private input for one non-interactive Pi memory maintenance
 * run. The runner forwards this object only through the Pi launch config and
 * the guest writes it to the existing 0600 launch-payload file.
 */
export const piMemoryPhase2MaintenanceSchema = z
  .object({
    schemaVersion: z.literal(1),
    memoryStorageId: z.uuid(),
    claimedRevision: z.number().int().positive(),
    claimedBaseVersionId: lowercaseSha256Schema,
    leaseToken: z.uuid(),
    selectionDigest: lowercaseSha256Schema,
    selected: z
      .array(piMemoryPhase2MaintenanceCandidateSchema)
      .max(PI_MEMORY_PHASE2_MAINTENANCE_MAX_SELECTED_CANDIDATES),
  })
  .strict()
  .superRefine((maintenance, refinement) => {
    const sessionIds = new Set<string>();
    let selectedUtf8Bytes = 0;
    for (const [index, candidate] of maintenance.selected.entries()) {
      if (sessionIds.has(candidate.piSessionId)) {
        refinement.addIssue({
          code: "custom",
          path: ["selected", index, "piSessionId"],
          message: "Pi memory maintenance session ids must be unique",
        });
      }
      sessionIds.add(candidate.piSessionId);
      selectedUtf8Bytes += new TextEncoder().encode(
        `${candidate.rawMemory}${candidate.rolloutSummary}${candidate.rolloutSlug ?? ""}`,
      ).length;
    }
    if (
      selectedUtf8Bytes > PI_MEMORY_PHASE2_MAINTENANCE_MAX_SELECTED_UTF8_BYTES
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["selected"],
        message: "Pi memory maintenance selection exceeds its byte bound",
      });
    }
  })
  .readonly();

/**
 * Version marker for the sandbox Pi launch contract. Runtime resources are
 * discovered from Pi's canonical filesystem locations by the official loader.
 */
export const piLaunchConfigSchema = z
  .object({
    schemaVersion: z.literal(2),
    apiFirstTurn: z.union([
      piApiFirstTurnConfigSchema,
      piDeferredSandboxConfigSchema,
    ]),
    memoryRecall: piMemoryRecallSelectionSchema.optional(),
    maintenance: piMemoryPhase2MaintenanceSchema.optional(),
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
export const piLaunchPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    appendSystemPrompt: z.string().nullable(),
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
  refinement: z.RefinementCtx,
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
const storedExecutionContextObjectSchema = z.object({
  storageMounts: z
    .array(storedStorageMountEntrySchema)
    .superRefine(uniqueStorageMountPaths),
  environment: z.record(z.string(), z.string()).nullable(),
  platformEnvironment: z.record(z.string(), z.string()),
  // API-only references used to reconstruct runner masking values from the
  // effective stored agent environment. Null means no persistent secret map, and array
  // order/repetition follows secret-map values.
  // This field must not be included in the runner-facing ExecutionContext.
  secretValueEnvironmentKeys: z.array(z.string()).nullable(),
  // Connector-owned runtime vars used by proxy/firewall template resolution.
  // User-provided run vars stay in agent_runs.vars and are merged at claim time.
  vars: z.record(z.string(), z.string()).nullable().optional(),
  resumeSession: storedResumeSessionSchema.nullable(),
  // AES-256-GCM encrypted Record<string, string>. Keys are the runtime secret
  // names used by `${{ secrets.NAME }}`; connector/model-provider keys are env
  // aliases, not backing storage secret names.
  encryptedSecrets: z.string().nullable(),
  // Maps firewall auth secret env aliases (the `NAME` in `${{ secrets.NAME }}`) to
  // their connector or provider owner. Keys are env aliases, not storage secret names.
  secretConnectorMap: z.record(z.string(), z.string()).nullable().optional(),
  // Same keys as secretConnectorMap; adds source details when the owner alone
  // is not enough to locate access storage (for example, personal model providers).
  secretConnectorMetadataMap: secretConnectorMetadataMapSchema
    .nullable()
    .optional(),
  cliAgentType: z.string(),
  // Preview evaluation escape hatch: bypass preview mock CLIs and use the real
  // agent runtime.
  realAgentInPreview: z.boolean().optional(),
  // Capture HTTP header names, selected safe header values, request bodies, and response bodies
  // in network logs
  captureNetworkBodies: z.boolean().optional(),
  // Dispatch timestamp for E2E timing metrics, as Unix epoch milliseconds
  apiStartTime: apiStartTimeSchema.optional(),
  // User's timezone preference (IANA format, e.g., "Asia/Shanghai")
  userTimezone: z.string().optional(),
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
  // API-only catalog-derived permission defaults for claim-time grant refresh.
  connectorPermissionBaseline:
    storedConnectorPermissionBaselineSchema.optional(),
  // Tools to disable in Claude CLI (passed as --disallowed-tools)
  disallowedTools: z.array(z.string()).optional(),
  // Tools to make available in Claude CLI (passed as --tools)
  tools: z.array(z.string()).optional(),
  // Settings JSON to pass to Claude CLI (passed as --settings)
  settings: z.string().optional(),
  // Feature flags evaluated at job creation time (all switch states for user/org)
  featureFlags: z.record(z.string(), z.boolean()).optional(),
  billableFirewalls: z.array(z.string()).optional(),
  // Canonical model id the proxy reports for model token usage. The API uses
  // this model id for built-in billing rows; billing eligibility is decided
  // from API-owned run context.
  modelUsageProvider: z.string().optional(),
  // API-owned Codex provider/runtime metadata forwarded through the runner.
  codexRuntimeConfig: modelProviderCodexRuntimeConfigSchema
    .nullable()
    .optional(),
  // Pi runs use the API first-turn slot and can continue through an explicit
  // Sandbox tool handoff. This state is a single hard-cut protocol bundle.
  piSessionId: z.uuid().optional(),
  piLaunchConfig: piLaunchConfigSchema.optional(),
  piModelConfig: piModelConfigSchema.optional(),
});

export const storedExecutionContextSchema =
  storedExecutionContextObjectSchema.superRefine(requireCompletePiFields);

/**
 * Tolerant reader for execution contexts already persisted in a database or
 * encrypted queue payload. The optional baseline is derived performance data,
 * so malformed or future versions must remain an independent cache miss rather
 * than invalidating the complete queued execution context.
 */
export const compatibleStoredExecutionContextSchema =
  storedExecutionContextObjectSchema
    .extend({
      connectorPermissionBaseline: z.unknown().optional(),
    })
    .superRefine(requireCompletePiFields);

/**
 * Claim-time reader that inspects Pi generation support before decoding the
 * generation-specific route. Other stored-context readers remain fully typed.
 */
export const claimCompatibleStoredExecutionContextSchema =
  storedExecutionContextObjectSchema
    .extend({
      connectorPermissionBaseline: z.unknown().optional(),
      piModelConfig: z.unknown().optional(),
    })
    .superRefine(requireCompletePiFields);

/**
 * Execution context returned when claiming a job.
 *
 * This is the canonical producer schema. The runner's `ExecutionContext` is a
 * tolerant consumer projection and intentionally does not mirror every field.
 * See `crates/runner/src/types.rs`.
 */
const executionContextObjectSchema = z.object({
  runId: z.uuid(),
  reuseKey: z.string().nullable().optional(),
  prompt: z.string(),
  appendSystemPrompt: z.string().nullable(),
  vars: z.record(z.string(), z.string()).nullable(),
  sandboxToken: z.string(),
  storageManifest: storageManifestSchema.nullable(),
  environment: z.record(z.string(), z.string()).nullable(),
  platformEnvironment: z.record(z.string(), z.string()),
  resumeSession: resumeSessionSchema.nullable(),
  // Plain secret values used by the runner for redaction. These are values, not
  // names, and are base64-encoded only when exported through OKOU_SECRET_VALUES.
  secretValues: z.array(z.string()).nullable(),
  // AES-256-GCM encrypted Record<string, string>, passed through to mitm-addon
  // for auth resolution. Keys are runtime secret names used by
  // `${{ secrets.NAME }}`; connector/model-provider keys are env aliases, not
  // backing storage secret names.
  encryptedSecrets: z.string().nullable(),
  // Maps firewall auth secret env aliases (the `NAME` in `${{ secrets.NAME }}`) to
  // their connector or provider owner. Keys are env aliases, not storage secret names.
  secretConnectorMap: z.record(z.string(), z.string()).nullable().optional(),
  // Same keys as secretConnectorMap; adds source details when the owner alone
  // is not enough to locate access storage (for example, personal model providers).
  secretConnectorMetadataMap: secretConnectorMetadataMapSchema
    .nullable()
    .optional(),
  cliAgentType: z.string(),
  // Preview evaluation escape hatch: bypass preview mock CLIs and use the real
  // agent runtime.
  realAgentInPreview: z.boolean().optional(),
  // Capture HTTP header names, selected safe header values, request bodies, and response bodies
  // in network logs
  captureNetworkBodies: z.boolean().optional(),
  // Dispatch timestamp for E2E timing metrics, as Unix epoch milliseconds
  apiStartTime: apiStartTimeSchema.optional(),
  // User's timezone preference (IANA format, e.g., "Asia/Shanghai")
  userTimezone: z.string().optional(),
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
  disallowedTools: z.array(z.string()).optional(),
  // Tools to make available in Claude CLI (passed as --tools)
  tools: z.array(z.string()).optional(),
  // Settings JSON to pass to Claude CLI (passed as --settings)
  settings: z.string().optional(),
  // Feature flags evaluated at job creation time (all switch states for user/org)
  featureFlags: z.record(z.string(), z.boolean()).optional(),
  billableFirewalls: z.array(z.string()).optional(),
  // Canonical model id the proxy reports for model token usage. The API uses
  // this model id for built-in billing rows; billing eligibility is decided
  // from API-owned run context.
  modelUsageProvider: z.string().optional(),
  // API-owned Codex provider/runtime metadata forwarded through the runner.
  codexRuntimeConfig: modelProviderCodexRuntimeConfigSchema
    .nullable()
    .optional(),
  piSessionId: z.uuid().optional(),
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
  handoff: {
    method: "GET",
    path: "/api/runners/jobs/:id/pi-handoff/:offset",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.uuid(),
      offset: z.string().regex(/^[0-9]{1,8}$/u),
    }),
    responses: {
      200: piDeferredHandoffChunkSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary:
      "Read bounded immutable continuation bytes for the current Sandbox owner",
  },
  release: {
    method: "POST",
    path: "/api/runners/jobs/:id/release",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.uuid() }),
    body: z.discriminatedUnion("proof", [
      z.strictObject({
        runnerId: z.uuid(),
        ownerEpoch: z.number().int().positive(),
        generation: z.number().int().positive(),
        proof: z.literal("destroyed"),
      }),
      z.strictObject({
        runnerId: z.uuid(),
        heartbeatGeneration: z.number().int().positive(),
        ownerEpoch: z.number().int().positive(),
        generation: z.number().int().positive(),
        proof: z.literal("process-absent"),
      }),
      z.strictObject({
        runnerId: z.uuid(),
        heartbeatGeneration: z.number().int().positive(),
        proof: z.literal("not-started"),
      }),
    ]),
    responses: {
      // `released` stays the legacy boolean an older Runner reads. `outcome`
      // additionally separates a definitive `stale` acknowledgement from an
      // `inconclusive` cleanup whose obligation a capable Runner must retry.
      200: z.object({
        released: z.boolean(),
        outcome: z.enum(["released", "stale", "inconclusive"]),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Record a physically destroyed deferred Pi Sandbox",
  },
  claim: {
    method: "POST",
    path: "/api/runners/jobs/:id/claim",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.uuid(),
    }),
    body: z.object({
      runnerIdentity: runnerProcessIdentitySchema.optional(),
      runnerHostname: runnerHostnameSchema.optional(),
      capabilities: runnerClaimCapabilitiesSchema,
      telemetry: runnerClaimTelemetrySchema.optional(),
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

export const runnerCancellationModeSchema = z.enum(["cooperative", "hard"]);
export type RunnerCancellationMode = z.infer<
  typeof runnerCancellationModeSchema
>;

const runCancellationIdentitySchema = z.object({
  protocolVersion: z.literal(1),
  runId: z.uuid(),
});

export const runnerCancellationResponseSchema = z.discriminatedUnion("state", [
  runCancellationIdentitySchema
    .extend({
      state: z.literal("present"),
      mode: runnerCancellationModeSchema.nullable(),
    })
    .strict(),
  runCancellationIdentitySchema.extend({ state: z.literal("gone") }).strict(),
  runCancellationIdentitySchema
    .extend({ state: z.literal("unavailable") })
    .strict(),
]);
export type RunnerCancellationResponse = z.infer<
  typeof runnerCancellationResponseSchema
>;

export const runnersCancellationContract = c.router({
  get: {
    method: "GET",
    path: "/api/runners/runs/:runId/cancellation",
    headers: authHeadersSchema,
    pathParams: z.object({ runId: z.uuid() }),
    query: z
      .object({
        runnerGroup: runnerGroupSchema,
        runnerId: z.uuid(),
        heartbeatGeneration: z.coerce
          .number()
          .pipe(runnerHeartbeatGenerationSchema),
      })
      .strict(),
    responses: {
      200: runnerCancellationResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Read the stop intent or confirmed absence of a claimed Run",
  },
});

export const runnersModelProviderFailuresContract = c.router({
  report: {
    method: "POST",
    path: "/api/runners/runs/:runId/model-provider-failures",
    headers: authHeadersSchema,
    pathParams: z.object({
      runId: z.uuid(),
    }),
    body: z.discriminatedUnion("failureKind", [
      z
        .object({
          failureKind: z.literal("authentication"),
          retryAfterSeconds: builtInModelProviderRetryAfterSecondsSchema,
        })
        .strict(),
      z
        .object({
          failureKind: z.literal("billing"),
          retryAfterSeconds: builtInModelProviderRetryAfterSecondsSchema,
        })
        .strict(),
      z
        .object({
          failureKind: z.literal("rate_limit"),
          retryAfterSeconds: builtInModelProviderRetryAfterSecondsSchema,
        })
        .strict(),
      z
        .object({
          failureKind: z.literal("provider_unavailable"),
          retryAfterSeconds: builtInModelProviderRetryAfterSecondsSchema,
        })
        .strict(),
      z
        .object({
          failureKind: z.literal("timeout"),
          retryAfterSeconds: builtInModelProviderRetryAfterSecondsSchema,
        })
        .strict(),
      z
        .object({
          failureKind: z.literal("connection"),
          connectionSource: builtInModelProviderConnectionSourceSchema,
          retryAfterSeconds: builtInModelProviderRetryAfterSecondsSchema,
        })
        .strict(),
    ]),
    responses: {
      200: z
        .object({
          outcome: z.enum(["recorded", "observed", "ignored"]),
        })
        .strict(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Report a built-in model provider failure for a run",
  },
});

const activeInputDeliveryReferenceSchema = z.object({
  deliveryId: z.uuid(),
  eventIds: z.array(z.uuid()).length(1),
});

export const activeInputDeliveryReserveResponseSchema = z.discriminatedUnion(
  "outcome",
  [
    activeInputDeliveryReferenceSchema.extend({
      outcome: z.literal("reserved"),
      prompt: z.string().min(1),
    }),
    z.object({ outcome: z.literal("empty") }),
    z.object({ outcome: z.literal("terminal") }),
    activeInputDeliveryReferenceSchema.extend({
      outcome: z.literal("held"),
    }),
    z.object({
      outcome: z.literal("rejected"),
      reason: z.enum(["payload_too_large", "run_not_running"]),
    }),
  ],
);

export const activeInputDeliveryReceiptResponseSchema = z.discriminatedUnion(
  "outcome",
  [
    z.object({ outcome: z.literal("delivered") }),
    z.object({ outcome: z.literal("rejected") }),
  ],
);

export const runnersActiveInputsContract = c.router({
  reserve: {
    method: "POST",
    path: "/api/runners/runs/:runId/active-inputs/reserve",
    headers: authHeadersSchema,
    pathParams: z.object({
      runId: z.uuid(),
    }),
    body: z.object({}),
    responses: {
      200: activeInputDeliveryReserveResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Reserve or retrieve pending active input for a run",
  },
  receipt: {
    method: "POST",
    path: "/api/runners/runs/:runId/active-inputs/deliveries/:deliveryId/receipt",
    headers: authHeadersSchema,
    pathParams: z.object({
      runId: z.uuid(),
      deliveryId: z.uuid(),
    }),
    body: z.object({}),
    responses: {
      200: activeInputDeliveryReceiptResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Record acceptance of an active-input delivery",
  },
});

export const runnersConnectorRuntimeSyncContract = c.router({
  sync: {
    method: "POST",
    path: "/api/runners/runs/:runId/connector-runtime/sync",
    headers: authHeadersSchema,
    pathParams: z.object({
      runId: z.uuid(),
    }),
    body: z.object({
      targets: connectorRuntimeSyncTargetsSchema,
    }),
    responses: {
      200: z.object({
        results: z.array(connectorRuntimeSyncResultSchema),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema.extend({
        error: apiErrorSchema.shape.error.extend({
          code: z.literal(CONNECTOR_RUNTIME_SYNC_RUN_TERMINAL_ERROR_CODE),
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

/**
 * Runner heartbeat body — periodic state report from each runner
 */
export const heartbeatBodySchema = z
  .object({
    runnerId: z.uuid(),
    group: runnerGroupSchema,
    snapshotGeneration: runnerHeartbeatGenerationSchema,
    snapshotSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    totalVcpu: z.number().int().nonnegative(),
    totalMemoryMb: z.number().int().nonnegative(),
    maxConcurrent: z.number().int().nonnegative(),
    allocatedVcpu: z.number().int().nonnegative(),
    allocatedMemoryMb: z.number().int().nonnegative(),
    runningCount: z.number().int().nonnegative(),
    admittableProfiles: runnerProfileListSchema,
    heldSandboxStates: z.array(heldSandboxStateSchema).max(1024),
    heldWorkspaceStates: z.array(heldWorkspaceStateSchema).max(1024),
    mode: z.enum(["starting", "running", "draining", "stopping"]),
  })
  .superRefine((heartbeat, ctx) => {
    const workspaceCacheCount = heartbeat.heldWorkspaceStates.reduce(
      (count, state) => {
        return count + state.workspaceCaches.length;
      },
      0,
    );
    if (workspaceCacheCount <= 1024) {
      return;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["heldWorkspaceStates"],
      message: "heartbeat may contain at most 1024 workspace caches",
    });
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
      200: z.object({ ok: z.literal(true) }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Report runner heartbeat with capacity and state",
  },
});

export type RunnersPollContract = typeof runnersPollContract;
export type RunnersJobClaimContract = typeof runnersJobClaimContract;
export type RunnersModelProviderFailuresContract =
  typeof runnersModelProviderFailuresContract;
export type RunnersActiveInputsContract = typeof runnersActiveInputsContract;
export type RunnersConnectorRuntimeSyncContract =
  typeof runnersConnectorRuntimeSyncContract;
export type RunnersHeartbeatContract = typeof runnersHeartbeatContract;
export type RunnersBuiltinFirewallsResolveContract =
  typeof runnersBuiltinFirewallsResolveContract;
export type Job = z.infer<typeof jobSchema>;
export type RunnerPreference = z.infer<typeof runnerPreferenceSchema>;
export type RunnerPreferenceClaimState = z.infer<
  typeof runnerPreferenceClaimStateSchema
>;
export type HeldSandboxState = z.infer<typeof heldSandboxStateSchema>;
export type HeldWorkspaceState = z.infer<typeof heldWorkspaceStateSchema>;
export type ExecutionContext = z.infer<typeof executionContextSchema>;
export type StoredExecutionContext = z.infer<
  typeof storedExecutionContextSchema
>;
export type PiModelConfig = z.infer<typeof piModelConfigSchema>;
export type PiModelConfigLegacy = z.infer<typeof piModelConfigLegacySchema>;
export type PiModelConfigV2 = z.infer<typeof piModelConfigV2Schema>;
export type PiModelConfigV3 = z.infer<typeof piModelConfigV3Schema>;
export type PiModelCredentialBinding = z.infer<
  typeof piModelCredentialBindingSchema
>;
export type RunnerClaimCapabilities = z.infer<
  typeof runnerClaimCapabilitiesSchema
>;
export type PiLaunchConfig = z.infer<typeof piLaunchConfigSchema>;
export type PiMemoryPhase2Maintenance = z.infer<
  typeof piMemoryPhase2MaintenanceSchema
>;
export type PiMemoryRecallSelection = z.infer<
  typeof piMemoryRecallSelectionSchema
>;
export type PiApiFirstTurnConfig = z.infer<typeof piApiFirstTurnConfigSchema>;
export type PiApiFirstTurnOwnershipTransferMode = z.infer<
  typeof piApiFirstTurnOwnershipTransferModeSchema
>;
export type PiLangfuseParent = z.infer<typeof piLangfuseParentSchema>;
export type PiApiFirstTurnManifest = z.infer<
  typeof piApiFirstTurnManifestSchema
>;
export type PiResourceSnapshot = z.infer<typeof piResourceSnapshotSchema>;
export type PiLaunchPayload = z.infer<typeof piLaunchPayloadSchema>;
export type CompatibleStoredExecutionContext = z.infer<
  typeof compatibleStoredExecutionContextSchema
>;
export type ClaimCompatibleStoredExecutionContext = z.infer<
  typeof claimCompatibleStoredExecutionContextSchema
>;
export type StoredConnectorPermissionBaseline = z.infer<
  typeof storedConnectorPermissionBaselineSchema
>;
export type NetworkPolicyRefresh = z.infer<typeof networkPolicyRefreshSchema>;
export type ConnectorRuntimeTarget = z.infer<
  typeof connectorRuntimeTargetSchema
>;
export type ConnectorRuntimeTargetRegistration = z.infer<
  typeof connectorRuntimeTargetRegistrationSchema
>;
export type AgentRunConnectorDiagnosticRegistrationPayload = z.infer<
  typeof agentRunConnectorDiagnosticRegistrationPayloadSchema
>;
export type ConnectorRuntimeCustomUnresolvedReason = z.infer<
  typeof connectorRuntimeCustomUnresolvedReasonSchema
>;
export type ConnectorRuntimeCustomAbsentReason = z.infer<
  typeof connectorRuntimeCustomAbsentReasonSchema
>;
export type ConnectorRuntimeSyncResult = z.infer<
  typeof connectorRuntimeSyncResultSchema
>;
export type RunnerBuiltinFirewallsResolveBody = z.infer<
  typeof runnerBuiltinFirewallsResolveBodySchema
>;
export type RunnerBuiltinFirewallsResolveResponse = z.infer<
  typeof runnerBuiltinFirewallsResolveResponseSchema
>;
export type SecretConnectorMetadata = z.infer<
  typeof secretConnectorMetadataSchema
>;
export type StorageMountEntry = z.infer<typeof storageMountEntrySchema>;
export type StoredStorageMountEntry = z.infer<
  typeof storedStorageMountEntrySchema
>;
export type StorageManifest = z.infer<typeof storageManifestSchema>;
export type CanonicalStorageManifest = StorageManifest;
export type StoredResumeSession = z.infer<typeof storedResumeSessionSchema>;
export type ResumeSession = z.infer<typeof resumeSessionSchema>;
export type SessionHistoryDownloadSource = z.infer<
  typeof sessionHistoryDownloadSourceSchema
>;
export type SessionHistorySizeBucket = z.infer<
  typeof sessionHistorySizeBucketSchema
>;
