import type {
  ModelProviderType,
  ModelProviderCodexRuntimeConfig,
} from "@okouai/api-contracts/contracts/model-providers";
import type {
  PiModelConfig,
  SecretConnectorMetadata,
  ConnectorRuntimeTargetRegistration,
} from "@okouai/api-contracts/contracts/runners";
import type {
  ExecutionFirewalls,
  NetworkPolicies,
} from "@okouai/connectors/firewall-types";
import type { BuiltInModelRuntimeRoute } from "./built-in-model-runtime-route.service";

export interface ResolvedModelProviderEnvironment {
  readonly credentialOwner: "builtin" | "member";
  /** Canonical account identity from the same source snapshot as the environment. */
  readonly accountIdentity: string | null;
  readonly authMethod?: string | null;
  readonly piModelConfig?: PiModelConfig;
  readonly id: string | null;
  readonly type: ModelProviderType;
  readonly concreteType?: ModelProviderType;
  readonly environment: Record<string, string>;
  readonly selectedModel: string;
  readonly secretConnectorMap?: Record<string, string>;
  readonly secretConnectorMetadataMap?: Record<string, SecretConnectorMetadata>;
  readonly codexRuntimeConfig?: ModelProviderCodexRuntimeConfig;
  readonly builtInModelRuntimeRoute?: BuiltInModelRuntimeRoute;
  /** Catalog route `upstream_model` placed into the provider environment. */
  readonly upstreamModel: string;
}

type BuiltinRuntimeTargetRegistration = Extract<
  ConnectorRuntimeTargetRegistration,
  { readonly kind: "builtin" }
>;

export interface PermissionManifest {
  readonly firewalls: ExecutionFirewalls;
  readonly networkPolicies: NetworkPolicies;
  readonly builtinRuntimeTargets?: readonly BuiltinRuntimeTargetRegistration[];
  readonly environmentSecretPlaceholders:
    Readonly<Record<string, string>> | undefined;
  readonly billableFirewalls: readonly string[];
}
