import type {
  NativeContinuation,
  PreparedExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import type { PaidToolId } from "@okouai/api-contracts/contracts/paid-tools";
import type { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type {
  PermissionManifest,
  ResolvedModelProviderEnvironment,
} from "./agent-run-contracts";
import type { ResolvedSkillVolume } from "./run-prompt-and-skills";

import type { Environment } from "./run-environment";
import type { ConnectorServerFirewallMetadataCatalog } from "./connector-server-firewall-catalog.service";
import type { ResolvedPermissionGrant } from "./user-permission-grants.service";
import type { CapturedExecutionPackages } from "./execution-workflow-selection";

/** Captured policy sources; actual artifact expiry is evaluated at publication. */
export interface ExecutionNetworkPolicyInputs {
  readonly catalog: ConnectorServerFirewallMetadataCatalog;
  readonly grants: readonly ResolvedPermissionGrant[];
}

/** Process-local admission facts; this receipt itself is never serialized. */
export interface AdmittedExecutionFacts {
  readonly executionPackages: CapturedExecutionPackages;
  readonly skillRoot: string;
  readonly skillMounts: readonly ResolvedSkillVolume[];
  readonly officialWorkflowBundles: PreparedExecutionContext["officialWorkflowBundles"];
  /** Same member observation as the admission Prompt; later edits affect later Runs. */
  readonly userTimezone: string | undefined;
  readonly nativeContinuation: NativeContinuation;
  readonly customWorkflowSelection: PreparedExecutionContext["customWorkflowSelection"];
  readonly featureFlags: Readonly<
    Record<
      | FeatureSwitchKey.ArtifactGenerationTiming
      | FeatureSwitchKey.ArtifactThreePointTiming
      | FeatureSwitchKey.SingleAgent
      | FeatureSwitchKey.ConnectorChatAccountAccess,
      boolean
    >
  >;
  readonly okouToken: string;
  readonly disabledPaidTools: readonly PaidToolId[];
  readonly realAgentInPreview: boolean | undefined;
  readonly apiStartTime: number | undefined;
  /** First accepted non-secret Connector environment, before source precedence. */
  readonly connectorEnvironment: Environment;
  readonly connectorNetworkPolicyInputs: ExecutionNetworkPolicyInputs | null;
  readonly integration: string | undefined;
  readonly captureNetworkBodies: boolean;
  /** First accepted source and compiled environment, including its Pi configuration. */
  readonly modelProvider: ResolvedModelProviderEnvironment;
  /** Pure policy for the same accepted provider. */
  readonly modelProviderPermissions: PermissionManifest | undefined;
}
