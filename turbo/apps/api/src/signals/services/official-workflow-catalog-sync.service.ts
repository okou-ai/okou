import type {
  OfficialWorkflowAcceptedRevision,
  OfficialWorkflowAcceptedDefinition,
  OfficialWorkflowArtifactReference,
  OfficialWorkflowCatalogDiagnostic,
  OfficialWorkflowCatalogSyncResponse,
  OfficialWorkflowDefinitionRevisionPayload,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";
import { getOfficialWorkflowDefinitionStorageName } from "@okouai/core/storage-names";
import {
  officialWorkflowArtifactFiles,
  officialWorkflowExecutionFiles,
} from "@okouai/core/official-workflow-artifact";
import {
  officialWorkflowCatalogReleases,
  officialWorkflowCatalogState,
} from "@okouai/db/schema/official-workflow-catalog";
import { prepareContentBundle } from "@okouai/core/content-bundle";
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
  readAcceptedOfficialWorkflowRevision$,
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

function registeredRevisionMatches(
  previous: OfficialWorkflowAcceptedDefinition,
  registered: OfficialWorkflowAcceptedRevision | null,
): boolean {
  if (!registered) {
    return false;
  }
  return previous.contentBundle
    ? registered.contentBundle?.sha256 === previous.contentBundle.sha256 &&
        registered.contentBundle.archiveBytes ===
          previous.contentBundle.archiveBytes
    : registered.artifact !== undefined &&
        artifactReferencesMatch(registered.artifact, previous.artifact);
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

const prepareDefinitionBundle$ = command(
  async (
    { set },
    args: {
      readonly definition: OfficialWorkflowDefinitionRevisionPayload;
      readonly registered: OfficialWorkflowAcceptedRevision | null;
      readonly path: readonly (string | number)[];
    },
    signal: AbortSignal,
  ): Promise<DefinitionPreparationResult> => {
    const { definition, registered, path } = args;
    if (
      registered &&
      canonicalJsonString(registered.definition) !==
        canonicalJsonString(definition)
    ) {
      return artifactPreparationRejected(definition.name, path);
    }
    const artifact = registered?.artifact;
    // Retain exact legacy identities for queued Runs without republishing Storage.
    if (
      artifact &&
      (artifact.storageName !==
        getOfficialWorkflowDefinitionStorageName(definition.name) ||
        officialWorkflowArtifactFiles(definition, {
          storageId: artifact.storageId,
          storageVersion: artifact.storageVersion,
          definitionManifest: `${canonicalJsonString(definition)}\n`,
        }) === null)
    ) {
      return artifactPreparationRejected(definition.name, path);
    }
    const files = officialWorkflowExecutionFiles(definition).map((file) => {
      return { path: file.path, content: Buffer.from(file.content, "utf8") };
    });
    const publication = await settle(
      (async () => {
        if (registered?.contentBundle) {
          const prepared = await prepareContentBundle(files);
          signal.throwIfAborted();
          return prepared.descriptor;
        }
        return await set(publishContentBundle$, files, signal);
      })(),
      signal,
    );
    if (!publication.ok) {
      return artifactPreparationRejected(definition.name, path);
    }
    const contentBundle = publication.value;
    if (
      registered?.contentBundle &&
      canonicalJsonString(registered.contentBundle) !==
        canonicalJsonString(contentBundle)
    ) {
      return artifactPreparationRejected(definition.name, path);
    }
    return {
      kind: "prepared",
      definition: { definition, artifact, contentBundle },
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
    | DefinitionPreparationRejection
  > => {
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
      const path = ["definitions", definitionIndex];
      const previousDefinition = previousByName.get(sourceDefinition.name);
      if (sourceDefinition.lifecycle === "retired" && !previousDefinition) {
        continue;
      }
      const sourceRevision = catalog.activeDefinitions.get(
        sourceDefinition.name,
      )?.revisionPayload;
      const revision =
        sourceDefinition.lifecycle === "active"
          ? sourceRevision?.revision
          : previousDefinition?.revision;
      if (revision === undefined) {
        return artifactPreparationRejected(sourceDefinition.name, path);
      }
      // Only revisions referenced by this candidate are publication dependencies.
      const registration = await settle(
        set(
          readAcceptedOfficialWorkflowRevision$,
          { name: sourceDefinition.name, revision },
          signal,
        ),
        signal,
      );
      if (!registration.ok) {
        return artifactPreparationRejected(sourceDefinition.name, path);
      }
      const registered = registration.value;
      if (
        previousDefinition?.revision === revision &&
        !registeredRevisionMatches(previousDefinition, registered)
      ) {
        return artifactPreparationRejected(sourceDefinition.name, path);
      }
      const definition =
        sourceDefinition.lifecycle === "active"
          ? sourceRevision
          : registered?.definition;
      if (!definition) {
        return artifactPreparationRejected(sourceDefinition.name, path);
      }
      const preparation = await set(
        prepareDefinitionBundle$,
        { definition, registered, path },
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
