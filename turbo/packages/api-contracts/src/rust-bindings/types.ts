import { z } from "zod";
import {
  piApiFirstTurnConfigSchema,
  piDeferredHandoffChunkSchema,
  piDeferredSandboxConfigSchema,
  activeInputDeliveryReserveResponseSchema,
  activeInputDeliveryReceiptResponseSchema,
  artifactMissingRootPolicySchema,
  builtInModelProviderConnectionSourceSchema,
  piLaunchConfigSchema,
  piModelConfigLegacySchema,
  piModelConfigV2Schema,
  piModelConfigV3Schema,
  runnersModelProviderFailuresContract,
  runnerCancellationResponseSchema,
  sessionHistoryEncodingSchema,
  storageMountEntrySchema,
} from "../contracts/runners";
import { piNativeTypeBindings } from "./pi-native-types";
import { sshTypeBindings } from "./ssh-types";
import { vncTypeBindings } from "./vnc-types";
import { knownRunFailureReasonSchema } from "../contracts/run-failure-reasons";
import { modelProviderCodexRuntimeConfigSchema } from "../contracts/model-providers";
import { fileEntryWithHashSchema } from "../contracts/storages";
import {
  webhookCheckpointsContract,
  webhookCheckpointsPrepareHistoryContract,
  webhookCompleteContract,
  webhookStoragesCommitContract,
  webhookStoragesPrepareContract,
} from "../contracts/webhooks";

export interface RustTypeBinding {
  readonly schema: z.ZodType;
  readonly rustModulePath: readonly string[];
  readonly rustTypeName: string;
  readonly direction: "request" | "response";
  readonly fieldTypeOverrides?: Readonly<Record<string, string>>;
  /** Decode sensitive responses directly, without Debug/Clone/Serialize or tagged buffering. */
  readonly sensitive?: boolean;
  readonly declarations: readonly RustTypeDeclarationDoc[];
}

export interface RustTypeDeclarationDoc {
  readonly rustTypeName: string;
  readonly rustDoc: readonly string[];
  readonly fields?: Readonly<Record<string, readonly string[]>>;
  readonly variants?: Readonly<Record<string, readonly string[]>>;
}

export interface RustTypeModuleDoc {
  readonly rustModulePath: readonly string[];
  readonly rustDoc: readonly string[];
}

export const rustTypeRootDoc = [
  "Generated Rust DTOs for selected `@okouai/api-contracts` request and response bodies.",
  "Do not edit by hand; regenerate with `cd turbo && pnpm -F @okouai/api-contracts generate:rust`.",
  "These types preserve the TypeScript wire contract for Rust runner and guest-agent code.",
] as const;

export const rustTypeModuleDocs = [
  {
    rustModulePath: ["runners", "runs", "cancellation"],
    rustDoc: ["Authenticated Run cancellation reconciliation DTOs."],
  },
  {
    rustModulePath: ["runners", "ssh"],
    rustDoc: ["Private Runner SSH authority DTOs."],
  },
  {
    rustModulePath: ["runners", "vnc"],
    rustDoc: ["Private Runner VNC credentials and current authorization DTOs."],
  },
  {
    rustModulePath: ["runners"],
    rustDoc: ["Runner-facing DTOs generated from TypeScript API contracts."],
  },
  {
    rustModulePath: ["runners", "storage"],
    rustDoc: [
      "Storage manifest DTOs used by runners to mount volumes and artifacts.",
    ],
  },
  {
    rustModulePath: ["runners", "runs"],
    rustDoc: [
      "Run-scoped DTOs exchanged between runners, guests, and the API.",
    ],
  },
  {
    rustModulePath: ["runners", "jobs"],
    rustDoc: ["Authenticated Runner job DTOs."],
  },
  {
    rustModulePath: ["runners", "jobs", "pi_handoff"],
    rustDoc: ["Authenticated deferred Pi handoff DTOs."],
  },
  {
    rustModulePath: ["runners", "runs", "active_inputs"],
    rustDoc: ["DTOs for durable active-input delivery."],
  },
  {
    rustModulePath: ["runners", "runs", "active_inputs", "reserve"],
    rustDoc: ["DTOs for reserving or retrieving active-input delivery."],
  },
  {
    rustModulePath: ["runners", "runs", "active_inputs", "receipt"],
    rustDoc: ["DTOs for recording active-input acceptance receipts."],
  },
  {
    rustModulePath: ["runners", "runs", "model_provider_failures"],
    rustDoc: ["DTOs for reporting bounded built-in model provider failures."],
  },
  {
    rustModulePath: ["webhooks"],
    rustDoc: ["Webhook DTOs generated from TypeScript API contracts."],
  },
  {
    rustModulePath: ["webhooks", "agent"],
    rustDoc: ["Agent webhook DTOs exchanged between sandboxes and the API."],
  },
  {
    rustModulePath: ["webhooks", "agent", "checkpoints"],
    rustDoc: ["DTOs for creating recoverable agent checkpoints."],
  },
  {
    rustModulePath: ["webhooks", "agent", "checkpoints", "prepare_history"],
    rustDoc: ["DTOs for preparing direct session-history uploads."],
  },
  {
    rustModulePath: ["webhooks", "agent", "complete"],
    rustDoc: ["DTOs for atomically completing agent runs."],
  },
  {
    rustModulePath: ["webhooks", "agent", "storages"],
    rustDoc: [
      "Sandbox storage upload DTOs shared by guest agents and webhook handlers.",
    ],
  },
  {
    rustModulePath: ["webhooks", "agent", "storages", "commit"],
    rustDoc: ["DTOs for committing direct sandbox storage uploads."],
  },
  {
    rustModulePath: ["webhooks", "agent", "storages", "prepare"],
    rustDoc: ["DTOs for preparing direct sandbox storage uploads."],
  },
] satisfies readonly RustTypeModuleDoc[];

