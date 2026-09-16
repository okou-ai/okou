import { z } from "zod";
import { unifiedRunRequestSchema } from "@okouai/api-contracts/contracts/runs";
import { connectorSlugSchema } from "@okouai/api-contracts/contracts/connector-identity";
import { agentCustomConnectorGrantSchema } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import { BUILT_IN_MODEL_ROUTE_PROVIDERS } from "@okouai/api-contracts/contracts/model-providers";
import { reasoningEffortSchema } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { knownRunFailureReasonSchema } from "@okouai/api-contracts/contracts/run-failure-reasons";
import { piMemoryCitationSchema } from "@okouai/api-contracts/contracts/pi-memory-citations";
import {
  PI_API_FIRST_TURN_SESSION_MAX_BYTES,
  piMemoryPhase2MaintenanceSchema,
  piMemoryRecallSelectionSchema,
  piResourceSnapshotSchema,
  piSessionCheckpointSchema,
  piModelConfigSchema,
  secretConnectorMetadataMapSchema,
  type PiResourceSnapshot,
} from "@okouai/api-contracts/contracts/runners";

/**
 * One executable handoff size contract, shared by object publication, demand
 * admission, materialization, the chunk API and the CLI reader.
 *
 * `PI_DEFERRED_HISTORY_MAX_BYTES` is the reader's own session ceiling, measured
 * in UTF-8 bytes rather than UTF-16 code units so a multibyte history cannot
 * pass a `z.string().max(...)` length check and then overflow the reader.
 * `PI_DEFERRED_HANDOFF_MAX_BYTES` bounds the serialized aggregate the chunk API
 * streams, which individually valid objects can otherwise exceed together.
 */
const PI_DEFERRED_HISTORY_MAX_BYTES = PI_API_FIRST_TURN_SESSION_MAX_BYTES;
export const PI_DEFERRED_HANDOFF_MAX_BYTES = 32 * 1024 * 1024;

const sessionHistorySchema = z.string().refine((history) => {
  return Buffer.byteLength(history, "utf8") <= PI_DEFERRED_HISTORY_MAX_BYTES;
}, "Pi durable session history exceeds its shared UTF-8 limit");

/** The exact bytes the chunk API streams and the CLI reassembles. */
export function serializeDeferredHandoff(data: {
  readonly sessionHistory: string;
  readonly resourceSnapshot: PiResourceSnapshot;
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      sessionHistory: data.sessionHistory,
      resourceSnapshot: data.resourceSnapshot,
    }),
  );
}

/** Thrown before a continuation can become an executable job. */
export class PiDeferredHandoffUnsupportedError extends Error {}

/** Validate as early as both inputs exist: history first, then the aggregate. */
export function assertDeferredHandoffWithinLimits(data: {
  readonly sessionHistory: string;
  readonly resourceSnapshot: PiResourceSnapshot;
}): void {
  const history = Buffer.byteLength(data.sessionHistory, "utf8");
  if (history > PI_DEFERRED_HISTORY_MAX_BYTES) {
    throw new PiDeferredHandoffUnsupportedError(
      `Pi durable session history is ${history} bytes, above the supported ${PI_DEFERRED_HISTORY_MAX_BYTES}`,
    );
  }
  const serialized = serializeDeferredHandoff(data).length;
  if (serialized > PI_DEFERRED_HANDOFF_MAX_BYTES) {
    throw new PiDeferredHandoffUnsupportedError(
      `Pi durable handoff is ${serialized} serialized bytes, above the supported ${PI_DEFERRED_HANDOFF_MAX_BYTES}`,
    );
  }
}

const definition = z.strictObject({
  framework: z.string().optional(),
  instructions: z.string().optional(),
  environment: z.record(z.string(), z.string()).optional(),
  volumes: z.array(z.string()).optional(),
  experimental_runner: z
    .strictObject({ group: z.string().optional() })
    .optional(),
  experimental_profile: z.string().optional(),
});
const executionConfig = z.strictObject({
  version: z.string().optional(),
  agent: definition.optional(),
  agents: z.record(z.string(), definition).optional(),
  artifacts: z
    .array(
      z.strictObject({
        name: z.string(),
        version: z.string().optional(),
        mount_path: z.string().optional(),
      }),
    )
    .optional(),
  volumes: z
    .record(
      z.string(),
      z.strictObject({
        name: z.string(),
        version: z.string(),
        optional: z.boolean().optional(),
        system: z.boolean().optional(),
      }),
    )
    .optional(),
});

