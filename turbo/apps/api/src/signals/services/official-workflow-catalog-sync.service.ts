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
import {
  officialWorkflowArtifactFiles,
  officialWorkflowExecutionFiles,
} from "@okouai/core/official-workflow-artifact";
import {
  officialWorkflowCatalogReleases,
  officialWorkflowCatalogState,
} from "@okouai/db/schema/official-workflow-catalog";
import type { ContentBundle } from "@okouai/api-contracts/contracts/content-bundle";
import { publishContentBundle$ } from "./content-bundle.service";
import { command } from "ccstate";
import { literal, object } from "zod";
import { eq } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { safeSqlStateCode } from "../../lib/pg-errors";
import { parseRawRows } from "../../lib/db-raw-rows";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import {
  readAllSupportedOfficialWorkflowRevisions$,
  readAcceptedOfficialWorkflowCatalog$,
  acceptedCatalogFromRow,
  type AcceptedOfficialWorkflowCatalog,
} from "./official-workflow-catalog-read.service";
import {
  OfficialWorkflowCatalogRegistrationError,
  catalogActivationResult,
  assertCatalogReleasePayload,
  type CatalogCandidatePublication,
  catalogReleaseJoinCondition,
  catalogPublicationPlan,
  catalogAuthorityCondition,
  catalogActivationSql,
  releaseDiagnostics,
  type PreparedOfficialWorkflowDefinition,
} from "./official-workflow-catalog-publication";
import { canonicalJsonString } from "../../lib/canonical-json";
import {
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

const acceptedCatalogFields: Readonly<{
  releaseId: typeof officialWorkflowCatalogState.acceptedReleaseId;
  payload: typeof officialWorkflowCatalogReleases.payload;
  hiddenThreadDefinitionNames: typeof officialWorkflowCatalogReleases.hiddenThreadDefinitionNames;
}> = {
  releaseId: officialWorkflowCatalogState.acceptedReleaseId,
  payload: officialWorkflowCatalogReleases.payload,
  hiddenThreadDefinitionNames:
    officialWorkflowCatalogReleases.hiddenThreadDefinitionNames,
};
const catalogReleaseFields: Readonly<{
  payload: typeof officialWorkflowCatalogReleases.payload;
  hiddenThreadDefinitionNames: typeof officialWorkflowCatalogReleases.hiddenThreadDefinitionNames;
}> = {
  payload: officialWorkflowCatalogReleases.payload,
  hiddenThreadDefinitionNames:
    officialWorkflowCatalogReleases.hiddenThreadDefinitionNames,
};

const prepareDefinitionArtifact$ = command(
  async (
    { set },
    args: {
      readonly definition: OfficialWorkflowDefinitionRevisionPayload;
      readonly expectedArtifact: OfficialWorkflowArtifactReference | undefined;
      readonly path: readonly (string | number)[];
      readonly contentBundle: ContentBundle | null;
    },
    signal: AbortSignal,
  ): Promise<DefinitionPreparationResult> => {
    const { definition, expectedArtifact, path } = args;
    let contentBundle = args.contentBundle;
    const storageName = getOfficialWorkflowDefinitionStorageName(
      definition.name,
    );
    if (
      expectedArtifact !== undefined &&
      expectedArtifact.storageName !== storageName
    ) {
      return artifactPreparationRejected(definition.name, path);
    }
    const files = officialWorkflowArtifactFiles(
      definition,
      expectedArtifact && {
        storageId: expectedArtifact.storageId,
        storageVersion: expectedArtifact.storageVersion,
        definitionManifest: `${canonicalJsonString(definition)}\n`,
      },
    );
    if (files === null) {
      return artifactPreparationRejected(definition.name, path);
    }
    const volumeResult = await settle(
      set(
        prepareVolumeServerSide$,
        {
          orgId: SYSTEM_ORG_ID,
          storageName,
          piResourceIndex: true,
          files,
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
    if (!expectedArtifact) {
      const published = await settle(
        set(
          publishContentBundle$,
          officialWorkflowExecutionFiles(definition).map((file) => {
            return {
              path: file.path,
              content: Buffer.from(file.content, "utf8"),
            };
          }),
          signal,
        ),
        signal,
      );
      if (!published.ok) {
        return artifactPreparationRejected(definition.name, path);
      }
      contentBundle = published.value;
    }
    return {
      kind: "prepared",
      definition: { definition, volume, artifact, contentBundle },
    };
  },
);

const prepareHistoricalDefinitions$ = command(
  async ({ set }, signal: AbortSignal) => {
    const historicalResult = await settle(
      set(readAllSupportedOfficialWorkflowRevisions$, signal),
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
      if (!historical.artifact) {
        return artifactPreparationRejected(historical.definition.name, [
          "revisions",
          revisionIndex,
        ]);
      }
      const preparation = await set(
        prepareDefinitionArtifact$,
        {
          definition: historical.definition,
          expectedArtifact: historical.artifact,
          path: ["revisions", revisionIndex],
          contentBundle: historical.contentBundle ?? null,
        },
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

    return { kind: "prepared" as const, definitions: historicalByRevision };
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
    const historical = await set(prepareHistoricalDefinitions$, signal);
    if (historical.kind === "rejected") {
      return historical;
    }
    const historicalByRevision = historical.definitions;

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
          !previousDefinition?.artifact ||
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
        {
          definition: sourceRevision,
          expectedArtifact: undefined,
          path: ["definitions", definitionIndex],
          contentBundle: null,
        },
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

const activationGuardRow = object({ guard: literal(1) });

const activateCandidate$ = command(
  async (
    { set },
    input: CatalogCandidatePublication,
    signal: AbortSignal,
  ): Promise<OfficialWorkflowCatalogSyncResponse> => {
    const db = set(writeDb$);
    const [catalogRow] = await db
      .select(acceptedCatalogFields)
      .from(officialWorkflowCatalogState)
      .innerJoin(officialWorkflowCatalogReleases, catalogReleaseJoinCondition())
      .where(catalogAuthorityCondition())
      .limit(1);
    signal.throwIfAborted();
    const current = acceptedCatalogFromRow(catalogRow);
    const plan = catalogPublicationPlan(input, current);
    if (plan.outcome !== "publish") {
      return plan;
    }
    const [stored] = await db
      .select(catalogReleaseFields)
      .from(officialWorkflowCatalogReleases)
      .where(eq(officialWorkflowCatalogReleases.id, plan.releaseId))
      .limit(1);
    signal.throwIfAborted();
    if (stored) {
      assertCatalogReleasePayload(stored, plan);
    }
    const statement = catalogActivationSql(input, current, plan, nowDate());
    signal.throwIfAborted();
    const activation = await settle(
      (async () => {
        return parseRawRows(activationGuardRow, await db.execute(statement));
      })(),
      signal,
    );
    if (!activation.ok && safeSqlStateCode(activation.error) === "22012") {
      const latest = await set(readAcceptedOfficialWorkflowCatalog$, signal);
      if ((latest?.releaseId ?? null) !== (current?.releaseId ?? null)) {
        throw new OfficialWorkflowCatalogActivationConflictError(
          plan.releaseId,
        );
      }
      throw new OfficialWorkflowCatalogRegistrationError(
        undefined,
        activation.error,
      );
    }
    catalogActivationResult(activation, undefined);
    signal.throwIfAborted();
    return { outcome: "accepted", releaseId: plan.releaseId, diagnostics: [] };
  },
);

const catalogActivationFailureResponse$ = command(
  async (
    { set },
    error: unknown,
    signal: AbortSignal,
  ): Promise<OfficialWorkflowCatalogSyncResponse> => {
    const accepted = await set(readAcceptedOfficialWorkflowCatalog$, signal);
    if (error instanceof OfficialWorkflowCatalogActivationConflictError) {
      return accepted?.releaseId === error.candidateReleaseId
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
    }
    const definitionName =
      error instanceof OfficialWorkflowCatalogRegistrationError
        ? error.definitionName
        : undefined;
    return {
      outcome: "rejected",
      releaseId: accepted?.releaseId ?? null,
      diagnostics: [
        {
          code: "artifact-registration-failed",
          path: ["definitions"],
          ...(definitionName === undefined ? {} : { definitionName }),
        },
      ],
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
      // This preparation publisher must never downgrade a bundle-only head.
      if (current?.payload.schemaVersion === 4) {
        return {
          outcome: "rejected",
          releaseId: current.releaseId,
          diagnostics: [{ code: "activation-conflict", path: ["catalog"] }],
        };
      }
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
        current?.payload ?? null,
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
        return await set(
          catalogActivationFailureResponse$,
          activation.error,
          signal,
        );
      }
      return activation.value;
    },
  );
}