export const rustTypeBindings = [
  {
    schema: runnerCancellationResponseSchema,
    rustModulePath: ["runners", "runs", "cancellation"],
    rustTypeName: "Response",
    direction: "response",
    declarations: [
      {
        rustTypeName: "Response",
        rustDoc: [
          "Stop intent or authenticated physical absence for an exact Run.",
        ],
        fields: {
          protocolVersion: ["Version of the cancellation response contract."],
          runId: ["Exact Run authorized by the request's sandbox credential."],
          mode: [
            "Explicit committed stop mode; null cannot reconstruct a historical intent.",
          ],
        },
        variants: {
          present: [
            "The matching Run exists; only an explicit mode requests cancellation.",
          ],
          gone: [
            "The authenticated Run is physically absent; stop its remaining execution.",
          ],
          unavailable: [
            "The present row does not match the expected owner or claim.",
          ],
        },
      },
      {
        rustTypeName: "ResponsePresentMode",
        rustDoc: [
          "Effective mode persisted by the API's canonical stop decision.",
        ],
        variants: {
          cooperative: ["Allow bounded cancellation recovery."],
          hard: ["Stop without waiting for cooperative recovery."],
        },
      },
    ],
  },
  ...sshTypeBindings,
  ...vncTypeBindings,
  ...piNativeTypeBindings,
  {
    schema: modelProviderCodexRuntimeConfigSchema,
    rustModulePath: ["runners", "runs"],
    rustTypeName: "CodexRuntimeConfig",
    direction: "response",
    fieldTypeOverrides: {
      modelCatalog: "serde_json::Value",
    },
    declarations: [
      {
        rustTypeName: "CodexRuntimeConfig",
        rustDoc: [
          "API-owned provider configuration forwarded to Codex in the sandbox.",
        ],
        fields: {
          providerId: [
            "Codex provider key used in generated startup settings.",
          ],
          name: ["Display name recorded for the Codex provider."],
          baseUrl: ["Base URL for the provider's Responses API."],
          envKey: ["Environment variable containing the provider credential."],
          httpHeaders: ["Optional static HTTP headers for provider requests."],
          requiresOpenaiAuth: [
            "Optional override for Codex's built-in OpenAI authentication requirement.",
          ],
          wireApi: ["Codex wire protocol selected for the provider."],
          supportsWebsockets: [
            "Whether the provider supports the Codex websocket transport.",
          ],
          modelCatalog: [
            "Optional opaque Codex model catalog supplied by the API.",
          ],
        },
      },
    ],
  },
  {
    schema: z.object({
      schemaVersion: z.literal(2),
      apiFirstTurn: piDeferredSandboxConfigSchema.unwrap().pick({
        schemaVersion: true,
        ownerEpoch: true,
        generation: true,
        deadlineAt: true,
        resourceSnapshotDigest: true,
        baseSession: true,
        sandboxEventSequenceStart: true,
        historyHash: true,
        runId: true,
        activeInput: true,
      }),
    }),
    rustModulePath: ["runners", "runs"],
    rustTypeName: "PiDeferredLaunchConfig",
    direction: "response",
    declarations: [
      {
        rustTypeName: "PiDeferredLaunchConfig",
        rustDoc: [
          "Deferred Pi Runner validation view. The CLI validates the full immutable payload.",
        ],
        fields: {
          schemaVersion: ["Outer Pi launch version."],
          apiFirstTurn: ["Generation-fenced durable continuation."],
        },
      },
      {
        rustTypeName: "PiDeferredLaunchConfigApiFirstTurn",
        rustDoc: ["Minimum deferred handoff identity accepted by the Runner."],
        fields: {
          schemaVersion: ["Deferred continuation version."],
          ownerEpoch: ["Claimed inference owner epoch."],
          generation: ["Claimed demand generation."],
          deadlineAt: ["Execution startup deadline in Unix milliseconds."],
          resourceSnapshotDigest: [
            "Digest of the frozen resources validated by the CLI.",
          ],
          baseSession: ["Original canonical Pi session checkpoint."],
          sandboxEventSequenceStart: [
            "First unpublished Sandbox event sequence.",
          ],
          historyHash: ["Digest of the exact H1 or untouched H0 bytes."],
          runId: ["Original Run authorized by the Sandbox token."],
          activeInput: [
            "Original Run has a thread capable of receiving active input.",
          ],
        },
      },
      {
        rustTypeName: "PiDeferredLaunchConfigApiFirstTurnBaseSession",
        rustDoc: ["Captured H0 checkpoint."],
        fields: {
          sessionId: ["Canonical Pi session identifier."],
          sha256: ["Original H0 history digest, or null for an empty session."],
        },
      },
    ],
  },
  {
    schema: piDeferredHandoffChunkSchema,
    rustModulePath: ["runners", "jobs", "pi_handoff"],
    rustTypeName: "Response",
    direction: "response",
    sensitive: true,
    declarations: [
      {
        rustTypeName: "Response",
        rustDoc: [
          "One bounded chunk of authenticated deferred Pi handoff data.",
        ],
        fields: {
          chunk: ["Base64-encoded handoff bytes."],
          nextOffset: [
            "Next exact byte offset, or null after the final chunk.",
          ],
        },
      },
    ],
  },
  {
    schema: piLaunchConfigSchema
      .unwrap()
      .safeExtend({ apiFirstTurn: piApiFirstTurnConfigSchema }),
    rustModulePath: ["runners", "runs"],
    rustTypeName: "PiLaunchConfig",
    direction: "response",
    declarations: [
      {
        rustTypeName: "PiLaunchConfig",
        rustDoc: [
          "API-owned launch configuration forwarded to Pi in the sandbox.",
        ],
        fields: {
          schemaVersion: ["Pi launch contract version."],
          apiFirstTurn: ["Configuration for the API-mediated first turn."],
          memoryRecall: [
            "Optional frozen memory-summary selection for API and Sandbox parity.",
          ],
          maintenance: [
            "Optional authenticated input for a first-party Pi memory maintenance run.",
          ],
        },
      },
      {
        rustTypeName: "PiLaunchConfigMaintenance",
        rustDoc: ["Private input for one sandbox Pi memory maintenance run."],
        fields: {
          schemaVersion: ["Pi memory maintenance input version."],
          memoryStorageId: ["Canonical mounted memory Storage identity."],
          claimedRevision: ["Exact claimed Phase 2 input revision."],
          claimedBaseVersionId: ["Exact memory version mounted for the claim."],
          leaseToken: ["Opaque token fencing this maintenance claim."],
          selectionDigest: ["Digest of the bounded selected candidate set."],
          selected: [
            "Bounded Stage 1 candidate snapshots selected by the claim.",
          ],
        },
      },
      {
        rustTypeName: "PiLaunchConfigMaintenanceSelected",
        rustDoc: ["One bounded Stage 1 candidate snapshot."],
        fields: {
          piSessionId: ["Canonical Pi session identity."],
          sourceRunId: ["Run that produced the candidate."],
          sourceHistoryHash: ["Exact source session-history hash."],
          sourceCompletedAt: ["Completion time of the source run."],
          rawMemory: ["Restricted Stage 1 memory candidate."],
          rolloutSummary: ["Restricted Stage 1 rollout summary."],
          rolloutSlug: ["Optional safe rollout evidence slug."],
        },
      },
      {
        rustTypeName: "PiLaunchConfigMemoryRecall",
        rustDoc: ["Frozen exact-version Pi memory recall selection."],
        fields: {
          memoryStorageId: ["Canonical memory Storage identity."],
          storageVersionId: ["Exact pinned Storage version identity."],
          content: ["Authenticated frozen root summary content."],
          sourceHash: ["Lowercase SHA-256 of the frozen summary bytes."],
          sourceSize: ["Exact frozen summary byte size."],
          tokenCount: ["Exact o200k token count of the frozen summary."],
        },
        variants: {
          "no-content": ["The launch epoch intentionally contains no memory."],
          ready: ["The launch epoch contains an authenticated summary."],
        },
      },
      {
        rustTypeName: "PiLaunchConfigApiFirstTurn",
        rustDoc: ["API-mediated first-turn configuration for Pi."],
        fields: {
          schemaVersion: ["Pi API first-turn contract version."],
          resourceSnapshotDigest: [
            "Digest identifying the runtime resource snapshot.",
          ],
          manifestUrl: ["URL of the first-turn resource manifest."],
          sessionUrl: ["URL of the first-turn session JSONL."],
          deadlineAt: ["Unix timestamp in milliseconds for first-turn expiry."],
          baseSession: ["Checkpoint used as the base Pi session."],
          sandboxEventSequenceStart: [
            "First sandbox event sequence number for the resumed session.",
          ],
        },
      },
      {
        rustTypeName: "PiLaunchConfigApiFirstTurnBaseSession",
        rustDoc: ["Pi session checkpoint used as the first-turn base."],
        fields: {
          sessionId: ["Pi session identifier."],
          sha256: ["Nullable lowercase SHA-256 of the base session JSONL."],
        },
      },
    ],
  },
  {
    schema: piModelConfigLegacySchema,
    rustModulePath: ["runners", "runs"],
    rustTypeName: "PiModelConfig",
    direction: "response",
    declarations: [
      {
        rustTypeName: "PiModelConfig",
        rustDoc: ["API-owned non-secret Pi model configuration."],
        fields: {
          provider: ["Model provider selected for the Pi runtime."],
          baseUrl: ["Base URL used for model requests."],
          model: ["Provider model identifier sent with requests."],
          catalogModel: [
            "Optional native Pi catalog model used only for trusted capabilities and limits.",
          ],
          thinkingLevel: [
            "Explicit Pi thinking level. Legacy payloads omit this field and retain Pi's medium default.",
          ],
          serviceTier: [
            "Per-run provider request service tier. Legacy and standard payloads omit this field.",
          ],
          apiKeyEnv: ["Environment variable containing the provider key."],
          credentialSecretName: [
            "API-owned credential secret backing the environment entry.",
          ],
          credentialHeader: [
            "Optional non-secret custom gateway credential header policy.",
          ],
        },
      },
      {
        rustTypeName: "PiModelConfigCredentialHeader",
        rustDoc: ["Non-secret custom gateway credential header policy."],
        fields: {
          name: ["Request header name."],
          valueTemplate: [
            "Header value template containing the credential placeholder exactly once.",
          ],
        },
      },
      {
        rustTypeName: "PiModelConfigProvider",
        rustDoc: ["Model providers supported by the Pi runtime contract."],
        variants: {
          deepseek: ["DeepSeek provider."],
          moonshotai: ["Moonshot AI provider."],
          openai: ["OpenAI provider."],
          openrouter: ["OpenRouter provider."],
          "vercel-ai-gateway": ["Vercel AI Gateway provider."],
          codex: ["Codex provider."],
        },
      },
      {
        rustTypeName: "PiModelConfigThinkingLevel",
        rustDoc: ["Thinking levels supported by Pi sessions."],
        variants: {
          off: ["Disable model thinking."],
          minimal: ["Minimal thinking."],
          low: ["Low thinking."],
          medium: ["Medium thinking."],
          high: ["High thinking."],
          xhigh: ["Extra-high thinking."],
          max: ["Maximum thinking."],
        },
      },
      {
        rustTypeName: "PiModelConfigServiceTier",
        rustDoc: [
          "Provider request service tiers supported by the Pi runtime.",
        ],
        variants: {
          priority: ["OpenAI priority service tier."],
        },
      },
      {
        rustTypeName: "PiModelConfigApiKeyEnv",
        rustDoc: [
          "Environment variables supported for Pi provider credentials.",
        ],
        variants: {
          ANTHROPIC_AUTH_TOKEN: ["Anthropic authentication token."],
          OPENAI_API_KEY: ["OpenAI-compatible API key."],
          CHATGPT_ACCESS_TOKEN: ["ChatGPT access token."],
        },
      },
    ],
  },
  {
    schema: piModelConfigV2Schema,
    rustModulePath: ["runners", "runs"],
    rustTypeName: "PiModelConfigV2",
    direction: "response",
    fieldTypeOverrides: {
      environment: "String",
      secretName: "String",
    },
    declarations: [
      {
        rustTypeName: "PiModelConfigV2",
        rustDoc: ["API-owned dialect-aware non-secret Pi model configuration."],
        fields: {
          schemaVersion: ["Pi model configuration generation."],
          dialect: ["Native Pi request dialect selected by the route."],
          transport: ["Transport policy selected by the route."],
          provider: ["Native Pi catalog provider selected by the route."],
          baseUrl: ["Exact base URL used for model requests."],
          model: ["Exact provider model identifier sent with requests."],
          catalogModel: [
            "Optional native Pi catalog model used for trusted public Responses metadata.",
          ],
          thinkingLevel: ["Explicit Pi thinking level."],
          serviceTier: ["Optional public Responses service tier."],
          credentialBindings: [
            "Bounded non-secret credential bindings materialized only at an execution edge.",
          ],
        },
      },
      {
        rustTypeName: "PiModelConfigV2Dialect",
        rustDoc: ["Native Pi request dialects supported by this generation."],
        variants: {
          "openai-responses": ["Public OpenAI Responses dialect."],
          "openai-codex-responses": ["ChatGPT Codex Responses dialect."],
        },
      },
      {
        rustTypeName: "PiModelConfigV2Provider",
        rustDoc: ["Native Pi catalog providers supported by this generation."],
        variants: {
          deepseek: ["DeepSeek provider."],
          openai: ["OpenAI public API provider."],
          openrouter: ["OpenRouter provider."],
          "openai-codex": ["OpenAI Codex subscription provider."],
        },
      },
      {
        rustTypeName: "PiModelConfigV2ThinkingLevel",
        rustDoc: ["Thinking levels supported by Pi sessions."],
        variants: {
          off: ["Disable model thinking."],
          minimal: ["Minimal thinking."],
          low: ["Low thinking."],
          medium: ["Medium thinking."],
          high: ["High thinking."],
          xhigh: ["Extra-high thinking."],
          max: ["Maximum thinking."],
        },
      },
      {
        rustTypeName: "PiModelConfigV2ServiceTier",
        rustDoc: ["Public Responses request service tiers."],
        variants: {
          priority: ["OpenAI priority service tier."],
        },
      },
      {
        rustTypeName: "PiModelConfigV2CredentialBinding",
        rustDoc: ["One non-secret execution-edge credential binding."],
        fields: {
          environment: ["Sandbox environment entry containing the value."],
          secretName: ["API-owned encrypted secret containing the value."],
          credentialHeader: [
            "Optional non-secret custom gateway header policy.",
          ],
        },
        variants: {
          "api-key": ["Public Responses API-key binding."],
          "access-token": ["ChatGPT access-token binding."],
          "account-id": ["ChatGPT account-ID binding."],
        },
      },
      {
        rustTypeName: "PiModelConfigV2CredentialBindingApiKeyCredentialHeader",
        rustDoc: ["Non-secret custom gateway credential header policy."],
        fields: {
          name: ["Request header name."],
          valueTemplate: [
            "Header value template containing the credential placeholder exactly once.",
          ],
        },
      },
    ],
  },
  {
    schema: piModelConfigV3Schema,
    rustModulePath: ["runners", "runs"],
    rustTypeName: "PiModelConfigV3",
    direction: "response",
    fieldTypeOverrides: {
      environment: "String",
      secretName: "String",
    },
    declarations: [
      {
        rustTypeName: "PiModelConfigV3",
        rustDoc: ["API-owned dialect-aware non-secret Pi model configuration."],
        variants: {
          "openai-responses": [
            "Public Responses route with optional priority tier.",
          ],
          "openai-codex-responses": [
            "Native Codex Responses route with optional fast tier.",
          ],
        },
        fields: {
          schemaVersion: ["Pi model configuration generation."],
          transport: ["Transport policy selected by the route."],
          provider: ["Native Pi catalog provider selected by the route."],
          baseUrl: ["Exact base URL used for model requests."],
          model: ["Exact provider model identifier sent with requests."],
          catalogModel: [
            "Optional native Pi catalog model used for trusted public Responses metadata.",
          ],
          thinkingLevel: ["Explicit Pi thinking level."],
          serviceTier: ["Optional dialect-constrained request service tier."],
          credentialBindings: [
            "Bounded non-secret credential bindings materialized only at an execution edge.",
          ],
        },
      },
      ...(["OpenaiResponses", "OpenaiCodexResponses"] as const).flatMap(
        (dialect): RustTypeDeclarationDoc[] => {
          return [
            {
              rustTypeName: `PiModelConfigV3${dialect}Transport`,
              rustDoc: ["Required Responses streaming transport."],
              variants: { sse: ["Server-sent events only."] },
            },
            {
              rustTypeName: `PiModelConfigV3${dialect}Provider`,
              rustDoc: ["Native Pi catalog providers for this dialect."],
              variants:
                dialect === "OpenaiResponses"
                  ? {
                      deepseek: ["DeepSeek provider."],
                      openai: ["OpenAI public API provider."],
                      openrouter: ["OpenRouter provider."],
                    }
                  : { "openai-codex": ["OpenAI Codex subscription provider."] },
            },
            {
              rustTypeName: `PiModelConfigV3${dialect}ThinkingLevel`,
              rustDoc: ["Thinking levels supported by Pi sessions."],
              variants: {
                off: ["Disable model thinking."],
                minimal: ["Minimal thinking."],
                low: ["Low thinking."],
                medium: ["Medium thinking."],
                high: ["High thinking."],
                xhigh: ["Extra-high thinking."],
                max: ["Maximum thinking."],
              },
            },
            {
              rustTypeName: `PiModelConfigV3${dialect}ServiceTier`,
              rustDoc: ["Dialect-constrained request service tiers."],
              variants:
                dialect === "OpenaiResponses"
                  ? { priority: ["Public Responses priority service tier."] }
                  : { fast: ["Native Codex Responses fast service tier."] },
            },
            {
              rustTypeName: `PiModelConfigV3${dialect}CredentialBinding`,
              rustDoc: ["One non-secret execution-edge credential binding."],
              fields: {
                environment: [
                  "Sandbox environment entry containing the value.",
                ],
                secretName: [
                  "API-owned encrypted secret containing the value.",
                ],
                credentialHeader: [
                  "Optional non-secret custom gateway header policy.",
                ],
              },
              variants: {
                "api-key": ["Public Responses API-key binding."],
                "access-token": ["ChatGPT access-token binding."],
                "account-id": ["ChatGPT account-ID binding."],
              },
            },
            {
              rustTypeName: `PiModelConfigV3${dialect}CredentialBindingApiKeyCredentialHeader`,
              rustDoc: ["Non-secret custom gateway credential header policy."],
              fields: {
                name: ["Request header name."],
                valueTemplate: [
                  "Header value template containing the credential placeholder exactly once.",
                ],
              },
            },
          ];
        },
      ),
    ],
  },
  {
    schema: activeInputDeliveryReserveResponseSchema,
    rustModulePath: ["runners", "runs", "active_inputs", "reserve"],
    rustTypeName: "Response",
    direction: "response",
    declarations: [
      {
        rustTypeName: "Response",
        rustDoc: ["API outcome when reserving or retrieving active input."],
        fields: {
          deliveryId: ["Stable identity for the reserved delivery batch."],
          eventIds: ["Ordered source chat-event identities in the batch."],
          prompt: ["Materialized prompt sent to the active Guest."],
          reason: ["Reason the pending input could not be reserved."],
        },
        variants: {
          reserved: ["A stable delivery batch is ready for Guest delivery."],
          empty: ["No pending active input is available."],
          terminal: ["The run is terminal and has no open delivery."],
          held: ["An open delivery remains held for a non-running run."],
          rejected: ["Pending input cannot currently be reserved."],
        },
      },
      {
        rustTypeName: "ResponseRejectedReason",
        rustDoc: ["Reason an active-input reservation was rejected."],
        variants: {
          payload_too_large: [
            "The delivery-aware control payload exceeds the frame limit.",
          ],
          run_not_running: ["The target run is no longer running."],
        },
      },
    ],
  },
  {
    schema: activeInputDeliveryReceiptResponseSchema,
    rustModulePath: ["runners", "runs", "active_inputs", "receipt"],
    rustTypeName: "Response",
    direction: "response",
    declarations: [
      {
        rustTypeName: "Response",
        rustDoc: ["API outcome after recording active-input acceptance."],
        variants: {
          delivered: ["The delivery receipt was accepted idempotently."],
          rejected: ["The delivery can no longer be accepted."],
        },
      },
    ],
  },
  {
    schema: builtInModelProviderConnectionSourceSchema,
    rustModulePath: ["runners", "runs", "model_provider_failures"],
    rustTypeName: "RequestConnectionSource",
    direction: "request",
    declarations: [
      {
        rustTypeName: "RequestConnectionSource",
        rustDoc: ["Source of an eligible connection failure."],
        variants: {
          provider_response: ["The provider returned a connection failure."],
          upstream_transport: [
            "The runner observed an upstream transport failure.",
          ],
        },
      },
    ],
  },
  {
    schema: runnersModelProviderFailuresContract.report.body,
    rustModulePath: ["runners", "runs", "model_provider_failures"],
    rustTypeName: "Request",
    direction: "request",
    fieldTypeOverrides: {
      connectionSource: "RequestConnectionSource",
    },
    declarations: [
      {
        rustTypeName: "Request",
        rustDoc: [
          "Request body for reporting a built-in model provider failure.",
        ],
        variants: {
          authentication: ["Provider authentication failed."],
          billing: ["Provider billing rejected the request."],
          rate_limit: ["Provider rate limiting rejected the request."],
          provider_unavailable: [
            "The provider route was unavailable or overloaded.",
          ],
          timeout: ["The provider inference request timed out."],
          connection: ["The provider connection failed."],
        },
        fields: {
          connectionSource: ["Required source of the connection failure."],
          retryAfterSeconds: [
            "Optional bounded provider retry delay in seconds.",
          ],
        },
      },
    ],
  },
  {
    schema: artifactMissingRootPolicySchema,
    rustModulePath: ["runners", "storage"],
    rustTypeName: "ArtifactEntryMissingRootPolicy",
    direction: "response",
    declarations: [
      {
        rustTypeName: "ArtifactEntryMissingRootPolicy",
        rustDoc: [
          "Policy used when an artifact mount root is missing from the uploaded manifest.",
        ],
        variants: {
          fail: ["Treat a missing artifact root as an error."],
          preserveParentVersion: [
            "Preserve the parent artifact version when the root path is missing.",
          ],
        },
      },
    ],
  },
  {
    schema: storageMountEntrySchema,
    rustModulePath: ["runners", "storage"],
    rustTypeName: "StorageMountEntry",
    direction: "response",
    fieldTypeOverrides: {
      missingRootPolicy: "ArtifactEntryMissingRootPolicy",
    },
    declarations: [
      {
        rustTypeName: "StorageMountEntry",
        rustDoc: ["Canonical resolved Storage mount accepted by runners."],
        fields: {
          name: ["Storage name retained for diagnostics and cache identity."],
          storageId: ["Immutable Storage identifier."],
          versionId: ["Resolved Storage version identifier."],
          mountPath: ["Guest filesystem path where the Storage is mounted."],
          archiveUrl: [
            "Optional presigned archive URL. Explicit empty writeback mounts may omit it.",
          ],
          archiveSize: ["Optional exact encoded archive size in bytes."],
          empty: ["Whether the resolved Storage version is explicitly empty."],
          baselineCandidate: [
            "Whether this read-only mount participates in baseline stability observation.",
          ],
          instructionsTargetFilename: [
            "Optional filename used when Storage instructions are normalized.",
          ],
          missingRootPolicy: [
            "Optional behavior when a writeback mount root is missing.",
          ],
          writeback: [
            "Whether changed contents are written back to the same Storage.",
          ],
        },
      },
    ],
  },
  {
    schema:
      webhookCheckpointsContract.create.body.shape.artifactSnapshots.unwrap()
        .element,
    rustModulePath: ["webhooks", "agent", "checkpoints"],
    rustTypeName: "ArtifactSnapshot",
    direction: "request",
    fieldTypeOverrides: {
      missingRootPolicy:
        "crate::generated::types::runners::storage::ArtifactEntryMissingRootPolicy",
    },
    declarations: [
      {
        rustTypeName: "ArtifactSnapshot",
        rustDoc: ["Artifact version captured by an agent checkpoint."],
        fields: {
          name: ["User-facing artifact name referenced by the run."],
          version: ["Artifact version selected for the checkpoint."],
          mountPath: ["Guest filesystem path where the artifact is mounted."],
          missingRootPolicy: [
            "Optional policy retained when the artifact mount root is missing.",
          ],
        },
      },
    ],
  },
  {
    schema: webhookCheckpointsContract.create.body,
    rustModulePath: ["webhooks", "agent", "checkpoints"],
    rustTypeName: "Request",
    direction: "request",
    fieldTypeOverrides: {
      artifactSnapshots: "Vec<ArtifactSnapshot>",
    },
    declarations: [
      {
        rustTypeName: "RequestVolumeVersionsSnapshot",
        rustDoc: ["Volume versions captured by an agent checkpoint."],
        fields: {
          versions: ["Volume names mapped to their captured versions."],
        },
      },
      {
        rustTypeName: "RequestCliAgentSessionHistoryDisposition",
        rustDoc: [
          "Reason a checkpoint intentionally omits resumable CLI agent session history.",
        ],
        variants: {
          discarded_oversized: [
            "The native history was oversized and had no safe bounded generation.",
          ],
          unavailable: [
            "The native history was missing, unsafe, ambiguous, or otherwise unusable.",
          ],
        },
      },
      {
        rustTypeName: "Request",
        rustDoc: ["Request body for creating a recoverable agent checkpoint."],
        fields: {
          runId: ["Agent run identifier bound to the sandbox token."],
          cliAgentType: ["CLI agent implementation that produced the session."],
          cliAgentSessionId: [
            "CLI agent session identifier being checkpointed.",
          ],
          cliAgentSessionHistoryHash: [
            "Optional SHA-256 hash of the uploaded CLI agent session history.",
          ],
          cliAgentSessionHistoryDisposition: [
            "Optional reason resumable CLI agent session history was intentionally omitted.",
          ],
          artifactSnapshots: [
            "Optional artifact versions captured by the checkpoint.",
          ],
          volumeVersionsSnapshot: [
            "Optional volume versions captured by the checkpoint.",
          ],
        },
      },
    ],
  },
  {
    schema: webhookCheckpointsContract.create.responses[200],
    rustModulePath: ["webhooks", "agent", "checkpoints"],
    rustTypeName: "Response",
    direction: "response",
    fieldTypeOverrides: {
      artifacts: "Vec<ArtifactSnapshot>",
    },
    declarations: [
      {
        rustTypeName: "Response",
        rustDoc: ["Response body returned after creating an agent checkpoint."],
        fields: {
          checkpointId: ["Created checkpoint identifier."],
          agentSessionId: ["Agent session associated with the checkpoint."],
          conversationId: ["Conversation captured by the checkpoint."],
          artifacts: ["Optional artifact versions captured by the checkpoint."],
          volumes: ["Optional volume versions captured by the checkpoint."],
        },
      },
    ],
  },
  {
    schema: knownRunFailureReasonSchema,
    rustModulePath: ["webhooks", "agent", "complete"],
    rustTypeName: "RequestFailureReason",
    direction: "request",
    declarations: [
      {
        rustTypeName: "RequestFailureReason",
        rustDoc: ["Known failure reason emitted by current Rust producers."],
        variants: {
          session_history_limit: ["Session history exceeded its size limit."],
          guest_root_filesystem_full: [
            "The sandbox root filesystem ran out of free blocks or inodes.",
          ],
          execution_timeout: ["The run reached its execution time limit."],
          insufficient_credits: ["The vm0 workspace lacks credits."],
          provider_insufficient_credits: [
            "The upstream provider account lacks credits.",
          ],
          invalid_api_key: ["The configured API key is invalid."],
          invalid_credentials: ["The configured credentials are invalid."],
          terms_acceptance_required: [
            "The provider requires acceptance of updated terms.",
          ],
          context_window_exceeded: ["The model context window was exceeded."],
          input_too_large: ["The Codex app-server input limit was exceeded."],
          output_token_limit: ["The provider output-token limit was reached."],
          provider_rate_limited: ["The provider rate limited the request."],
          provider_overloaded: ["The provider reported overload."],
          provider_stream_timeout: ["The provider stream timed out."],
          provider_queue_timeout: [
            "The provider expired the request before processing started.",
          ],
          provider_server_error: ["The provider returned a server error."],
          response_connection_lost: ["The response connection was lost."],
          safety_policy_refusal: ["The provider refused for safety policy."],
          reconnect_required: ["The CLI requires reconnecting."],
          unsupported_model: ["The selected model is unsupported."],
          usage_limit: ["The provider reported a usage limit."],
        },
      },
    ],
  },
  {
    schema: webhookCompleteContract.complete.body,
    rustModulePath: ["webhooks", "agent", "complete"],
    rustTypeName: "Request",
    direction: "request",
    fieldTypeOverrides: {
      exitCode: "i32",
      failureReason: "String",
      lastEventSequence: "u32",
    },
    declarations: [
      {
        rustTypeName: "RequestSandboxReuseResult",
        rustDoc: ["Outcome of the sandbox reuse decision."],
        variants: {
          reused: ["An idle sandbox was reused."],
          featureDisabled: ["Legacy outcome from the removed feature gate."],
          noSessionId: ["Legacy outcome for an unavailable reuse identity."],
          noReuseKey: ["The run had no sandbox reuse key."],
          poolMiss: ["No matching idle sandbox was available."],
          profileMismatch: ["The idle sandbox profile did not match."],
          deviceLimitMismatch: [
            "The idle sandbox device limits did not match.",
          ],
          unparkFailed: ["The selected idle sandbox could not be unparked."],
        },
      },
      {
        rustTypeName: "RequestWorkspaceReuseResult",
        rustDoc: ["Final outcome of workspace reuse preparation."],
        variants: {
          reused: ["A cached workspace was reused."],
          sandboxReused: ["The workspace remained in a reused sandbox."],
          cacheMiss: ["No matching workspace cache was available."],
          noReuseKey: ["The run had no workspace reuse key."],
          invalidWorkingDir: ["The cached workspace directory was invalid."],
          lockBusy: ["The cached workspace was locked by another run."],
          invalidMetadata: ["The cached workspace metadata was invalid."],
          diskPressure: ["Workspace reuse was disabled by disk pressure."],
          notConfigured: ["Workspace reuse was not configured."],
          sandboxPrepareFallback: [
            "Workspace preparation fell back after sandbox setup.",
          ],
        },
      },
      {
        rustTypeName: "RequestCheckpoint",
        rustDoc: ["Final checkpoint metadata included with completion."],
        fields: {
          cliAgentType: ["CLI agent implementation that produced the session."],
          cliAgentSessionId: [
            "CLI agent session identifier being checkpointed.",
          ],
          cliAgentSessionHistoryHash: [
            "Optional SHA-256 hash of uploaded CLI agent session history.",
          ],
          cliAgentSessionHistoryDisposition: [
            "Optional reason resumable session history was omitted.",
          ],
          artifactSnapshots: [
            "Optional artifact versions captured by the checkpoint.",
          ],
          volumeVersionsSnapshot: [
            "Optional volume versions captured by the checkpoint.",
          ],
        },
      },
      {
        rustTypeName: "RequestCheckpointCliAgentSessionHistoryDisposition",
        rustDoc: [
          "Reason a final checkpoint intentionally omits resumable CLI agent session history.",
        ],
        variants: {
          discarded_oversized: [
            "The native history exceeded the bounded checkpoint limit.",
          ],
          unavailable: ["The native history was unavailable or unusable."],
        },
      },
      {
        rustTypeName: "RequestCheckpointArtifactSnapshot",
        rustDoc: ["Artifact version captured by a final checkpoint."],
        fields: {
          name: ["User-facing artifact name referenced by the run."],
          version: ["Artifact version selected for the checkpoint."],
          mountPath: ["Guest filesystem path where the artifact is mounted."],
          missingRootPolicy: [
            "Optional policy retained when the artifact mount root is missing.",
          ],
        },
      },
      {
        rustTypeName: "RequestCheckpointArtifactSnapshotMissingRootPolicy",
        rustDoc: [
          "Policy used when a final checkpoint artifact root is missing.",
        ],
        variants: {
          fail: ["Treat a missing artifact root as an error."],
          preserveParentVersion: [
            "Preserve the parent artifact version when the root is missing.",
          ],
        },
      },
      {
        rustTypeName: "RequestCheckpointVolumeVersionsSnapshot",
        rustDoc: ["Volume versions captured by a final checkpoint."],
        fields: {
          versions: ["Volume names mapped to their captured versions."],
        },
      },
      {
        rustTypeName: "Request",
        rustDoc: ["Request body for completing an agent run."],
        fields: {
          runId: ["Agent run identifier bound to the sandbox token."],
          exitCode: ["Process exit code reported by the caller."],
          error: ["Optional process failure description."],
          failureReason: [
            "Optional detailed failure reason reported by the caller.",
          ],
          lastEventSequence: [
            "Highest contiguous agent event sequence delivered before completion.",
          ],
          sandboxId: ["Optional sandbox identifier used by the run."],
          sandboxReuseResult: [
            "Optional outcome of the sandbox reuse decision.",
          ],
          workspaceReuseResult: [
            "Optional outcome of the workspace reuse decision.",
          ],
          activeInputDeliveryIds: [
            "Optional active-input delivery receipts recovered during completion.",
          ],
          checkpoint: [
            "Optional final checkpoint persisted atomically with completion.",
          ],
        },
      },
    ],
  },
  {
    schema: sessionHistoryEncodingSchema,
    rustModulePath: ["webhooks", "agent", "checkpoints", "prepare_history"],
    rustTypeName: "SessionHistoryEncoding",
    direction: "request",
    declarations: [
      {
        rustTypeName: "SessionHistoryEncoding",
        rustDoc: ["Encoding used for persisted CLI agent session history."],
        variants: {
          identity: ["Uncompressed session history bytes."],
          gzip: ["Gzip-compressed session history bytes."],
          zstd: ["Zstandard-compressed session history bytes."],
        },
      },
    ],
  },
  {
    schema: webhookCheckpointsPrepareHistoryContract.prepare.body,
    rustModulePath: ["webhooks", "agent", "checkpoints", "prepare_history"],
    rustTypeName: "Request",
    direction: "request",
    fieldTypeOverrides: {
      rawSize: "u64",
      encodedSize: "u64",
      encoding: "SessionHistoryEncoding",
    },
    declarations: [
      {
        rustTypeName: "Request",
        rustDoc: ["Request body for preparing a session-history upload."],
        fields: {
          runId: ["Agent run identifier bound to the sandbox token."],
          hash: ["SHA-256 hash of the uncompressed session history."],
          rawSize: ["Uncompressed session-history size in bytes."],
          encodedSize: ["Encoded session-history size in bytes."],
          encoding: ["Optional encoding used for the uploaded bytes."],
        },
      },
    ],
  },
  {
    schema: webhookCheckpointsPrepareHistoryContract.prepare.responses[200],
    rustModulePath: ["webhooks", "agent", "checkpoints", "prepare_history"],
    rustTypeName: "Response",
    direction: "response",
    fieldTypeOverrides: {
      encoding: "SessionHistoryEncoding",
    },
    declarations: [
      {
        rustTypeName: "Response",
        rustDoc: ["Response body returned when preparing session history."],
        fields: {
          presignedUrl: ["Optional presigned URL for uploading new content."],
          existing: ["Whether the requested session history already exists."],
          encoding: ["Optional encoding of the persisted session history."],
        },
      },
    ],
  },
  {
    schema: fileEntryWithHashSchema,
    rustModulePath: ["webhooks", "agent", "storages"],
    rustTypeName: "FileEntryWithHash",
    direction: "request",
    declarations: [
      {
        rustTypeName: "FileEntryWithHash",
        rustDoc: [
          "File metadata entry used to compute and commit content-addressed storage uploads.",
        ],
        fields: {
          path: ["Path of the file inside the uploaded storage archive."],
          hash: ["SHA-256 hash of the file contents encoded as hex."],
          size: ["File size in bytes."],
        },
      },
    ],
  },
  {
    schema: webhookStoragesPrepareContract.prepare.body,
    rustModulePath: ["webhooks", "agent", "storages", "prepare"],
    rustTypeName: "Request",
    direction: "request",
    fieldTypeOverrides: {
      files: "Vec<super::FileEntryWithHash>",
    },
    declarations: [
      {
        rustTypeName: "RequestMaintenanceAttestation",
        rustDoc: ["Private proof of a validated Pi memory maintenance tree."],
        fields: {
          schemaVersion: ["Maintenance checkpoint attestation version."],
          leaseToken: ["Opaque token fencing the maintenance claim."],
          claimedRevision: ["Exact claimed Phase 2 input revision."],
          claimedBaseVersionId: ["Exact memory version mounted for the claim."],
          selectionDigest: ["Digest of the bounded selected candidate set."],
          validatedVersionId: ["Content hash of the validated mounted tree."],
        },
      },
      {
        rustTypeName: "RequestChanges",
        rustDoc: [
          "Incremental file change set sent while preparing a partial storage upload.",
        ],
        fields: {
          added: ["Paths added since the base storage version."],
          modified: ["Paths modified since the base storage version."],
          deleted: ["Paths deleted since the base storage version."],
        },
      },
      {
        rustTypeName: "Request",
        rustDoc: [
          "Request body for preparing a direct sandbox storage upload.",
        ],
        fields: {
          runId: ["Agent run identifier bound to the sandbox token."],
          storageId: [
            "Canonical Storage identifier authorized by the agent run.",
          ],
          files: ["Content-addressed file list included in the upload."],
          parentVersionId: [
            "Optional parent version used when preparing an incremental upload.",
          ],
          force: ["Whether to bypass deduplication checks for this upload."],
          baseVersion: [
            "Optional base version identifier for an incremental upload.",
          ],
          changes: ["Optional incremental file changes from the base version."],
          maintenanceAttestation: [
            "Private validation proof required for Pi memory maintenance publication.",
          ],
        },
      },
    ],
  },
  {
    schema: webhookStoragesPrepareContract.prepare.responses[200],
    rustModulePath: ["webhooks", "agent", "storages", "prepare"],
    rustTypeName: "Response",
    direction: "response",
    declarations: [
      {
        rustTypeName: "ResponseUploadsArchive",
        rustDoc: ["Presigned upload target for the storage archive object."],
        fields: {
          key: ["Object key for the archive upload."],
          presignedUrl: ["Presigned URL used to upload the archive object."],
        },
      },
      {
        rustTypeName: "ResponseUploadsManifest",
        rustDoc: ["Presigned upload target for the storage manifest object."],
        fields: {
          key: ["Object key for the manifest upload."],
          presignedUrl: ["Presigned URL used to upload the manifest object."],
        },
      },
      {
        rustTypeName: "ResponseUploads",
        rustDoc: [
          "Upload targets returned when the storage version does not already exist.",
        ],
        fields: {
          archive: ["Archive upload target."],
          manifest: ["Manifest upload target."],
        },
      },
      {
        rustTypeName: "Response",
        rustDoc: [
          "Response body for preparing a direct sandbox storage upload.",
        ],
        fields: {
          versionId: ["Storage version identifier prepared for the upload."],
          existing: [
            "Whether the requested storage version already exists and can be reused.",
          ],
          uploads: [
            "Presigned upload targets when archive and manifest uploads are required.",
          ],
        },
      },
    ],
  },
  {
    schema: webhookStoragesCommitContract.commit.body,
    rustModulePath: ["webhooks", "agent", "storages", "commit"],
    rustTypeName: "Request",
    direction: "request",
    fieldTypeOverrides: {
      files: "Vec<super::FileEntryWithHash>",
    },
    declarations: [
      {
        rustTypeName: "RequestMaintenanceAttestation",
        rustDoc: ["Private proof of a validated Pi memory maintenance tree."],
        fields: {
          schemaVersion: ["Maintenance checkpoint attestation version."],
          leaseToken: ["Opaque token fencing the maintenance claim."],
          claimedRevision: ["Exact claimed Phase 2 input revision."],
          claimedBaseVersionId: ["Exact memory version mounted for the claim."],
          selectionDigest: ["Digest of the bounded selected candidate set."],
          validatedVersionId: ["Content hash of the validated mounted tree."],
        },
      },
      {
        rustTypeName: "Request",
        rustDoc: [
          "Request body for committing a direct sandbox storage upload.",
        ],
        fields: {
          runId: ["Agent run identifier bound to the sandbox token."],
          storageId: [
            "Canonical Storage identifier authorized by the agent run.",
          ],
          versionId: ["Storage version identifier being committed."],
          parentVersionId: [
            "Optional parent version used when committing an incremental upload.",
          ],
          files: [
            "Content-addressed file list included in the committed upload.",
          ],
          message: [
            "Optional commit message associated with the storage version.",
          ],
          maintenanceAttestation: [
            "Private validation proof required for Pi memory maintenance publication.",
          ],
        },
      },
    ],
  },
  {
    schema: webhookStoragesCommitContract.commit.responses[200],
    rustModulePath: ["webhooks", "agent", "storages", "commit"],
    rustTypeName: "Response",
    direction: "response",
    declarations: [
      {
        rustTypeName: "Response",
        rustDoc: [
          "Response body returned after committing a direct sandbox storage upload.",
        ],
        fields: {
          success: ["Whether the storage commit succeeded."],
          versionId: ["Committed storage version identifier."],
          storageName: ["Storage name that was committed."],
          size: ["Total committed storage size in bytes."],
          fileCount: [
            "Number of files recorded in the committed storage version.",
          ],
          deduplicated: [
            "Whether the committed version reused existing storage content.",
          ],
        },
      },
    ],
  },
] as const satisfies readonly RustTypeBinding[];
