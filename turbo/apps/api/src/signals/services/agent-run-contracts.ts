import type {
  ModelProviderCredentialScope,
  ModelProviderType,
  ModelProviderCodexRuntimeConfig,
} from "@okouai/api-contracts/contracts/model-providers";
import type { InternalRunCallbackKind } from "./internal-run-callback";
import type {
  PiModelConfig,
  SecretConnectorMetadata,
  PiModelConfigLegacy,
  StoredConnectorPermissionBaseline,
  ConnectorRuntimeTargetRegistration,
} from "@okouai/api-contracts/contracts/runners";
import type { CreateRunResponse } from "@okouai/api-contracts/contracts/runs";
import type { PiModelConfigV4 } from "@okouai/api-contracts/contracts/pi-native";
import type {
  ExpandedFirewallConfig,
  ExecutionFirewalls,
  NetworkPolicies,
} from "@okouai/connectors/firewall-types";
import type { BuiltInModelRuntimeRoute } from "./built-in-model-runtime-route.service";
import type {
  QueueFirstRunClaimResult,
  QueueFirstRunAssociation,
} from "./chat-queued-event.service";
import type { PendingRunActivation } from "./agent-run-activation.types";
import type { CodexServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import type { ReasoningEffort } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import type { SupportedFramework } from "@okouai/core/frameworks";
import type { ModelCatalog } from "./model-catalog.service";
import type { UsagePricingResolution } from "../context/usage-pricing-resolution";
import type { CapturedPersonalSubscriptionAccount } from "./model-provider-account.service";

export interface AgentRunModelPin {
  readonly modelProvider: string | null;
  readonly modelProviderId: string | null;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope | null;
  readonly selectedModel: string | null;
}

export interface HttpRunCallback {
  readonly url: string;
  readonly secret: string;
  readonly payload: unknown;
}

export interface InternalRunCallback {
  readonly internalKind: InternalRunCallbackKind;
  readonly payload: unknown;
}

export type RunCallback = HttpRunCallback | InternalRunCallback;

export type AgentRunPreCreateSource =
  | "chat_callback_auto_send"
  | "workflow_slash_command";

export interface AgentRunRequestAgent {
  readonly id: string;
  readonly name: string;
  readonly orgId: string;
  readonly defaultAgentId: string | null;
  readonly owner: string;
  readonly visibility: "public" | "private";
  readonly displayName: string | null;
  readonly description: string | null;
  readonly sound: string | null;
  readonly modelProviderId: string | null;
  readonly selectedModel: string | null;
}

export interface AgentRunMetadata {
  // Run provenance for workflow schedule automations.
  readonly workflowAutomationId?: string;
  readonly triggerBrief?: string;
  readonly autonomyBudget?: number;
  readonly codexServiceTier?: CodexServiceTier;
  readonly reasoningEffort?: ReasoningEffort | null;
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

/**
 * A new run's Built-in route selection skips candidates whose billable
 * categories for the requested service tier lack usage_pricing.
 */
interface NewRunRoutePricingRequest {
  readonly serviceTier: CodexServiceTier | undefined;
  readonly resolution: UsagePricingResolution;
}

export interface ResolveModelProviderEnvironmentArgs {
  /** Loaded once per run and shared by every candidate route. */
  readonly catalog: ModelCatalog;
  readonly newRunPricing?: NewRunRoutePricingRequest;
  readonly orgId: string;
  readonly userId: string;
  readonly framework: SupportedFramework;
  readonly modelProviderId?: string;
  readonly modelProviderCredentialScope?: ModelProviderCredentialScope;
  readonly modelProviderType?: string;
  readonly capturedPersonalSubscriptionAccount?: CapturedPersonalSubscriptionAccount;
  readonly selectedModelOverride?: string;
  readonly builtInModelRuntimeRoute?: BuiltInModelRuntimeRoute;
  readonly retainedRunId?: string;
  readonly piExecution: boolean;
  readonly featureSwitchContext: FeatureSwitchContext;
}

/** The model-selection facts of one run that its model environment reads. */
export interface RunModelProviderArgs {
  /** The run's single catalog snapshot; every model decision reads it. */
  readonly catalog: ModelCatalog;
  readonly orgId: string;
  readonly userId: string;
  readonly modelProviderId?: string;
  readonly modelProviderCredentialScope?: ModelProviderCredentialScope;
  readonly modelProviderType?: string;
  /** Captured by the product entry point for this request only. This skips
   * an identity lookup, never the fresh environment or admission checks. */
  readonly capturedPersonalSubscriptionAccount?: CapturedPersonalSubscriptionAccount;
  readonly selectedModelOverride?: string;
  readonly builtInModelRuntimeRoute?: BuiltInModelRuntimeRoute;
  /** Immutable Pi eligibility captured by the caller's admission snapshot. */
  readonly piExecution: boolean;
  readonly retainedRunId?: string;
  readonly codexServiceTier?: "fast" | "ultrafast";
  readonly agentRunMetadata?: AgentRunMetadata;
  readonly queueFirstAssociation?: QueueFirstRunAssociation;
}
