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
import { workflowAutomations, workflows } from "@okouai/db/schema/workflow";
import type { PersistedStorageMount } from "@okouai/db/types";
import { asc, eq, inArray } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import {
  type AcceptedOfficialWorkflowCatalog,
  lockAcceptedOfficialWorkflowCatalog,
  readAcceptedOfficialWorkflowCatalog,
  readAcceptedOfficialWorkflowRevisions,
} from "./official-workflow-catalog-read.service";

export const OFFICIAL_WORKFLOW_RUN_ADMISSION_MESSAGE =
  "Official Workflow execution state is not current; retry";

export class OfficialWorkflowRunAdmissionError extends Error {
  constructor(options?: { readonly cause?: unknown }) {
    super(OFFICIAL_WORKFLOW_RUN_ADMISSION_MESSAGE, options);
    this.name = "OfficialWorkflowRunAdmissionError";
  }
}

export interface OfficialWorkflowRunCandidate {
  readonly workflowId: string;
  readonly workflowName: string;
  readonly definitionName: string;
  readonly mountPath: string;
}

interface OfficialWorkflowRunBlueprintIdentity {
  readonly key: string;
  readonly fingerprint: string;
}

export interface ResolvedOfficialWorkflowRunDefinition extends AgentRunOfficialWorkflowDefinitionProvenance {
  readonly workflowId: string;
  readonly workflowName: string;
  readonly mountPath: string;
  readonly blueprints: readonly OfficialWorkflowRunBlueprintIdentity[];
}

export interface OfficialWorkflowRunObservation {
  readonly releaseId: string;
  readonly definitions: readonly ResolvedOfficialWorkflowRunDefinition[];
  readonly provenance: AgentRunOfficialWorkflowProvenance;
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
  definition: ResolvedOfficialWorkflowRunDefinition,
): AgentRunOfficialWorkflowDefinitionProvenance {
  return {
    name: definition.name,
    revision: definition.revision,
    artifact: definition.artifact,
  };
}

interface AcceptedRunCandidate {
  readonly candidate: OfficialWorkflowRunCandidate;
  readonly accepted: OfficialWorkflowAcceptedDefinition;
}

export function acceptedRunCandidates(
  catalog: AcceptedOfficialWorkflowCatalog,
  candidates: readonly OfficialWorkflowRunCandidate[],
): readonly AcceptedRunCandidate[] {
  const orderedCandidates = [...candidates].sort((left, right) => {
    return (
      left.definitionName.localeCompare(right.definitionName) ||
      left.workflowId.localeCompare(right.workflowId)
    );
  });
  const definitionNames = new Set<string>();
  const workflowIds = new Set<string>();
  const mountPaths = new Set<string>();
  return orderedCandidates.map((candidate) => {
    if (
      definitionNames.has(candidate.definitionName) ||
      workflowIds.has(candidate.workflowId) ||
      mountPaths.has(candidate.mountPath)
    ) {
      throw new OfficialWorkflowRunAdmissionError();
    }
    definitionNames.add(candidate.definitionName);
    workflowIds.add(candidate.workflowId);
    mountPaths.add(candidate.mountPath);

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

export function assembleRunObservation(
  catalog: AcceptedOfficialWorkflowCatalog,
  acceptedCandidates: readonly AcceptedRunCandidate[],
  revisions: readonly (OfficialWorkflowAcceptedRevision | null)[],
): OfficialWorkflowRunObservation {
  const definitions = acceptedCandidates.map(
    ({ candidate, accepted }, index): ResolvedOfficialWorkflowRunDefinition => {
      const revision = revisions[index];
      if (!revision || !acceptedRevisionMatchesDefinition(accepted, revision)) {
        throw new OfficialWorkflowRunAdmissionError();
      }
      return {
        workflowId: candidate.workflowId,
        workflowName: candidate.workflowName,
        mountPath: candidate.mountPath,
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

async function officialAutomationMatches(
  tx: Tx,
  args: {
    readonly automationId: string | undefined;
    readonly orgId: string;
    readonly userId: string;
    readonly observation: OfficialWorkflowRunObservation;
  },
): Promise<boolean> {
  if (!args.automationId) {
    return true;
  }
  const [row] = await tx
    .select({
      id: workflowAutomations.id,
      orgId: workflowAutomations.orgId,
      workflowId: workflowAutomations.workflowId,
      ownerUserId: workflowAutomations.ownerUserId,
      blueprintKey: workflowAutomations.officialBlueprintKey,
      appliedFingerprint: workflowAutomations.officialAppliedFingerprint,
      reconciliationStatus: workflowAutomations.officialReconciliationStatus,
      definitionName: workflows.officialDefinitionName,
    })
    .from(workflowAutomations)
    .innerJoin(workflows, eq(workflows.id, workflowAutomations.workflowId))
    .where(eq(workflowAutomations.id, args.automationId))
    .limit(1)
    .for("update");
  if (!row) {
    return false;
  }
  if (row.orgId !== args.orgId || row.ownerUserId !== args.userId) {
    return false;
  }
  if (row.blueprintKey === null) {
    return row.definitionName === null;
  }
  const definition = args.observation.definitions.find((candidate) => {
    return candidate.workflowId === row.workflowId;
  });
  if (
    !definition ||
    row.definitionName !== definition.name ||
    row.appliedFingerprint === null ||
    row.reconciliationStatus !== "current"
  ) {
    return false;
  }
  const blueprint = definition.blueprints.find((candidate) => {
    return candidate.key === row.blueprintKey;
  });
  return blueprint?.fingerprint === row.appliedFingerprint;
}
