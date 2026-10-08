import { preparedVolumePublicationSql } from "./storage-volume-publication-sql";
import type {
  OfficialWorkflowArtifactReference,
  OfficialWorkflowCatalogDiagnostic,
  OfficialWorkflowCatalogSyncResponse,
  OfficialWorkflowDefinitionRevisionPayload,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";
import {
  getOfficialWorkflowDefinitionStorageName,
  SYSTEM_ORG_ID,
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
import { eq } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import {
  readAllCurrentSchemaOfficialWorkflowRevisions$,
  readAcceptedOfficialWorkflowCatalog$,
  acceptedCatalogFromRow,
  type AcceptedOfficialWorkflowCatalog,
} from "./official-workflow-catalog-read.service";
import {
  OfficialWorkflowCatalogRegistrationError,
  catalogActivationResult,
  assertCatalogReleasePayload,
  assertPublishedDefinitionCount,
  type CatalogCandidatePublication,
  catalogReleaseJoinCondition,
  catalogStateValues,
  reconciliationDefinitionCondition,
  retiredBlueprintDefinitions,
  catalogPublicationPlan,
  catalogAuthorityCondition,
  catalogPublicationCondition,
  preparedStorageVersionCondition,
  preparedStorageCondition,
  preparedStorageMatches,
  definitionRevisionValues,
  definitionRevisionCondition,
  definitionRevisionMatches,
  changedBlueprintDefinitions,
  reconciliationWorkResetValues,
  reconciliationWorkValues,
  releaseDiagnostics,
  type PreparedOfficialWorkflowDefinition,
} from "./official-workflow-catalog-publication";
import {
  canonicalJsonString,
  OFFICIAL_WORKFLOW_DEFINITION_MANIFEST_PATH,
  validateOfficialWorkflowCatalog,
  type ValidatedOfficialWorkflowCatalog,
} from "./official-workflow-catalog-validation.service";

import { prepareVolumeServerSide$ } from "./storage-volume-publication.service";

class OfficialWorkflowCatalogActivationConflictError extends Error {
  readonly candidateReleaseId: string;

  constructor(candidateReleaseId: string) {
    super("Official Workflow catalog activation was superseded");
    this.name = "OfficialWorkflowCatalogActivationConflictError";
    this.candidateReleaseId = candidateReleaseId;
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

const definitionRevisionFields: Readonly<{
  payload: typeof officialWorkflowDefinitionRevisions.payload;
  storageName: typeof officialWorkflowDefinitionRevisions.storageName;
  storageId: typeof officialWorkflowDefinitionRevisions.storageId;
  storageVersion: typeof officialWorkflowDefinitionRevisions.storageVersion;
}> = {
  payload: officialWorkflowDefinitionRevisions.payload,
  storageName: officialWorkflowDefinitionRevisions.storageName,
  storageId: officialWorkflowDefinitionRevisions.storageId,
  storageVersion: officialWorkflowDefinitionRevisions.storageVersion,
};
const catalogPointerFields: Readonly<{
  acceptedReleaseId: typeof officialWorkflowCatalogState.acceptedReleaseId;
}> = {
  acceptedReleaseId: officialWorkflowCatalogState.acceptedReleaseId,
};
const catalogAuthorityFields: Readonly<{
  authority: typeof officialWorkflowCatalogState.authority;
}> = {
  authority: officialWorkflowCatalogState.authority,
};
const acceptedCatalogFields: Readonly<{
  releaseId: typeof officialWorkflowCatalogState.acceptedReleaseId;
  payload: typeof officialWorkflowCatalogReleases.payload;
}> = {
  releaseId: officialWorkflowCatalogState.acceptedReleaseId,
  payload: officialWorkflowCatalogReleases.payload,
};
const preparedStorageFields: Readonly<{
  storageId: typeof storages.id;
  storageVersion: typeof storageVersions.id;
}> = {
  storageId: storages.id,
  storageVersion: storageVersions.id,
};

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
      set(readAllCurrentSchemaOfficialWorkflowRevisions$, signal),
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

const activateCandidate$ = command(
  async (
    { set },
    input: CatalogCandidatePublication,
    signal: AbortSignal,
  ): Promise<OfficialWorkflowCatalogSyncResponse> => {
    let registeringDefinitionName: string | undefined;
    // The accepted pointer, immutable registrations, artifact heads and repair work commit together.
    const activation = await settle(
      set(writeDb$).transaction(async (tx) => {
        const [state] = await tx
          .select(catalogPointerFields)
          .from(officialWorkflowCatalogState)
          .where(catalogAuthorityCondition())
          .for("update");
        signal.throwIfAborted();
        const [catalogRow] = await tx
          .select(acceptedCatalogFields)
          .from(officialWorkflowCatalogState)
          .innerJoin(
            officialWorkflowCatalogReleases,
            catalogReleaseJoinCondition(),
          )
          .where(catalogAuthorityCondition())
          .limit(1);
        signal.throwIfAborted();
        const current = acceptedCatalogFromRow(catalogRow);
        const plan = catalogPublicationPlan(input, current);
        if (plan.outcome !== "publish") {
          return plan;
        }
        const { releaseId, payload } = plan;
        await tx
          .insert(officialWorkflowCatalogReleases)
          .values({ id: releaseId, payload })
          .onConflictDoNothing();
        signal.throwIfAborted();
        const [stored] = await tx
          .select({ payload: officialWorkflowCatalogReleases.payload })
          .from(officialWorkflowCatalogReleases)
          .where(eq(officialWorkflowCatalogReleases.id, releaseId))
          .limit(1);
        signal.throwIfAborted();
        assertCatalogReleasePayload(stored, payload);

        // Claim the singleton before mutating artifact heads, including when the
        // catalog has never been published. The pointer and exact revisions only
        // become visible together when this transaction commits.
        const previousReleaseId = state?.acceptedReleaseId;
        const published =
          previousReleaseId === undefined
            ? await tx
                .insert(officialWorkflowCatalogState)
                .values(catalogStateValues(releaseId, nowDate()))
                .onConflictDoNothing({
                  target: officialWorkflowCatalogState.authority,
                })
                .returning(catalogAuthorityFields)
            : await tx
                .update(officialWorkflowCatalogState)
                .set({ acceptedReleaseId: releaseId, updatedAt: nowDate() })
                .where(catalogPublicationCondition(previousReleaseId))
                .returning(catalogAuthorityFields);
        if (published.length !== 1) {
          // Roll back the candidate's Storage HEAD and registration writes as well
          // as its pointer. The singleton primary key arbitrates first publication.
          throw new OfficialWorkflowCatalogActivationConflictError(releaseId);
        }

        for (const prepared of input.preparedByName.values()) {
          registeringDefinitionName = prepared.definition.name;
          const [row] = await tx
            .select(preparedStorageFields)
            .from(storages)
            .leftJoin(
              storageVersions,
              preparedStorageVersionCondition(prepared.artifact),
            )
            .where(preparedStorageCondition(prepared.artifact))
            .limit(1);
          signal.throwIfAborted();
          if (!preparedStorageMatches(row, prepared.artifact)) {
            throw new OfficialWorkflowCatalogRegistrationError();
          }

          const { rowCount: published } = await tx.execute(
            preparedVolumePublicationSql(prepared.volume, nowDate()),
          );
          assertPublishedDefinitionCount(published, prepared.definition.name);
          signal.throwIfAborted();
          await tx
            .insert(officialWorkflowDefinitionRevisions)
            .values(definitionRevisionValues(prepared))
            .onConflictDoNothing();
          signal.throwIfAborted();
          const [stored] = await tx
            .select(definitionRevisionFields)
            .from(officialWorkflowDefinitionRevisions)
            .where(definitionRevisionCondition(prepared))
            .limit(1);
          signal.throwIfAborted();
          if (!definitionRevisionMatches(stored, prepared)) {
            throw new OfficialWorkflowCatalogRegistrationError();
          }
        }
        registeringDefinitionName = undefined;
        signal.throwIfAborted();
        const changed = changedBlueprintDefinitions(current, payload);
        for (const definition of retiredBlueprintDefinitions(payload)) {
          await tx
            .delete(officialWorkflowReconciliationWork)
            .where(reconciliationDefinitionCondition(definition.name));
          signal.throwIfAborted();
        }
        const currentTime = nowDate();
        for (const definition of changed) {
          await tx
            .insert(officialWorkflowReconciliationWork)
            .values(
              reconciliationWorkValues(definition.name, releaseId, currentTime),
            )
            .onConflictDoUpdate({
              target: officialWorkflowReconciliationWork.definitionName,
              set: reconciliationWorkResetValues(releaseId, currentTime),
            });
          signal.throwIfAborted();
        }

        return {
          outcome: "accepted" as const,
          releaseId,
          diagnostics: [],
        };
      }),
      signal,
    );
    return catalogActivationResult(activation, registeringDefinitionName);
  },
);

const catalogActivationConflictResponse$ = command(
  async (
    { set },
    candidateReleaseId: string,
    signal: AbortSignal,
  ): Promise<OfficialWorkflowCatalogSyncResponse> => {
    const accepted = await set(readAcceptedOfficialWorkflowCatalog$, signal);
    return accepted?.releaseId === candidateReleaseId
      ? {
          outcome: "unchanged",
          releaseId: accepted.releaseId,
          diagnostics: [],
        }
      : {
          outcome: "rejected",
          releaseId: accepted?.releaseId ?? null,
          diagnostics: [{ code: "activation-conflict", path: ["catalog"] }],
        };
  },
);

export function createOfficialWorkflowCatalogSyncCommand(candidate: unknown) {
  return command(
    async (
      { set },
      signal: AbortSignal,
    ): Promise<OfficialWorkflowCatalogSyncResponse> => {
      const current = await set(readAcceptedOfficialWorkflowCatalog$, signal);
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
        set(
          activateCandidate$,
          {
            catalog: validation.catalog,
            preparedByName: preparation.definitions,
            observedReleaseId: current?.releaseId ?? null,
          },
          signal,
        ),
        signal,
      );
      if (!activation.ok) {
        if (
          activation.error instanceof
          OfficialWorkflowCatalogActivationConflictError
        ) {
          return await set(
            catalogActivationConflictResponse$,
            activation.error.candidateReleaseId,
            signal,
          );
        }
        const definitionName =
          activation.error instanceof OfficialWorkflowCatalogRegistrationError
            ? activation.error.definitionName
            : undefined;
        return {
          outcome: "rejected",
          releaseId:
            (await set(readAcceptedOfficialWorkflowCatalog$, signal))
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
