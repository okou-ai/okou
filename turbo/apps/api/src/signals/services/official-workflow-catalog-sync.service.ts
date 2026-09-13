import type {
  OfficialWorkflowAcceptedDefinition,
  OfficialWorkflowArtifactReference,
  OfficialWorkflowCatalogDiagnostic,
  OfficialWorkflowCatalogReleasePayload,
  OfficialWorkflowCatalogSyncResponse,
  OfficialWorkflowDefinitionRevisionPayload,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";
import {
  getOfficialWorkflowDefinitionStorageName,
  SYSTEM_ORG_ID,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { synthesizeWorkflowSkillMd } from "@okouai/core/skill-document";
import {
  officialWorkflowCatalogReleases,
  officialWorkflowCatalogState,
  officialWorkflowDefinitionRevisions,
  officialWorkflowReconciliationWork,
} from "@okouai/db/schema/official-workflow-catalog";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { settle } from "../utils";
import { OFFICIAL_WORKFLOW_CATALOG_ACTIVATION_LOCK } from "./official-workflow-constants";
import {
  OFFICIAL_WORKFLOW_CATALOG_AUTHORITY,
  readAllCurrentSchemaOfficialWorkflowRevisions,
  readAcceptedOfficialWorkflowCatalog,
  type AcceptedOfficialWorkflowCatalog,
} from "./official-workflow-catalog-read.service";
import {
  canonicalJsonString,
  OFFICIAL_WORKFLOW_DEFINITION_MANIFEST_PATH,
  officialWorkflowFingerprint,
  validateOfficialWorkflowCatalog,
  type ValidatedOfficialWorkflowCatalog,
} from "./official-workflow-catalog-validation.service";
import { OFFICIAL_WORKFLOW_SOURCE_CATALOG } from "./official-workflow-catalog-source";
import {
  commitPreparedVolumeServerSide,
  prepareVolumeServerSide$,
  type PreparedServerSideVolume,
} from "./storage-volume-publication.service";

interface PreparedOfficialWorkflowDefinition {
  readonly definition: OfficialWorkflowDefinitionRevisionPayload;
  readonly volume: PreparedServerSideVolume;
  readonly artifact: OfficialWorkflowArtifactReference;
}

type CandidateReleaseResult =
  | {
      readonly kind: "valid";
      readonly payload: OfficialWorkflowCatalogReleasePayload;
    }
  | {
      readonly kind: "invalid";
      readonly diagnostics: readonly OfficialWorkflowCatalogDiagnostic[];
    };

class OfficialWorkflowCatalogRegistrationError extends Error {
  readonly definitionName: string | undefined;

  constructor(definitionName?: string, cause?: unknown) {
    super(
      "Official Workflow catalog registration failed",
      cause === undefined ? undefined : { cause },
    );
    this.name = "OfficialWorkflowCatalogRegistrationError";
    this.definitionName = definitionName;
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function releaseDiagnostics(
  catalog: ValidatedOfficialWorkflowCatalog,
  previous: AcceptedOfficialWorkflowCatalog | null,
): readonly OfficialWorkflowCatalogDiagnostic[] {
  const diagnostics: OfficialWorkflowCatalogDiagnostic[] = [];
  const sourceByName = new Map(
    catalog.source.definitions.map((definition) => {
      return [definition.name, definition] as const;
    }),
  );
  for (const previousDefinition of previous?.payload.definitions ?? []) {
    if (!sourceByName.has(previousDefinition.name)) {
      diagnostics.push({
        code: "missing-released-definition",
        path: ["definitions"],
        definitionName: previousDefinition.name,
      });
    }
  }
  const previousNames = new Set(
    previous?.payload.definitions.map((definition) => {
      return definition.name;
    }) ?? [],
  );
  for (const [index, definition] of catalog.source.definitions.entries()) {
    if (
      definition.lifecycle === "retired" &&
      !previousNames.has(definition.name)
    ) {
      diagnostics.push({
        code: "unknown-retired-definition",
        path: ["definitions", index, "lifecycle"],
        definitionName: definition.name,
      });
    }
  }
  return diagnostics;
}

function buildCandidateRelease(
  catalog: ValidatedOfficialWorkflowCatalog,
  previous: AcceptedOfficialWorkflowCatalog | null,
  preparedByName: ReadonlyMap<string, PreparedOfficialWorkflowDefinition>,
): CandidateReleaseResult {
  const diagnostics = releaseDiagnostics(catalog, previous);
  if (diagnostics.length > 0) {
    return { kind: "invalid", diagnostics };
  }
  const previousByName = new Map(
    previous?.payload.definitions.map((definition) => {
      return [definition.name, definition] as const;
    }) ?? [],
  );
  const definitions: OfficialWorkflowAcceptedDefinition[] = [];
  for (const sourceDefinition of catalog.source.definitions) {
    const previousDefinition = previousByName.get(sourceDefinition.name);
    if (sourceDefinition.lifecycle === "retired") {
      if (!previousDefinition) {
        throw new OfficialWorkflowCatalogRegistrationError(
          sourceDefinition.name,
        );
      }
      definitions.push({
        ...previousDefinition,
        lifecycle: "retired",
        presentation: sourceDefinition.presentation,
      });
      continue;
    }
    const prepared = preparedByName.get(sourceDefinition.name);
    if (!prepared) {
      throw new OfficialWorkflowCatalogRegistrationError(sourceDefinition.name);
    }
    const releasedBlueprintKeys = new Set(
      previousDefinition?.releasedBlueprintKeys ?? [],
    );
    for (const blueprint of prepared.definition.blueprints) {
      releasedBlueprintKeys.add(blueprint.key);
    }
    definitions.push({
      name: sourceDefinition.name,
      lifecycle: "active",
      revision: prepared.definition.revision,
      artifact: prepared.artifact,
      blueprints: prepared.definition.blueprints,
      releasedBlueprintKeys: [...releasedBlueprintKeys].sort(compareStrings),
      presentation: sourceDefinition.presentation,
    });
  }
  return {
    kind: "valid",
    payload: {
      schemaVersion: catalog.source.schemaVersion,
      definitions: definitions.sort((left, right) => {
        return compareStrings(left.name, right.name);
      }),
    },
  };
}

function blueprintDesiredStateChanged(
  previous: OfficialWorkflowAcceptedDefinition | undefined,
  next: OfficialWorkflowAcceptedDefinition,
): boolean {
  if (next.lifecycle !== "active" || !previous) {
    return false;
  }
  if (previous.lifecycle !== "active") {
    return true;
  }
  if (previous.blueprints.length !== next.blueprints.length) {
    return true;
  }
  const previousFingerprints = new Map(
    previous.blueprints.map((blueprint) => {
      return [blueprint.key, blueprint.fingerprint] as const;
    }),
  );
  return next.blueprints.some((blueprint) => {
    return previousFingerprints.get(blueprint.key) !== blueprint.fingerprint;
  });
}

async function recordBlueprintReconciliationWork(
  db: Db,
  args: {
    readonly previous: AcceptedOfficialWorkflowCatalog | null;
    readonly payload: OfficialWorkflowCatalogReleasePayload;
    readonly releaseId: string;
  },
  signal: AbortSignal,
): Promise<void> {
  const previousByName = new Map(
    args.previous?.payload.definitions.map((definition) => {
      return [definition.name, definition] as const;
    }) ?? [],
  );
  const changed = args.payload.definitions.filter((definition) => {
    return blueprintDesiredStateChanged(
      previousByName.get(definition.name),
      definition,
    );
  });
  for (const definition of args.payload.definitions) {
    if (definition.lifecycle !== "active") {
      await db
        .delete(officialWorkflowReconciliationWork)
        .where(
          eq(
            officialWorkflowReconciliationWork.definitionName,
            definition.name,
          ),
        );
      signal.throwIfAborted();
    }
  }
  const currentTime = nowDate();
  for (const definition of changed) {
    await db
      .insert(officialWorkflowReconciliationWork)
      .values({
        definitionName: definition.name,
        requestedReleaseId: args.releaseId,
        cursorWorkflowId: null,
        state: "pending",
        leaseId: null,
        leaseExpiresAt: null,
        availableAt: currentTime,
        attemptCount: 0,
        lastError: null,
        createdAt: currentTime,
        updatedAt: currentTime,
      })
      .onConflictDoUpdate({
        target: officialWorkflowReconciliationWork.definitionName,
        set: {
          requestedReleaseId: args.releaseId,
          cursorWorkflowId: null,
          state: "pending",
          leaseId: null,
          leaseExpiresAt: null,
          availableAt: currentTime,
          attemptCount: 0,
          lastError: null,
          updatedAt: currentTime,
        },
      });
    signal.throwIfAborted();
  }
}

type DefinitionPreparationResult =
  | {
      readonly kind: "prepared";
      readonly definition: PreparedOfficialWorkflowDefinition;
    }
  | {
      readonly kind: "rejected";
      readonly diagnostics: readonly OfficialWorkflowCatalogDiagnostic[];
    };

type DefinitionPreparationRejection = Extract<
  DefinitionPreparationResult,
  { readonly kind: "rejected" }
>;

function artifactReferencesMatch(
  left: OfficialWorkflowArtifactReference,
  right: OfficialWorkflowArtifactReference,
): boolean {
  return (
    left.storageName === right.storageName &&
    left.storageId === right.storageId &&
    left.storageVersion === right.storageVersion
  );
}

function artifactPreparationRejected(
  definitionName: string | undefined,
  path: readonly (string | number)[],
): DefinitionPreparationRejection {
  return {
    kind: "rejected",
    diagnostics: [
      {
        code: "artifact-preparation-failed",
        path: [...path],
        ...(definitionName === undefined ? {} : { definitionName }),
      },
    ],
  };
}

function definitionRevisionKey(definitionName: string, revision: string) {
  return `${definitionName}\0${revision}`;
}

const prepareDefinitionArtifact$ = command(
  async (
    { set },
    definition: OfficialWorkflowDefinitionRevisionPayload,
    expectedArtifact: OfficialWorkflowArtifactReference | undefined,
    path: readonly (string | number)[],
    signal: AbortSignal,
  ): Promise<DefinitionPreparationResult> => {
    const storageName = getOfficialWorkflowDefinitionStorageName(
      definition.name,
    );
    if (
      expectedArtifact !== undefined &&
      expectedArtifact.storageName !== storageName
    ) {
      return artifactPreparationRejected(definition.name, path);
    }
    const volumeResult = await settle(
      set(
        prepareVolumeServerSide$,
        {
          orgId: SYSTEM_ORG_ID,
          storageName,
          piResourceIndex: true,
          files: [
            {
              path: "SKILL.md",
              content: synthesizeWorkflowSkillMd({
                name: definition.name,
                description: definition.workflow.description,
                instruction: definition.workflow.instruction,
              }),
            },
            ...definition.workflow.files,
            {
              path: OFFICIAL_WORKFLOW_DEFINITION_MANIFEST_PATH,
              content: `${canonicalJsonString(definition)}\n`,
            },
          ],
        },
        signal,
      ),
      signal,
    );
    if (!volumeResult.ok) {
      return artifactPreparationRejected(definition.name, path);
    }
    const volume = volumeResult.value;
    const artifact = {
      storageName,
      storageId: volume.version.storageId,
      storageVersion: volume.version.versionId,
    };
    if (
      expectedArtifact !== undefined &&
      !artifactReferencesMatch(artifact, expectedArtifact)
    ) {
      return artifactPreparationRejected(definition.name, path);
    }
    return {
      kind: "prepared",
      definition: { definition, volume, artifact },
    };
  },
);

const prepareDefinitions$ = command(
  async (
    { set },
    db: Db,
    catalog: ValidatedOfficialWorkflowCatalog,
    previous: AcceptedOfficialWorkflowCatalog | null,
    signal: AbortSignal,
  ): Promise<
    | {
        readonly kind: "prepared";
        readonly definitions: ReadonlyMap<
          string,
          PreparedOfficialWorkflowDefinition
        >;
      }
    | {
        readonly kind: "rejected";
        readonly diagnostics: readonly OfficialWorkflowCatalogDiagnostic[];
      }
  > => {
    const historicalResult = await settle(
      readAllCurrentSchemaOfficialWorkflowRevisions(db, signal),
      signal,
    );
    if (!historicalResult.ok) {
      return artifactPreparationRejected(undefined, ["revisions"]);
    }
    const historicalByRevision = new Map<
      string,
      PreparedOfficialWorkflowDefinition
    >();
    for (const [
      revisionIndex,
      historical,
    ] of historicalResult.value.entries()) {
      const preparation = await set(
        prepareDefinitionArtifact$,
        historical.definition,
        historical.artifact,
        ["revisions", revisionIndex],
        signal,
      );
      if (preparation.kind === "rejected") {
        return preparation;
      }
      historicalByRevision.set(
        definitionRevisionKey(
          historical.definition.name,
          historical.definition.revision,
        ),
        preparation.definition,
      );
    }

    const preparedByName = new Map<
      string,
      PreparedOfficialWorkflowDefinition
    >();
    const previousByName = new Map(
      previous?.payload.definitions.map((definition) => {
        return [definition.name, definition] as const;
      }) ?? [],
    );
    for (const [
      definitionIndex,
      sourceDefinition,
    ] of catalog.source.definitions.entries()) {
      const previousDefinition = previousByName.get(sourceDefinition.name);
      const validated = catalog.activeDefinitions.get(sourceDefinition.name);
      const sourceRevision = validated?.revisionPayload;
      const revision =
        sourceDefinition.lifecycle === "active"
          ? sourceRevision?.revision
          : previousDefinition?.revision;
      const historical =
        revision === undefined
          ? undefined
          : historicalByRevision.get(
              definitionRevisionKey(sourceDefinition.name, revision),
            );
      if (sourceDefinition.lifecycle === "retired") {
        if (
          !previousDefinition ||
          !historical ||
          !artifactReferencesMatch(
            historical.artifact,
            previousDefinition.artifact,
          )
        ) {
          return artifactPreparationRejected(sourceDefinition.name, [
            "definitions",
            definitionIndex,
          ]);
        }
        preparedByName.set(sourceDefinition.name, historical);
        continue;
      }
      if (!sourceRevision) {
        return artifactPreparationRejected(sourceDefinition.name, [
          "definitions",
          definitionIndex,
        ]);
      }
      if (historical) {
        if (
          canonicalJsonString(historical.definition) !==
          canonicalJsonString(sourceRevision)
        ) {
          return artifactPreparationRejected(sourceDefinition.name, [
            "definitions",
            definitionIndex,
          ]);
        }
        preparedByName.set(sourceDefinition.name, historical);
        continue;
      }
      const preparation = await set(
        prepareDefinitionArtifact$,
        sourceRevision,
        undefined,
        ["definitions", definitionIndex],
        signal,
      );
      if (preparation.kind === "rejected") {
        return preparation;
      }
      preparedByName.set(sourceDefinition.name, preparation.definition);
    }
    return { kind: "prepared", definitions: preparedByName };
  },
);

function preparedCandidateConflict(
  payload: OfficialWorkflowCatalogReleasePayload,
  preparedByName: ReadonlyMap<string, PreparedOfficialWorkflowDefinition>,
): OfficialWorkflowCatalogDiagnostic | null {
  for (const [definitionIndex, definition] of payload.definitions.entries()) {
    const prepared = preparedByName.get(definition.name);
    if (
      !prepared ||
      prepared.definition.revision !== definition.revision ||
      prepared.artifact.storageName !== definition.artifact.storageName ||
      prepared.artifact.storageId !== definition.artifact.storageId ||
      prepared.artifact.storageVersion !== definition.artifact.storageVersion
    ) {
      return {
        code: "activation-conflict",
        path: ["definitions", definitionIndex],
        definitionName: definition.name,
      };
    }
  }
  return null;
}

async function assertPreparedStorageIdentity(
  db: Db,
  prepared: PreparedOfficialWorkflowDefinition,
  signal: AbortSignal,
): Promise<void> {
  const [row] = await db
    .select({
      storageId: storages.id,
      storageVersion: storageVersions.id,
    })
    .from(storages)
    .leftJoin(
      storageVersions,
      and(
        eq(storageVersions.storageId, storages.id),
        eq(storageVersions.id, prepared.artifact.storageVersion),
      ),
    )
    .where(
      and(
        eq(storages.id, prepared.artifact.storageId),
        eq(storages.orgId, SYSTEM_ORG_ID),
        eq(storages.userId, VOLUME_ORG_USER_ID),
        eq(storages.name, prepared.artifact.storageName),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!row || row.storageId !== prepared.artifact.storageId) {
    throw new OfficialWorkflowCatalogRegistrationError();
  }
  if (
    row.storageVersion !== null &&
    row.storageVersion !== prepared.artifact.storageVersion
  ) {
    throw new OfficialWorkflowCatalogRegistrationError();
  }
}

async function persistDefinitionRevision(
  db: Db,
  prepared: PreparedOfficialWorkflowDefinition,
  signal: AbortSignal,
): Promise<void> {
  await db
    .insert(officialWorkflowDefinitionRevisions)
    .values({
      definitionName: prepared.definition.name,
      revision: prepared.definition.revision,
      payload: prepared.definition,
      storageName: prepared.artifact.storageName,
      storageId: prepared.artifact.storageId,
      storageVersion: prepared.artifact.storageVersion,
    })
    .onConflictDoNothing();
  signal.throwIfAborted();
  const [stored] = await db
    .select({
      payload: officialWorkflowDefinitionRevisions.payload,
      storageName: officialWorkflowDefinitionRevisions.storageName,
      storageId: officialWorkflowDefinitionRevisions.storageId,
      storageVersion: officialWorkflowDefinitionRevisions.storageVersion,
    })
    .from(officialWorkflowDefinitionRevisions)
    .where(
      and(
        eq(
          officialWorkflowDefinitionRevisions.definitionName,
          prepared.definition.name,
        ),
        eq(
          officialWorkflowDefinitionRevisions.revision,
          prepared.definition.revision,
        ),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (
    !stored ||
    canonicalJsonString(stored.payload) !==
      canonicalJsonString(prepared.definition) ||
    stored.storageName !== prepared.artifact.storageName ||
    stored.storageId !== prepared.artifact.storageId ||
    stored.storageVersion !== prepared.artifact.storageVersion
  ) {
    throw new OfficialWorkflowCatalogRegistrationError();
  }
}

async function persistCatalogRelease(
  db: Db,
  args: {
    readonly releaseId: string;
    readonly payload: OfficialWorkflowCatalogReleasePayload;
  },
  signal: AbortSignal,
): Promise<void> {
  await db
    .insert(officialWorkflowCatalogReleases)
    .values({ id: args.releaseId, payload: args.payload })
    .onConflictDoNothing();
  signal.throwIfAborted();
  const [stored] = await db
    .select({ payload: officialWorkflowCatalogReleases.payload })
    .from(officialWorkflowCatalogReleases)
    .where(eq(officialWorkflowCatalogReleases.id, args.releaseId))
    .limit(1);
  signal.throwIfAborted();
  if (
    !stored ||
    canonicalJsonString(stored.payload) !== canonicalJsonString(args.payload)
  ) {
    throw new OfficialWorkflowCatalogRegistrationError();
  }
}

async function activateCandidate(
  db: Db,
  catalog: ValidatedOfficialWorkflowCatalog,
  preparedByName: ReadonlyMap<string, PreparedOfficialWorkflowDefinition>,
  observedReleaseId: string | null,
  signal: AbortSignal,
): Promise<OfficialWorkflowCatalogSyncResponse> {
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${OFFICIAL_WORKFLOW_CATALOG_ACTIVATION_LOCK}))`,
    );
    signal.throwIfAborted();
    const current = await readAcceptedOfficialWorkflowCatalog(tx, signal);
    const currentReleaseId = current?.releaseId ?? null;
    const stale = currentReleaseId !== observedReleaseId;
    const candidate = buildCandidateRelease(catalog, current, preparedByName);
    if (candidate.kind === "invalid") {
      if (stale) {
        return {
          outcome: "rejected" as const,
          releaseId: currentReleaseId,
          diagnostics: [
            { code: "activation-conflict" as const, path: ["catalog"] },
          ],
        };
      }
      return {
        outcome: "rejected" as const,
        releaseId: currentReleaseId,
        diagnostics: [...candidate.diagnostics],
      };
    }
    const releaseId = officialWorkflowFingerprint(candidate.payload);
    if (stale) {
      return currentReleaseId === releaseId
        ? {
            outcome: "unchanged" as const,
            releaseId,
            diagnostics: [],
          }
        : {
            outcome: "rejected" as const,
            releaseId: currentReleaseId,
            diagnostics: [
              { code: "activation-conflict" as const, path: ["catalog"] },
            ],
          };
    }
    const conflict = preparedCandidateConflict(
      candidate.payload,
      preparedByName,
    );
    if (conflict) {
      return {
        outcome: "rejected" as const,
        releaseId: currentReleaseId,
        diagnostics: [conflict],
      };
    }
    if (currentReleaseId === releaseId) {
      return {
        outcome: "unchanged" as const,
        releaseId,
        diagnostics: [],
      };
    }
    for (const prepared of preparedByName.values()) {
      const registration = await settle(
        (async () => {
          await assertPreparedStorageIdentity(tx, prepared, signal);
          await commitPreparedVolumeServerSide(
            { db: tx, volume: prepared.volume },
            signal,
          );
          await persistDefinitionRevision(tx, prepared, signal);
        })(),
        signal,
      );
      if (!registration.ok) {
        throw new OfficialWorkflowCatalogRegistrationError(
          prepared.definition.name,
          registration.error,
        );
      }
    }
    await persistCatalogRelease(
      tx,
      { releaseId, payload: candidate.payload },
      signal,
    );
    await tx
      .insert(officialWorkflowCatalogState)
      .values({
        authority: OFFICIAL_WORKFLOW_CATALOG_AUTHORITY,
        acceptedReleaseId: releaseId,
        updatedAt: nowDate(),
      })
      .onConflictDoUpdate({
        target: officialWorkflowCatalogState.authority,
        set: { acceptedReleaseId: releaseId, updatedAt: nowDate() },
      });
    signal.throwIfAborted();
    await recordBlueprintReconciliationWork(
      tx,
      { previous: current, payload: candidate.payload, releaseId },
      signal,
    );
    return {
      outcome: "accepted" as const,
      releaseId,
      diagnostics: [],
    };
  });
}

export function createOfficialWorkflowCatalogSyncCommand(candidate: unknown) {
  return command(
    async (
      { set },
      signal: AbortSignal,
    ): Promise<OfficialWorkflowCatalogSyncResponse> => {
      const writeDb = set(writeDb$);
      const current = await readAcceptedOfficialWorkflowCatalog(
        writeDb,
        signal,
      );
      const validation = validateOfficialWorkflowCatalog(candidate);
      if (validation.kind === "invalid") {
        return {
          outcome: "rejected",
          releaseId: current?.releaseId ?? null,
          diagnostics: [...validation.diagnostics],
        };
      }
      const transitionDiagnostics = releaseDiagnostics(
        validation.catalog,
        current,
      );
      if (transitionDiagnostics.length > 0) {
        return {
          outcome: "rejected",
          releaseId: current?.releaseId ?? null,
          diagnostics: [...transitionDiagnostics],
        };
      }
      const preparation = await set(
        prepareDefinitions$,
        writeDb,
        validation.catalog,
        current,
        signal,
      );
      if (preparation.kind === "rejected") {
        return {
          outcome: "rejected",
          releaseId: current?.releaseId ?? null,
          diagnostics: [...preparation.diagnostics],
        };
      }
      const activation = await settle(
        activateCandidate(
          writeDb,
          validation.catalog,
          preparation.definitions,
          current?.releaseId ?? null,
          signal,
        ),
        signal,
      );
      if (!activation.ok) {
        const definitionName =
          activation.error instanceof OfficialWorkflowCatalogRegistrationError
            ? activation.error.definitionName
            : undefined;
        return {
          outcome: "rejected",
          releaseId:
            (await readAcceptedOfficialWorkflowCatalog(writeDb, signal))
              ?.releaseId ?? null,
          diagnostics: [
            {
              code: "artifact-registration-failed",
              path: ["definitions"],
              ...(definitionName === undefined ? {} : { definitionName }),
            },
          ],
        };
      }
      return activation.value;
    },
  );
}

export const syncOfficialWorkflowCatalog$ =
  createOfficialWorkflowCatalogSyncCommand(OFFICIAL_WORKFLOW_SOURCE_CATALOG);
