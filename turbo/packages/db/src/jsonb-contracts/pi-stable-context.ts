import type { TriggerSource } from "@okouai/api-contracts/contracts/logs";

import type { PersistedStorageMount } from "../types";
import type { PiResourceSnapshotV1 } from "./pi-resource-snapshot";

/** API-only resolved mount identity. Signed archive URLs are never persisted. */
export interface PiStableContextStorageMount {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly storageId: string;
  readonly versionId: string;
  readonly mountPath: string;
  readonly archiveSize?: number;
  readonly empty?: boolean;
  readonly baselineCandidate?: true;
  readonly instructionsTargetFilename?: string;
  readonly missingRootPolicy?: "fail" | "preserveParentVersion";
  readonly writeback?: boolean;
}

export interface PiStableContextOwner {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly resourceOwner: {
    readonly orgId: string;
    readonly userId: string;
  };
}

export interface PiStableContextSourceVector {
  readonly agentGeneration: number;
  readonly userGeneration: number;
  readonly catalogIdentity: string | null;
  /** Exact connector-catalog authority; test-scoped sources must not cross. */
  readonly catalogSourceId: string | null;
  readonly agentIdentityDigest: string;
  readonly featurePromptDigest: string;
  readonly permissionDigest: string;
  readonly connectorScopeDigest: string;
  /** Earliest grant expiry represented by the projection. */
  readonly validityHorizon: string | null;
  readonly promptSchemaVersion: number;
  readonly runtimeSchemaVersion: number;
  readonly extractorVersion: number;
}

export interface PiStableContextPromptProjection {
  readonly agentIdentity: string;
  readonly executionLimit: string;
  readonly tools: string;
}

export interface PiStableContextPromptInputs {
  readonly privateArtifactsEnabled: boolean;
  readonly bankingEnabled: boolean;
  readonly vncEnabled: boolean;
  readonly larkEnabled: boolean;
  readonly deliveryFormatGuidanceEnabled: boolean;
  readonly presentationConvertEnabled: boolean;
  readonly customConnectorMcpEnabled: boolean;
  readonly triggerSource: TriggerSource;
  readonly cloudBrowserEnabled: boolean | undefined;
}

export interface PiStableContextSemanticInput {
  readonly promptInputs: PiStableContextPromptInputs;
  readonly connectorScope: {
    readonly allowedConnectorSlugs: readonly string[];
    readonly allowedCustomConnectorIds: readonly string[];
    readonly customConnectorGrants: readonly {
      readonly customConnectorId: string;
      readonly permissionNames: readonly string[];
    }[];
    readonly customConnectorDefinitions: readonly {
      readonly customConnectorId: string;
      readonly connectorSlug: string;
      readonly storageVersion: number;
      readonly skillStorageVersionId: string | null;
      readonly isMcp: boolean;
    }[];
    readonly workflows: readonly {
      readonly name: string;
      readonly workflowId: string;
      readonly officialDefinitionName: string | null;
    }[];
  };
}

/**
 * Immutable captured input for one generation. A worker may only compose from
 * these exact values and the immutable resource-version indexes they name.
 */
export interface PiStableContextBuildInput {
  readonly schemaVersion: 1;
  readonly owner: PiStableContextOwner;
  readonly source: PiStableContextSourceVector;
  readonly prompt: PiStableContextPromptProjection;
  /** Raw, nonsecret semantic membership supports exact writer-side recapture. */
  readonly semantic?: PiStableContextSemanticInput;
  readonly storageMounts: readonly PiStableContextStorageMount[];
  readonly persistedStorageMounts: readonly PersistedStorageMount[];
}

/** Immutable, model-visible stable context. Memory and request data bind later. */
export interface PiStableContextProjection {
  readonly schemaVersion: 1;
  readonly owner: PiStableContextOwner;
  readonly source: PiStableContextSourceVector;
  readonly prompt: PiStableContextPromptProjection;
  readonly storageMounts: readonly PiStableContextStorageMount[];
  readonly persistedStorageMounts: readonly PersistedStorageMount[];
  readonly resourceSnapshot: PiResourceSnapshotV1;
}
