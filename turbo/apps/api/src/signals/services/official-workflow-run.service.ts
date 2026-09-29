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
import {
  officialWorkflowCatalogReleases,
  officialWorkflowCatalogState,
  officialWorkflowDefinitionRevisions,
} from "@okouai/db/schema/official-workflow-catalog";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { computed, type Computed } from "ccstate";
import { workflowAutomations, workflows } from "@okouai/db/schema/workflow";
import type { PersistedStorageMount } from "@okouai/db/types";
import { and, asc, eq, inArray, or } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import type { ReadonlyDb } from "../external/db";
import {
  acceptedCatalogFromRow,
  acceptedRevisionFromRow,
  OFFICIAL_WORKFLOW_CATALOG_AUTHORITY,
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

function artifactMatches(
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
    acceptedArtifactsMatch(revision.artifact, definition.artifact) &&
    blueprintIdentitiesMatch(
      blueprintIdentities(definition),
      revision.definition.blueprints.map((blueprint) => {
        return { key: blueprint.key, fingerprint: blueprint.fingerprint };
      }),
    )
  );
}

function acceptedRevisionsMatchDefinitions(
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

function acceptedDefinitionForName(
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

interface OfficialWorkflowRunReadInput {
  readonly db: ReadonlyDb;
  readonly hasOfficialWorkflows: boolean;
}

type OfficialWorkflowRunReadInputObject = Computed<
  OfficialWorkflowRunReadInput | Promise<OfficialWorkflowRunReadInput>
>;

function createAcceptedRunCatalogObject(
  input$: OfficialWorkflowRunReadInputObject,
) {
  return computed(async (get) => {
    const { db, hasOfficialWorkflows } = await get(input$);
    if (!hasOfficialWorkflows) {
      return null;
    }
    const [row] = await db
      .select({
        releaseId: officialWorkflowCatalogState.acceptedReleaseId,
        payload: officialWorkflowCatalogReleases.payload,
      })
      .from(officialWorkflowCatalogState)
      .innerJoin(
        officialWorkflowCatalogReleases,
        eq(
          officialWorkflowCatalogReleases.id,
          officialWorkflowCatalogState.acceptedReleaseId,
        ),
      )
      .where(
        eq(
          officialWorkflowCatalogState.authority,
          OFFICIAL_WORKFLOW_CATALOG_AUTHORITY,
        ),
      )
      .limit(1);
    const catalog = acceptedCatalogFromRow(row);
    if (!catalog) {
      throw new OfficialWorkflowRunAdmissionError();
    }
    return catalog;
  });
}

function createAcceptedRunRevisionsObject(
  input$: OfficialWorkflowRunReadInputObject,
  acceptedCandidates$: Computed<Promise<readonly AcceptedRunCandidate[]>>,
) {
  return computed(async (get) => {
    const { db } = await get(input$);
    const candidates = await get(acceptedCandidates$);
    if (candidates.length === 0) {
      return [];
    }
    const rows = await db
      .select({
        definitionName: officialWorkflowDefinitionRevisions.definitionName,
        revision: officialWorkflowDefinitionRevisions.revision,
        payload: officialWorkflowDefinitionRevisions.payload,
        storageName: officialWorkflowDefinitionRevisions.storageName,
        storageId: officialWorkflowDefinitionRevisions.storageId,
        storageVersion: officialWorkflowDefinitionRevisions.storageVersion,
      })
      .from(officialWorkflowDefinitionRevisions)
      .innerJoin(
        storages,
        and(
          eq(storages.id, officialWorkflowDefinitionRevisions.storageId),
          eq(storages.name, officialWorkflowDefinitionRevisions.storageName),
          eq(storages.orgId, SYSTEM_ORG_ID),
          eq(storages.userId, VOLUME_ORG_USER_ID),
        ),
      )
      .innerJoin(
        storageVersions,
        and(
          eq(
            storageVersions.id,
            officialWorkflowDefinitionRevisions.storageVersion,
          ),
          eq(
            storageVersions.storageId,
            officialWorkflowDefinitionRevisions.storageId,
          ),
        ),
      )
      .where(
        or(
          ...candidates.map(({ accepted }) => {
            return and(
              eq(
                officialWorkflowDefinitionRevisions.definitionName,
                accepted.name,
              ),
              eq(
                officialWorkflowDefinitionRevisions.revision,
                accepted.revision,
              ),
            );
          }),
        ),
      )
      .orderBy(
        asc(officialWorkflowDefinitionRevisions.definitionName),
        asc(officialWorkflowDefinitionRevisions.revision),
      );
    const revisions = new Map(
      rows.map((row) => {
        return [
          JSON.stringify([row.definitionName, row.revision]),
          acceptedRevisionFromRow(row),
        ];
      }),
    );
    return candidates.map(({ accepted }) => {
      return (
        revisions.get(JSON.stringify([accepted.name, accepted.revision])) ??
        null
      );
    });
  });
}

/** The accepted catalog can load before model-dependent mount paths are ready. */
export function createOfficialWorkflowRunObjects({
  input$,
  candidates$,
}: {
  readonly input$: OfficialWorkflowRunReadInputObject;
  readonly candidates$: Computed<
    Promise<readonly OfficialWorkflowRunCandidate[]>
  >;
}) {
  const catalog$ = createAcceptedRunCatalogObject(input$);
  const acceptedCandidates$ = computed(async (get) => {
    const [catalog, candidates] = await Promise.all([
      get(catalog$),
      get(candidates$),
    ]);
    if (candidates.length === 0) {
      return [];
    }
    if (!catalog) {
      throw new OfficialWorkflowRunAdmissionError();
    }
    return acceptedRunCandidates(catalog, candidates);
  });
  const revisions$ = createAcceptedRunRevisionsObject(
    input$,
    acceptedCandidates$,
  );
  const observation$ = computed(
    async (get): Promise<OfficialWorkflowRunObservation | undefined> => {
      const [catalog, candidates, revisions] = await Promise.all([
        get(catalog$),
        get(acceptedCandidates$),
        get(revisions$),
      ]);
      return catalog && candidates.length > 0
        ? assembleRunObservation(catalog, candidates, revisions)
        : undefined;
    },
  );
  return { observation$ };
}

export async function acquireOfficialWorkflowRunCatalogAdmissionLock(
  tx: Tx,
  observation: OfficialWorkflowRunObservation | undefined,
): Promise<void> {
  if (!observation) {
    return;
  }
  await lockAcceptedOfficialWorkflowCatalog(tx);
}

function lockedInstallationMatches(
  expected: ResolvedOfficialWorkflowRunDefinition,
  row: {
    readonly id: string;
    readonly orgId: string;
    readonly agentId: string;
    readonly name: string;
    readonly visibility: "public" | "private";
    readonly ownerUserId: string;
    readonly officialDefinitionName: string | null;
    readonly officialInstallationState: "installing" | "installed" | null;
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

function exactMountsMatch(
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

export async function validateOfficialWorkflowRunForInsert(
  tx: Tx,
  args: {
    readonly observation: OfficialWorkflowRunObservation | undefined;
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string | null;
    readonly automationId: string | undefined;
    readonly runStorageMounts: readonly PersistedStorageMount[] | undefined;
    readonly allowMissingMountsForFailedRun: boolean;
  },
): Promise<OfficialWorkflowRunAdmissionError | null> {
  const observation = args.observation;
  if (!observation) {
    return null;
  }

  const catalog = await readAcceptedOfficialWorkflowCatalog(tx);
  if (!catalog || catalog.releaseId !== observation.releaseId) {
    return new OfficialWorkflowRunAdmissionError();
  }

  const lockedInstallations = await tx
    .select({
      id: workflows.id,
      orgId: workflows.orgId,
      agentId: workflows.agentId,
      name: workflows.name,
      visibility: workflows.visibility,
      ownerUserId: workflows.ownerUserId,
      officialDefinitionName: workflows.officialDefinitionName,
      officialInstallationState: workflows.officialInstallationState,
    })
    .from(workflows)
    .where(
      inArray(
        workflows.id,
        observation.definitions.map((definition) => {
          return definition.workflowId;
        }),
      ),
    )
    .orderBy(asc(workflows.id))
    .for("update");
  if (lockedInstallations.length !== observation.definitions.length) {
    return new OfficialWorkflowRunAdmissionError();
  }
  const installationById = new Map(
    lockedInstallations.map((installation) => {
      return [installation.id, installation] as const;
    }),
  );

  const acceptedDefinitions: OfficialWorkflowAcceptedDefinition[] = [];
  for (const expected of observation.definitions) {
    const installation = installationById.get(expected.workflowId);
    const accepted = acceptedDefinitionForName(
      catalog.payload.definitions,
      expected.name,
    );
    if (
      !installation ||
      !lockedInstallationMatches(expected, installation, args) ||
      !accepted ||
      accepted.revision !== expected.revision ||
      !artifactMatches(expected.artifact, accepted.artifact) ||
      !blueprintIdentitiesMatch(
        expected.blueprints,
        blueprintIdentities(accepted),
      )
    ) {
      return new OfficialWorkflowRunAdmissionError();
    }
    acceptedDefinitions.push(accepted);
  }
  const revisions = await readAcceptedOfficialWorkflowRevisions(
    tx,
    acceptedDefinitions.map((accepted) => {
      return { name: accepted.name, revision: accepted.revision };
    }),
  );
  if (!acceptedRevisionsMatchDefinitions(acceptedDefinitions, revisions)) {
    return new OfficialWorkflowRunAdmissionError();
  }

  if (
    !args.allowMissingMountsForFailedRun &&
    !exactMountsMatch(observation, args.runStorageMounts)
  ) {
    return new OfficialWorkflowRunAdmissionError();
  }
  if (
    args.runStorageMounts !== undefined &&
    !exactMountsMatch(observation, args.runStorageMounts)
  ) {
    return new OfficialWorkflowRunAdmissionError();
  }
  if (
    !(await officialAutomationMatches(tx, {
      automationId: args.automationId,
      orgId: args.orgId,
      userId: args.userId,
      observation,
    }))
  ) {
    return new OfficialWorkflowRunAdmissionError();
  }
  return null;
}
