import type {
  OfficialWorkflowAcceptedDefinition,
  OfficialWorkflowAcceptedRevision,
  OfficialWorkflowArtifactReference,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";
import { SYSTEM_ORG_ID, VOLUME_ORG_USER_ID } from "@okouai/core/storage-names";
import type {
  AgentRunOfficialWorkflowDefinitionProvenance,
  AgentRunOfficialWorkflowProvenance,
} from "@okouai/db/jsonb-contracts/agent-run-session-conversation";
import type { PersistedStorageMount } from "@okouai/db/types";
import type { AcceptedOfficialWorkflowCatalog } from "./official-workflow-catalog-read.service";

export const OFFICIAL_WORKFLOW_RUN_ADMISSION_MESSAGE =
  "Official Workflow execution state is not current; retry";

export class OfficialWorkflowRunAdmissionError extends Error {
  constructor(options?: { readonly cause?: unknown }) {
    super(OFFICIAL_WORKFLOW_RUN_ADMISSION_MESSAGE, options);
    this.name = "OfficialWorkflowRunAdmissionError";
  }
}

export interface OfficialWorkflowCandidate {
  readonly workflowId: string;
  readonly workflowName: string;
  readonly definitionName: string;
}

interface OfficialWorkflowRunBlueprintIdentity {
  readonly key: string;
  readonly fingerprint: string;
}

interface ResolvedOfficialWorkflowDefinition extends AgentRunOfficialWorkflowDefinitionProvenance {
  readonly workflowId: string;
  readonly workflowName: string;
  readonly blueprints: readonly OfficialWorkflowRunBlueprintIdentity[];
}

export interface OfficialWorkflowObservation {
  readonly releaseId: string;
  readonly definitions: readonly ResolvedOfficialWorkflowDefinition[];
  readonly provenance: AgentRunOfficialWorkflowProvenance;
}

export interface ResolvedOfficialWorkflowRunDefinition extends ResolvedOfficialWorkflowDefinition {
  readonly mountPath: string;
}

export interface OfficialWorkflowRunObservation extends OfficialWorkflowObservation {
  readonly definitions: readonly ResolvedOfficialWorkflowRunDefinition[];
}

export function artifactMatches(
  provenance: AgentRunOfficialWorkflowDefinitionProvenance["artifact"],
  artifact: OfficialWorkflowArtifactReference,
): boolean {
  return (
    provenance.orgId === SYSTEM_ORG_ID &&
    provenance.userId === VOLUME_ORG_USER_ID &&
    provenance.storageName === artifact.storageName &&
    provenance.storageId === artifact.storageId &&
    provenance.storageVersion === artifact.storageVersion
  );
}

function acceptedArtifactsMatch(
  left: OfficialWorkflowArtifactReference,
  right: OfficialWorkflowArtifactReference,
): boolean {
  return (
    left.storageName === right.storageName &&
    left.storageId === right.storageId &&
    left.storageVersion === right.storageVersion
  );
}

export function blueprintIdentities(
  definition: OfficialWorkflowAcceptedDefinition,
): readonly OfficialWorkflowRunBlueprintIdentity[] {
  return definition.blueprints.map((blueprint) => {
    return { key: blueprint.key, fingerprint: blueprint.fingerprint };
  });
}

export function blueprintIdentitiesMatch(
  left: readonly OfficialWorkflowRunBlueprintIdentity[],
  right: readonly OfficialWorkflowRunBlueprintIdentity[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightByKey = new Map(
    right.map((blueprint) => {
      return [blueprint.key, blueprint.fingerprint] as const;
    }),
  );
  return left.every((blueprint) => {
    return rightByKey.get(blueprint.key) === blueprint.fingerprint;
  });
}

function acceptedRevisionMatchesDefinition(
  definition: OfficialWorkflowAcceptedDefinition,
  revision: OfficialWorkflowAcceptedRevision,
): boolean {
  return (
    revision.definition.name === definition.name &&
    revision.definition.revision === definition.revision &&
    acceptedArtifactsMatch(revision.artifact, definition.artifact) &&
    blueprintIdentitiesMatch(
      blueprintIdentities(definition),
      revision.definition.blueprints.map((blueprint) => {
        return { key: blueprint.key, fingerprint: blueprint.fingerprint };
      }),
    )
  );
}

export function acceptedRevisionsMatchDefinitions(
  definitions: readonly OfficialWorkflowAcceptedDefinition[],
  revisions: readonly (OfficialWorkflowAcceptedRevision | null)[],
): boolean {
  return definitions.every((definition, index) => {
    const revision = revisions[index];
    return (
      revision !== null &&
      revision !== undefined &&
      acceptedRevisionMatchesDefinition(definition, revision)
    );
  });
}

export function acceptedDefinitionForName(
  definitions: readonly OfficialWorkflowAcceptedDefinition[],
  name: string,
): OfficialWorkflowAcceptedDefinition | null {
  const matches = definitions.filter((definition) => {
    return definition.name === name;
  });
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function provenanceDefinition(
  definition: ResolvedOfficialWorkflowDefinition,
): AgentRunOfficialWorkflowDefinitionProvenance {
  return {
    name: definition.name,
    revision: definition.revision,
    artifact: definition.artifact,
  };
}

interface AcceptedWorkflowCandidate {
  readonly candidate: OfficialWorkflowCandidate;
  readonly accepted: OfficialWorkflowAcceptedDefinition;
}

export function acceptedWorkflowCandidates(
  catalog: AcceptedOfficialWorkflowCatalog,
  candidates: readonly OfficialWorkflowCandidate[],
): readonly AcceptedWorkflowCandidate[] {
  const orderedCandidates = [...candidates].sort((left, right) => {
    return (
      left.definitionName.localeCompare(right.definitionName) ||
      left.workflowId.localeCompare(right.workflowId)
    );
  });
  const definitionNames = new Set<string>();
  const workflowIds = new Set<string>();
  const workflowNames = new Set<string>();
  return orderedCandidates.map((candidate) => {
    if (
      definitionNames.has(candidate.definitionName) ||
      workflowIds.has(candidate.workflowId) ||
      workflowNames.has(candidate.workflowName)
    ) {
      throw new OfficialWorkflowRunAdmissionError();
    }
    definitionNames.add(candidate.definitionName);
    workflowIds.add(candidate.workflowId);
    workflowNames.add(candidate.workflowName);

    const accepted = acceptedDefinitionForName(
      catalog.payload.definitions,
      candidate.definitionName,
    );
    if (!accepted) {
      throw new OfficialWorkflowRunAdmissionError();
    }
    return { candidate, accepted };
  });
}

export function assembleWorkflowObservation(
  catalog: AcceptedOfficialWorkflowCatalog,
  acceptedCandidates: readonly AcceptedWorkflowCandidate[],
  revisions: readonly (OfficialWorkflowAcceptedRevision | null)[],
): OfficialWorkflowObservation {
  const definitions = acceptedCandidates.map(
    ({ candidate, accepted }, index): ResolvedOfficialWorkflowDefinition => {
      const revision = revisions[index];
      if (!revision || !acceptedRevisionMatchesDefinition(accepted, revision)) {
        throw new OfficialWorkflowRunAdmissionError();
      }
      return {
        workflowId: candidate.workflowId,
        workflowName: candidate.workflowName,
        name: accepted.name,
        revision: accepted.revision,
        artifact: {
          orgId: SYSTEM_ORG_ID,
          userId: VOLUME_ORG_USER_ID,
          storageName: accepted.artifact.storageName,
          storageId: accepted.artifact.storageId,
          storageVersion: accepted.artifact.storageVersion,
        },
        blueprints: blueprintIdentities(accepted),
      };
    },
  );

  return {
    releaseId: catalog.releaseId,
    definitions,
    provenance: {
      schemaVersion: 1,
      definitions: definitions.map(provenanceDefinition),
    },
  };
}

export function lockedInstallationMatches(
  expected: ResolvedOfficialWorkflowRunDefinition,
  row: {
    readonly id: string;
    readonly orgId: string;
    readonly agentId: string;
    readonly name: string;
    readonly visibility: string;
    readonly ownerUserId: string;
    readonly officialDefinitionName: string | null;
    readonly officialInstallationState: string | null;
  },
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string | null;
  },
): boolean {
  return (
    row.id === expected.workflowId &&
    row.orgId === args.orgId &&
    row.agentId === args.agentId &&
    row.name === expected.workflowName &&
    row.visibility === "private" &&
    row.ownerUserId === args.userId &&
    row.officialDefinitionName === expected.name &&
    row.officialInstallationState === "installed"
  );
}

export function exactMountsMatch(
  observation: OfficialWorkflowRunObservation,
  mounts: readonly PersistedStorageMount[] | undefined,
): boolean {
  if (!mounts) {
    return false;
  }
  return observation.definitions.every((definition) => {
    const matches = mounts.filter((mount) => {
      return mount.mountPath === definition.mountPath;
    });
    if (matches.length !== 1) {
      return false;
    }
    const [mount] = matches;
    return (
      mount?.orgId === SYSTEM_ORG_ID &&
      mount.userId === VOLUME_ORG_USER_ID &&
      mount.name === definition.artifact.storageName &&
      mount.storageId === definition.artifact.storageId &&
      mount.version === definition.artifact.storageVersion &&
      mount.writeback !== true
    );
  });
}
