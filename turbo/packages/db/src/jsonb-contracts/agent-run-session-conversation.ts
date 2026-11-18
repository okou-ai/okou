import type { ContentBundle } from "./content-bundle";
import type { PersistedStorageMount } from "../types";
import type { JsonValue } from "./shared";
import type { RunExecutionAuthorization } from "@okouai/api-contracts/contracts/run-execution-authorization";

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
  | AgentRunLaunchSnapshotV3
  | AgentRunLaunchSnapshotV5;
/** Native history stays only in the retained sandbox/home for this producer. */
export interface AgentRunLaunchSnapshotV5 {
  schemaVersion: 5;
  framework: "claude-code" | "codex" | "pi";
  runnerProfile: string;
  /** Absent only on Runs admitted before authorization capture was deployed. */
  executionAuthorization?: RunExecutionAuthorization;
}
export type AgentRunLaunchSnapshot = AgentRunFullLaunchSnapshot;
export interface AgentRunOfficialWorkflowStorageDefinitionProvenance {
  readonly contentBundle?: never;
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
export interface AgentRunOfficialWorkflowBundleDefinitionProvenance {
  readonly name: string;
  readonly revision: string;
  readonly contentBundle: ContentBundle;
  readonly artifact?: never;
}
export type AgentRunOfficialWorkflowDefinitionProvenance =
  | AgentRunOfficialWorkflowStorageDefinitionProvenance
  | AgentRunOfficialWorkflowBundleDefinitionProvenance;
export type AgentRunOfficialWorkflowProvenance =
  | {
      readonly schemaVersion: 1;
      readonly definitions: readonly AgentRunOfficialWorkflowStorageDefinitionProvenance[];
    }
  | {
      readonly schemaVersion: 2;
      readonly definitions: readonly AgentRunOfficialWorkflowBundleDefinitionProvenance[];
    };
export type AgentRunResult = JsonValue;
export type AgentRunStorageMounts = PersistedStorageMount[];
