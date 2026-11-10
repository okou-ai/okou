import type {
  OfficialWorkflowAcceptedDefinition,
  OfficialWorkflowAcceptedRevision,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";
import type {
  AgentRunOfficialWorkflowDefinitionProvenance,
  AgentRunOfficialWorkflowBundleDefinitionProvenance,
  AgentRunOfficialWorkflowProvenance,
} from "@okouai/db/jsonb-contracts/agent-run-session-conversation";
import type { PersistedStorageMount } from "@okouai/db/types";
import type { AcceptedOfficialWorkflowCatalog } from "./official-workflow-catalog-read.service";

export const OFFICIAL_WORKFLOW_RUN_ADMISSION_MESSAGE =
  "Official Workflow execution state is not current; retry";

export class OfficialWorkflowRunAdmissionError extends Error {
  constructor(options?: {
    readonly cause?: unknown;
    readonly message?: string;
  }) {
    super(options?.message ?? OFFICIAL_WORKFLOW_RUN_ADMISSION_MESSAGE, options);
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

type ResolvedOfficialWorkflowDefinition =
  AgentRunOfficialWorkflowBundleDefinitionProvenance & {
    readonly workflowId: string;
    readonly workflowName: string;
    readonly blueprints: readonly OfficialWorkflowRunBlueprintIdentity[];
  };

export interface OfficialWorkflowObservation {
  readonly releaseId: string;
  readonly definitions: readonly ResolvedOfficialWorkflowDefinition[];
  readonly provenance: Extract<
    AgentRunOfficialWorkflowProvenance,
    { readonly schemaVersion: 2 }
  >;
}

export type ResolvedOfficialWorkflowRunDefinition =
  ResolvedOfficialWorkflowDefinition & {
    readonly mountPath: string;
  };

export interface OfficialWorkflowRunObservation extends OfficialWorkflowObservation {
  readonly definitions: readonly ResolvedOfficialWorkflowRunDefinition[];
}

function acceptedDeliveryMatches(
  left: Pick<OfficialWorkflowAcceptedRevision, "contentBundle">,
  right: Pick<OfficialWorkflowAcceptedDefinition, "contentBundle">,
): boolean {
  return (
    left.contentBundle.sha256 === right.contentBundle.sha256 &&
    left.contentBundle.archiveBytes === right.contentBundle.archiveBytes
  );
}

export function observedDeliveryMatches(
  observed: AgentRunOfficialWorkflowDefinitionProvenance,
  definition: OfficialWorkflowAcceptedDefinition,
): boolean {
  return (
    observed.contentBundle?.sha256 === definition.contentBundle.sha256 &&
    observed.contentBundle.archiveBytes ===
      definition.contentBundle.archiveBytes
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
    acceptedDeliveryMatches(revision, definition) &&
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
        contentBundle: accepted.contentBundle,
        blueprints: blueprintIdentities(accepted),
      };
    },
  );

  return {
    releaseId: catalog.releaseId,
    definitions,
    provenance: {
      schemaVersion: 2,
      definitions: definitions.map((definition) => {
        return {
          name: definition.name,
          revision: definition.revision,
          contentBundle: definition.contentBundle,
        };
      }),
    },
  };
}

export function exactMountsMatch(
  observation: OfficialWorkflowRunObservation,
  mounts: readonly PersistedStorageMount[] | undefined,
): boolean {
  if (!mounts) {
    return false;
  }
  return observation.definitions.every((definition) => {
    return !mounts.some((mount) => {
      return mount.mountPath === definition.mountPath;
    });
  });
}
