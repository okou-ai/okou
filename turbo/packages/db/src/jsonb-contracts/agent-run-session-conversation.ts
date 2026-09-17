import type { PersistedStorageMount } from "../types";
import type { JsonValue } from "./shared";

export type AgentRunVars = JsonValue;
export type AgentRunSecretNames = string[];
export interface AgentRunLaunchSnapshotV1 {
  schemaVersion: 1;
  framework: "claude-code" | "codex" | "pi";
  runnerProfile: string;
}
export interface AgentRunLaunchSnapshotV2 {
  schemaVersion: 2;
  framework: "claude-code" | "codex" | "pi";
  runnerProfile: string;
  piMemoryGenerationEnabled: boolean;
}
export interface AgentRunLaunchSnapshotV3 {
  schemaVersion: 3;
  framework: "claude-code" | "codex" | "pi";
  runnerProfile: string;
}
export type AgentRunFullLaunchSnapshot =
  | AgentRunLaunchSnapshotV1
  | AgentRunLaunchSnapshotV2
  | AgentRunLaunchSnapshotV3;
/** Immutable discriminator; the same run ID addresses the exact inference input. */
export interface AgentRunLaunchSnapshotV4 {
  schemaVersion: 4;
  framework: "pi";
  executionMode: "api-inference";
  inferenceContractVersion: 1;
}
export type AgentRunLaunchSnapshot =
  | AgentRunFullLaunchSnapshot
  | AgentRunLaunchSnapshotV4;
export interface AgentRunOfficialWorkflowDefinitionProvenance {
  readonly name: string;
  readonly revision: string;
  readonly artifact: {
    readonly orgId: string;
    readonly userId: string;
    readonly storageName: string;
    readonly storageId: string;
    readonly storageVersion: string;
  };
}
export interface AgentRunOfficialWorkflowProvenance {
  readonly schemaVersion: 1;
  readonly definitions: readonly AgentRunOfficialWorkflowDefinitionProvenance[];
}
export type AgentRunResult = JsonValue;
export type AgentRunStorageMounts = PersistedStorageMount[];
export type AgentSessionStorageMounts = PersistedStorageMount[];
