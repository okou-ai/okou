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
import { asc, eq, inArray, sql } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { testOverride } from "../../lib/singleton";
import type { ReadonlyDb } from "../external/db";
import { OFFICIAL_WORKFLOW_CATALOG_ACTIVATION_LOCK } from "./official-workflow-constants";
import {
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

interface OfficialWorkflowRunCandidate {
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

type OfficialWorkflowRunObservationHook = (
  observation: OfficialWorkflowRunObservation,
) => Promise<void>;

type OfficialWorkflowRunFinalAdmissionHook = (
  observation: OfficialWorkflowRunObservation,
  tx: Tx,
) => Promise<void>;

const observationResolvedHook = testOverride<
  OfficialWorkflowRunObservationHook | undefined
>(() => {
  return undefined;
});

const finalAdmissionLockedHook = testOverride<
  OfficialWorkflowRunFinalAdmissionHook | undefined
>(() => {
  return undefined;
});

export function setOfficialWorkflowRunObservationResolvedHookForTest(
  hook: OfficialWorkflowRunObservationHook,
): void {
  observationResolvedHook.set(hook);
}

export function clearOfficialWorkflowRunObservationResolvedHookForTest(): void {
  observationResolvedHook.clear();
}

export function setOfficialWorkflowRunFinalAdmissionLockedHookForTest(
  hook: OfficialWorkflowRunFinalAdmissionHook,
): void {
  finalAdmissionLockedHook.set(hook);
}

export function clearOfficialWorkflowRunFinalAdmissionLockedHookForTest(): void {
  finalAdmissionLockedHook.clear();
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

async function resolveObservation(
  db: ReadonlyDb,
  candidates: readonly OfficialWorkflowRunCandidate[],
  signal?: AbortSignal,
): Promise<OfficialWorkflowRunObservation> {
  const catalog = await readAcceptedOfficialWorkflowCatalog(db, signal);
  if (!catalog) {
    throw new OfficialWorkflowRunAdmissionError();
  }

  const orderedCandidates = [...candidates].sort((left, right) => {
    return (
      left.definitionName.localeCompare(right.definitionName) ||
      left.workflowId.localeCompare(right.workflowId)
    );
  });
  const definitionNames = new Set<string>();
  const workflowIds = new Set<string>();
  const mountPaths = new Set<string>();
  const acceptedCandidates = orderedCandidates.map((candidate) => {
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
  const revisions = await readAcceptedOfficialWorkflowRevisions(
    db,
    acceptedCandidates.map(({ accepted }) => {
      return { name: accepted.name, revision: accepted.revision };
    }),
    signal,
  );
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

export async function resolveOfficialWorkflowRunObservation(
  db: ReadonlyDb,
  candidates: readonly OfficialWorkflowRunCandidate[],
  signal?: AbortSignal,
): Promise<OfficialWorkflowRunObservation | undefined> {
  if (candidates.length === 0) {
    return undefined;
  }
  const observation = await resolveObservation(db, candidates, signal);
  await observationResolvedHook.get()?.(observation);
  return observation;
}

export async function acquireOfficialWorkflowRunCatalogAdmissionLock(
  tx: Tx,
  observation: OfficialWorkflowRunObservation | undefined,
): Promise<void> {
  if (!observation) {
    return;
  }
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock_shared(hashtext(${OFFICIAL_WORKFLOW_CATALOG_ACTIVATION_LOCK}))`,
  );
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
  await finalAdmissionLockedHook.get()?.(observation, tx);
  return null;
}
