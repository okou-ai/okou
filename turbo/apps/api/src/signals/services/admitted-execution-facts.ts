import type {
  ConnectorRuntimeTargetRegistration,
  PiModelConfig,
} from "@okouai/api-contracts/contracts/runners";
import type { ChatEventUserMessage } from "@okouai/db/schema/chat-event";
import type { PermissionManifest } from "./agent-run-contracts";

/** Process-local admission facts; this receipt itself is never serialized. */
export interface AdmittedExecutionFacts {
  readonly connectorRuntimeTargets: readonly ConnectorRuntimeTargetRegistration[];
  readonly templateInput: {
    readonly userId: string;
    readonly userMessage: ChatEventUserMessage | null;
  };
  readonly integration: string | undefined;
  readonly captureNetworkBodies: boolean;
  readonly piModelConfig: PiModelConfig | undefined;
  /** Pure pinned-provider policy; runtime still reloads credential sources. */
  readonly modelProviderPermissions: PermissionManifest | undefined;
}