/** Captured intent, not a prepared Runner context. No environment, token or URL. */
export const piDeferredConfigurationSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    resourceOwner: z.strictObject({ userId: z.string(), orgId: z.string() }),
    body: unifiedRunRequestSchema
      .omit({ secrets: true, sessionId: true, conversationId: true })
      .required({ triggerSource: true }),
    productAgentExecutionPlan: z.strictObject({
      identity: z.enum(["agent", "pi-memory-phase2-maintenance"]),
      content: executionConfig,
    }),
    connectorScope: z.strictObject({
      allowedConnectorSlugs: z.array(connectorSlugSchema),
      allowedCustomConnectorIds: z.array(z.uuid()),
      customConnectorGrants: z
        .array(agentCustomConnectorGrantSchema)
        .optional(),
      source: z.enum(["explicit", "stored_agent"]).optional(),
    }),
    modelProviderId: z.string().nullable(),
    modelProviderCredentialScope: z.enum(["org", "member"]).nullable(),
    modelProviderType: z.string(),
    selectedModel: z.string(),
    modelConfig: piModelConfigSchema,
    runtimeProvider: z.string().min(1),
    runtimeModel: z.string().min(1),
    apiInferenceBilling: z
      .strictObject({
        billableFirewalls: z.array(z.string()),
        modelUsageProvider: z.string().optional(),
      })
      .optional(),
    gateway: z
      .strictObject({
        connectionId: z.uuid(),
        secretId: z.uuid(),
        protocol: z.enum(["anthropic-messages", "openai-responses"]),
        apiBaseUrl: z.string(),
        authHeaderName: z.string(),
        authHeaderTemplate: z.string(),
        upstreamModel: z.string(),
      })
      .optional(),
    builtInModelRuntimeRoute: z
      .strictObject({
        selectedModel: z.string(),
        providerType: z.enum(
          Object.keys(BUILT_IN_MODEL_ROUTE_PROVIDERS) as [
            keyof typeof BUILT_IN_MODEL_ROUTE_PROVIDERS,
            ...(keyof typeof BUILT_IN_MODEL_ROUTE_PROVIDERS)[],
          ],
        ),
        upstreamModel: z.string(),
        modelKeyId: z.uuid(),
      })
      .optional(),
    codexServiceTier: z.literal("fast").optional(),
    reasoningEffort: reasoningEffortSchema.nullable().optional(),
    includeOkouTokenSecret: z.boolean(),
    okouTokenComputerUseHostId: z.uuid().optional(),
    okouTokenCloudBrowserEnabled: z.boolean().optional(),
    introVideoEnabled: z.boolean().optional(),
    injectSkillVolumes: z
      .strictObject({
        workflows: z.array(
          z.strictObject({
            name: z.string(),
            workflowId: z.uuid(),
            officialDefinitionName: z.string().nullable(),
          }),
        ),
      })
      .optional(),
    requiredOfficialWorkflowIds: z.array(z.uuid()).optional(),
    piMemoryPhase2Maintenance: piMemoryPhase2MaintenanceSchema.optional(),
  })
  .refine((configuration) => {
    return (
      configuration.modelProviderType.startsWith("custom-") ===
      (configuration.gateway !== undefined)
    );
  }, "Custom gateway capture must include its immutable route and credential source");
export type PiDeferredConfiguration = z.infer<
  typeof piDeferredConfigurationSchema
>;

const mountSchema = z.strictObject({
  orgId: z.string(),
  userId: z.string(),
  name: z.string(),
  storageId: z.uuid(),
  version: z.string().regex(/^[0-9a-f]{64}$/u),
  mountPath: z.string(),
  optional: z.boolean().optional(),
  writeback: z.boolean().optional(),
  instructionsTargetFilename: z.string().optional(),
  missingRootPolicy: z.enum(["fail", "preserveParentVersion"]).optional(),
  piMemoryRecall: piMemoryRecallSelectionSchema.optional(),
});
export const piDeferredContextSchema = z.strictObject({
  schemaVersion: z.literal(1),
  baseSession: piSessionCheckpointSchema,
  resourceSnapshot: piResourceSnapshotSchema,
  resourceSnapshotDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .optional(),
  storageMounts: z.array(mountSchema),
  memoryRecall: piMemoryRecallSelectionSchema.optional(),
  h0SessionHistory: sessionHistorySchema,
});
const durableAssistantContentSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("text"),
    text: z.string(),
    runEventId: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("toolCall"),
    id: z.string().min(1),
    name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()),
  }),
]);
const durableAssistantMessageSchema = z.strictObject({
  content: z.array(durableAssistantContentSchema),
  memoryCitation: piMemoryCitationSchema.optional(),
  model: z.string().min(1),
  responseId: z.string().optional(),
  failureReason: knownRunFailureReasonSchema.optional(),
  timestamp: z.number(),
  usage: z.strictObject({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    cacheRead: z.number().int().nonnegative(),
    cacheWrite: z.number().int().nonnegative(),
    cacheWrite1h: z.number().int().nonnegative().optional(),
  }),
  stopReason: z.enum(["pending", "stop", "length", "toolUse", "deferred"]),
});

/** The producer receipt makes post-provider local publication recoverable. The
 * consumer ignores it and executes only the separately validated native H1. */
export const piDeferredH1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  manifestGeneration: z.number().int().positive(),
  lastEventSequence: z.number().int().nonnegative(),
  sessionHistory: sessionHistorySchema,
  historyHash: z.string().regex(/^[0-9a-f]{64}$/),
  producer: z
    .strictObject({
      schemaVersion: z.literal(1),
      assistantMessage: durableAssistantMessageSchema,
      handoffRequired: z.boolean(),
      observedServiceTier: z.string().nullable(),
      startedAt: z.number().int().nonnegative(),
      completedAt: z.number().int().nonnegative(),
    })
    .optional(),
});
const persistentSecretsCiphertextSchema = z
  .string()
  .startsWith("vm0secret:v1:");

export const piDeferredSecretsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  /** Deferred Sandbox overrides; null when this object only retains the API
   * activation credential snapshot. */
  ciphertext: persistentSecretsCiphertextSchema.nullable(),
  /** Narrow state required to recover a lost ready/not-started activation.
   * Provider secrets and optional tracing environment remain KMS-encrypted. */
  apiInference: z
    .strictObject({
      encryptedModelSecrets: persistentSecretsCiphertextSchema.nullable(),
      encryptedPlatformEnvironment:
        persistentSecretsCiphertextSchema.nullable(),
      secretConnectorMap: z.record(z.string(), z.string()).nullable(),
      secretConnectorMetadataMap: secretConnectorMetadataMapSchema.nullable(),
    })
    .optional(),
});
