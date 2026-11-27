import type { NativeContinuation } from "@okouai/api-contracts/contracts/runners";
import type { PaidToolId } from "@okouai/api-contracts/contracts/paid-tools";
import type { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type {
  PermissionManifest,
  ResolvedModelProviderEnvironment,
} from "./agent-run-contracts";
import type { Environment } from "./run-environment";
import type { ConnectorServerFirewallMetadataCatalog } from "./connector-server-firewall-catalog.service";
import type { ResolvedPermissionGrant } from "./connector-network-policy-refresh.service";

/** Captured policy sources; actual artifact expiry is evaluated at publication. */
export interface ExecutionNetworkPolicyInputs {
  readonly catalog: ConnectorServerFirewallMetadataCatalog;
  readonly grants: readonly ResolvedPermissionGrant[];
}

/** Process-local admission facts; this receipt itself is never serialized. */
export interface AdmittedExecutionFacts {
  /** Same member observation as the admission Prompt; later edits affect later Runs. */
  readonly userTimezone: string | undefined;
  readonly nativeContinuation: NativeContinuation;
  readonly featureFlags: {
    readonly [FeatureSwitchKey.ArtifactThreePointTiming]: boolean;
  };
  readonly okouToken: string;
  /** Freshly minted native `agy` credential for an Antigravity run only. */
  readonly disabledPaidTools: readonly PaidToolId[];
  readonly realAgentInPreview: boolean | undefined;
  readonly apiStartTime: number | undefined;
  /** First accepted non-secret Connector environment, before source precedence. */
  readonly connectorEnvironment: Environment;
  readonly integration: string | undefined;
  readonly captureNetworkBodies: boolean;
  /** First accepted source and compiled environment, including its Pi configuration. */
  readonly modelProvider: ResolvedModelProviderEnvironment;
  /** Pure policy for the same accepted provider. */
  readonly modelProviderPermissions: PermissionManifest | undefined;
}
