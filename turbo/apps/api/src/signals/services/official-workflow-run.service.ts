import type {
  OfficialWorkflowAcceptedDefinition,
  OfficialWorkflowAcceptedRevision,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";
import type {
  AgentRunOfficialWorkflowBundleDefinitionProvenance,
  AgentRunOfficialWorkflowProvenance,
} from "@okouai/db/jsonb-contracts/agent-run-session-conversation";

const OFFICIAL_WORKFLOW_RUN_ADMISSION_MESSAGE =
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

interface OfficialWorkflowRunBlueprintIdentity {
  readonly key: string;
  readonly fingerprint: string;
}

type ResolvedOfficialWorkflowDefinition =
  AgentRunOfficialWorkflowBundleDefinitionProvenance & {
    readonly workflowId: string;
  };

export interface OfficialWorkflowObservation {
  readonly definitions: readonly ResolvedOfficialWorkflowDefinition[];
  readonly provenance: Extract<
    AgentRunOfficialWorkflowProvenance,
    { readonly schemaVersion: 2 }
  >;
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

function blueprintIdentities(
  definition: OfficialWorkflowAcceptedDefinition,
): readonly OfficialWorkflowRunBlueprintIdentity[] {
  return definition.blueprints.map((blueprint) => {
    return { key: blueprint.key, fingerprint: blueprint.fingerprint };
  });
}

function blueprintIdentitiesMatch(
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

export function acceptedDefinitionForName(
  definitions: readonly OfficialWorkflowAcceptedDefinition[],
  name: string,
): OfficialWorkflowAcceptedDefinition | null {
  const matches = definitions.filter((definition) => {
    return definition.name === name;
  });
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export function assembleWorkflowObservation(
  workflowId: string,
  definition: OfficialWorkflowAcceptedDefinition,
  revision: OfficialWorkflowAcceptedRevision,
): OfficialWorkflowObservation {
  if (!acceptedRevisionMatchesDefinition(definition, revision)) {
    throw new OfficialWorkflowRunAdmissionError();
  }
  const source = {
    name: definition.name,
    revision: definition.revision,
    contentBundle: definition.contentBundle,
  };
  return {
    definitions: [{ workflowId, ...source }],
    provenance: { schemaVersion: 2, definitions: [source] },
  };
}
