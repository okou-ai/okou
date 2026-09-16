import { z } from "zod";
import { unifiedRunRequestSchema } from "@okouai/api-contracts/contracts/runs";
import { connectorSlugSchema } from "@okouai/api-contracts/contracts/connector-identity";
import { agentCustomConnectorGrantSchema } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import { BUILT_IN_MODEL_ROUTE_PROVIDERS } from "@okouai/api-contracts/contracts/model-providers";
import { reasoningEffortSchema } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import {
  piMemoryPhase2MaintenanceSchema,
  piMemoryRecallSelectionSchema,
  piResourceSnapshotSchema,
  piSessionCheckpointSchema,
  piModelConfigSchema,
} from "@okouai/api-contracts/contracts/runners";

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
  storageMounts: z.array(mountSchema),
  memoryRecall: piMemoryRecallSelectionSchema.optional(),
  h0SessionHistory: z.string(),
});
export const piDeferredH1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  manifestGeneration: z.number().int().positive(),
  lastEventSequence: z.number().int().nonnegative(),
  sessionHistory: z.string(),
  historyHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export const piDeferredSecretsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ciphertext: z.string().startsWith("vm0secret:v1:"),
});
