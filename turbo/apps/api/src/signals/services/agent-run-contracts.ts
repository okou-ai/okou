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
import type { PiModelConfigV4 } from "@okouai/api-contracts/contracts/pi-native";
import type {
  ExpandedFirewallConfig,
  ExecutionFirewalls,
  NetworkPolicies,
} from "@okouai/connectors/firewall-types";
import type { BuiltInModelRuntimeRoute } from "./built-in-model-runtime-route.service";
import type { CodexServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
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
