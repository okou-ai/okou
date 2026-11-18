import type {
  ConnectorRuntimeTargetRegistration,
  NativeContinuation,
  PiModelConfig,
  PreparedExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import type { PaidToolId } from "@okouai/api-contracts/contracts/paid-tools";
import type { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { PermissionManifest } from "./agent-run-contracts";
import type {
  SeedSkillVolume,
  TemplateSkillVolume,
} from "./run-prompt-and-skills";

/** Process-local admission facts; this receipt itself is never serialized. */
export interface AdmittedExecutionFacts {
  /** Same member observation as the admission Prompt; later edits affect later Runs. */
  readonly userTimezone: string | undefined;
  /** Accepted immutable Seed contributions, before framework paths and overlays. */
  readonly seedSkillVolumes: readonly SeedSkillVolume[];
  readonly nativeContinuation: NativeContinuation;
  readonly customWorkflowSelection: PreparedExecutionContext["customWorkflowSelection"];
  readonly featureFlags: Readonly<
    Record<
      | FeatureSwitchKey.ArtifactGenerationTiming
      | FeatureSwitchKey.SingleAgent
      | FeatureSwitchKey.ConnectorChatAccountAccess,
      boolean
    >
  >;
  readonly okouToken: string;
  readonly disabledPaidTools: readonly PaidToolId[];
  readonly previewBypassAuthorized: boolean;
  readonly realAgentInPreview: boolean | undefined;
  readonly apiStartTime: number | undefined;
  readonly connectorRuntimeTargets: readonly ConnectorRuntimeTargetRegistration[];
  /** First accepted template snapshot; later edits apply to subsequent Runs. */
  readonly templateSkillVolumes: readonly TemplateSkillVolume[];
  readonly integration: string | undefined;
  readonly captureNetworkBodies: boolean;
  readonly piModelConfig: PiModelConfig | undefined;
  /** Pure pinned-provider policy; runtime still reloads credential sources. */
  readonly modelProviderPermissions: PermissionManifest | undefined;
}
