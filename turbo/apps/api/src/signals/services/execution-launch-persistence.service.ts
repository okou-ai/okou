/**
 * Atomic run launch persistence shared by execution owners: the pending
 * run/session/callback/runner-job rows, captured subscription validation and
 * the committed launch response. Moved verbatim out of the legacy execution
 * graph; owners (Thread, Pi maintenance) assemble their payloads privately.
 */
import type {
  PiModelConfig,
  StoredExecutionContext,
  StorageMountEntry,
  SecretConnectorMetadata,
  PiModelConfigLegacy,
  StoredConnectorPermissionBaseline,
  ConnectorRuntimeTargetRegistration,
} from "@okouai/api-contracts/contracts/runners";
import type {
  ModelProviderType,
  ModelProviderCodexRuntimeConfig,
} from "@okouai/api-contracts/contracts/model-providers";
import type {
  AgentExecutionConfig as agentRunCreateAgentExecutionConfig,
  AgentExecutionDefinition,
} from "./agent-execution-config";
import { z } from "zod";
import {
  unifiedRunRequestSchema,
  type CreateRunResponse,
} from "@okouai/api-contracts/contracts/runs";
import type { TriggerSource } from "@okouai/api-contracts/contracts/logs";
import type { PiModelConfigV4 } from "@okouai/api-contracts/contracts/pi-native";
import type {
  ExpandedFirewallConfig,
  ExecutionFirewalls,
  NetworkPolicies,
} from "@okouai/connectors/firewall-types";
import type { BuiltInModelRuntimeRoute } from "./built-in-model-runtime-route.service";
import type { QueueFirstRunClaimResult } from "./chat-queued-event.service";
import type { PendingRunActivation } from "./agent-run-activation.types";
import type { CodexServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import type { ReasoningEffort } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { historyGenerationRunIdForStoredExecutionContext } from "./history-generation-run";

export type StorageManifestSource =
  | "system_skill"
  | "connector_skill"
  | "custom_connector_skill"
  | "official_workflow"
  | "workflow_skill"
  | "request_additional_volume"
  | "compose_additional_volume"
  | "compose_volume"
  | "artifact"
  | "unknown";

export type ArtifactMissingRootPolicy = NonNullable<
  StorageMountEntry["missingRootPolicy"]
>;

export type CreateRunBody = Omit<
  z.infer<typeof unifiedRunRequestSchema>,
  "triggerSource"
> & {
  readonly triggerSource: TriggerSource;
};

export interface AgentRunCreateContextArtifact {
  readonly name: string;
  readonly version?: string;
  readonly mountPath: string;
  readonly missingRootPolicy?: ArtifactMissingRootPolicy;
}

export interface AgentRunMetadata {
  // Run provenance for workflow schedule automations.
  readonly workflowAutomationId?: string;
  readonly triggerBrief?: string;
  readonly autonomyBudget?: number;
  readonly codexServiceTier?: CodexServiceTier;
  readonly reasoningEffort?: ReasoningEffort | null;
}

export interface RunnerJobPayload {
  readonly runnerGroup: string;
  readonly profile: string;
  readonly cliAgentSessionId: string | null;
  readonly reuseKey: string | null;
  readonly historyGenerationRunId: string | undefined;
  readonly executionContext: StoredExecutionContext;
}

export function runnerJobPayload(args: {
  readonly runnerGroup: string;
  readonly profile: string;
  readonly cliAgentSessionId: string | null;
  readonly reuseKey: string | null;
  readonly executionContext: StoredExecutionContext;
}): RunnerJobPayload {
  return {
    runnerGroup: args.runnerGroup,
    profile: args.profile,
    cliAgentSessionId: args.cliAgentSessionId,
    reuseKey: args.reuseKey,
    historyGenerationRunId: historyGenerationRunIdForStoredExecutionContext(
      args.executionContext,
    ),
    executionContext: args.executionContext,
  };
}

export type QueueFirstRunClaimed = Extract<
  QueueFirstRunClaimResult,
  { readonly kind: "claimed" }
>;

type CreateRunSuccessResult = {
  readonly status: 201;
  readonly body: CreateRunResponse;
  readonly queueFirstClaim?: QueueFirstRunClaimed;
  readonly pendingActivation?: PendingRunActivation;
};

export interface ResolvedModelProviderEnvironment {
  readonly credentialOwner: PiModelConfigV4["credentialOwner"];
  readonly authMethod?: string | null;
  readonly piModelConfig?: PiModelConfig;
  readonly id: string | null;
  readonly type: ModelProviderType;
  readonly concreteType?: ModelProviderType;
  readonly environment: Record<string, string>;
  readonly secrets: Record<string, string>;
  readonly selectedModel: string | null;
  readonly firewall?: ExpandedFirewallConfig;
  readonly inlineFirewall?: boolean;
  readonly secretConnectorMap?: Record<string, string>;
  readonly secretConnectorMetadataMap?: Record<string, SecretConnectorMetadata>;
  readonly codexRuntimeConfig?: ModelProviderCodexRuntimeConfig;
  readonly builtInModelRuntimeRoute?: BuiltInModelRuntimeRoute;
  /** Catalog route `upstream_model` placed into the provider environment. */
  readonly upstreamModel?: string;
  readonly credentialHeader?: NonNullable<
    PiModelConfigLegacy["credentialHeader"]
  >;
}

export type BuiltinRuntimeTargetRegistration = Extract<
  ConnectorRuntimeTargetRegistration,
  { readonly kind: "builtin" }
>;

export interface PermissionManifest {
  readonly firewalls: ExecutionFirewalls;
  readonly networkPolicies: NetworkPolicies;
  readonly builtinRuntimeTargets?: readonly BuiltinRuntimeTargetRegistration[];
  readonly connectorPermissionBaseline?: StoredConnectorPermissionBaseline;
  readonly environmentSecretPlaceholders:
    | Readonly<Record<string, string>>
    | undefined;
  readonly billableFirewalls: readonly string[];
}

export type ApiErrorResponse<Status extends number, Code extends string> = {
  readonly status: Status;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: Code;
    };
  };
};

export type CreateRunRouteResult =
  | CreateRunSuccessResult
  | ApiErrorResponse<400, "BAD_REQUEST">
  | ApiErrorResponse<403, "FORBIDDEN">
  | ApiErrorResponse<404, "NOT_FOUND">
  | (ApiErrorResponse<409, "CONFLICT"> & {
      /** Producer-facing classification; the HTTP response body is unchanged. */
      readonly admissionFailure?: "subscription_account_disconnected";
    })
  | ApiErrorResponse<402, "INSUFFICIENT_CREDITS">
  | ApiErrorResponse<402, "PRO_REQUIRED">
  | ApiErrorResponse<503, "PROVIDER_UNAVAILABLE">;

export type CreateRunErrorResult = Exclude<
  CreateRunRouteResult,
  { readonly status: 201 }
>;

export function firstAgent(
  content: agentRunCreateAgentExecutionConfig,
): AgentExecutionDefinition | undefined {
  if (content.agent) {
    return content.agent;
  }
  if (!content.agents) {
    return undefined;
  }
  const firstKey = Object.keys(content.agents)[0];
  return firstKey ? content.agents[firstKey] : undefined;
}

export function runnerGroup(
  content: agentRunCreateAgentExecutionConfig,
): string | null {
  return firstAgent(content)?.experimental_runner?.group ?? null;
}
