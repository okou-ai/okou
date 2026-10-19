import {
  OFFICIAL_WORKFLOW_CATALOG_PUBLICATION_SCHEMA_VERSION,
  type OfficialWorkflowAcceptedDefinition,
  type OfficialWorkflowArtifactReference,
  type OfficialWorkflowCatalogDiagnostic,
  type OfficialWorkflowCatalogReleasePayload,
  type OfficialWorkflowCatalogSyncResponse,
  type OfficialWorkflowDefinitionRevisionPayload,
  type OfficialWorkflowPublishedCatalogReleasePayload,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";
import { SYSTEM_ORG_ID, VOLUME_ORG_USER_ID } from "@okouai/core/storage-names";
import {
  officialWorkflowCatalogState,
  officialWorkflowCatalogReleases,
  officialWorkflowReconciliationWork,
  officialWorkflowDefinitionRevisions,
} from "@okouai/db/schema/official-workflow-catalog";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { and, eq } from "drizzle-orm";
import {
  OFFICIAL_WORKFLOW_CATALOG_AUTHORITY,
  type AcceptedOfficialWorkflowCatalog,
} from "./official-workflow-catalog-read.service";
import {
  canonicalJsonString,
  officialWorkflowFingerprint,
  type ValidatedOfficialWorkflowCatalog,
} from "./official-workflow-catalog-validation.service";
import type { PreparedServerSideVolume } from "./storage-volume-publication.service";
export class OfficialWorkflowCatalogRegistrationError extends Error {
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

export interface PreparedOfficialWorkflowDefinition {
  readonly definition: OfficialWorkflowDefinitionRevisionPayload;
  readonly volume: PreparedServerSideVolume;
  readonly artifact: OfficialWorkflowArtifactReference;
}

type CandidateReleaseResult =
  | {
      readonly kind: "valid";
      readonly payload: OfficialWorkflowPublishedCatalogReleasePayload;
    }
  | {
      readonly kind: "invalid";
      readonly diagnostics: readonly OfficialWorkflowCatalogDiagnostic[];
    };

export function releaseDiagnostics(
  catalog: ValidatedOfficialWorkflowCatalog,
  previous: OfficialWorkflowCatalogReleasePayload | null,
): readonly OfficialWorkflowCatalogDiagnostic[] {
  const diagnostics: OfficialWorkflowCatalogDiagnostic[] = [];
  const sourceByName = new Map(
    catalog.source.definitions.map((definition) => {
      return [definition.name, definition] as const;
    }),
  );
  for (const previousDefinition of previous?.definitions ?? []) {
    if (!sourceByName.has(previousDefinition.name)) {
      diagnostics.push({
        code: "missing-released-definition",
        path: ["definitions"],
        definitionName: previousDefinition.name,
      });
    }
  }
  const previousNames = new Set(
    previous?.definitions.map((definition) => {
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

/**
 * A retired definition keeps its immutable revision, artifact and Blueprint
 * fingerprints. Its Blueprints are projected onto the publication schema, which
 * drops the retired v2 completion-email runtime setting.
 */
function retiredDefinition(
  previous: OfficialWorkflowAcceptedDefinition,
  presentation: OfficialWorkflowPublishedCatalogReleasePayload["definitions"][number]["presentation"],
): OfficialWorkflowPublishedCatalogReleasePayload["definitions"][number] {
  return {
    name: previous.name,
    lifecycle: "retired",
    revision: previous.revision,
    artifact: previous.artifact,
    blueprints: previous.blueprints.map((blueprint) => {
      return {
        key: blueprint.key,
        parameters: blueprint.parameters,
        desiredState: blueprint.desiredState,
        fingerprint: blueprint.fingerprint,
      };
    }),
    releasedBlueprintKeys: previous.releasedBlueprintKeys,
    presentation,
  };
}

function buildCandidateRelease(
  catalog: ValidatedOfficialWorkflowCatalog,
  previous: OfficialWorkflowCatalogReleasePayload | null,
  preparedByName: ReadonlyMap<string, PreparedOfficialWorkflowDefinition>,
): CandidateReleaseResult {
  const diagnostics = releaseDiagnostics(catalog, previous);
  if (diagnostics.length > 0) {
    return { kind: "invalid", diagnostics };
  }
  const previousByName = new Map(
    previous?.definitions.map((definition) => {
      return [definition.name, definition] as const;
    }) ?? [],
  );
  const definitions: OfficialWorkflowPublishedCatalogReleasePayload["definitions"] =
    [];
  for (const sourceDefinition of catalog.source.definitions) {
    const previousDefinition = previousByName.get(sourceDefinition.name);
    if (sourceDefinition.lifecycle === "retired") {
      if (!previousDefinition) {
        throw new OfficialWorkflowCatalogRegistrationError(
          sourceDefinition.name,
        );
      }
      definitions.push(
        retiredDefinition(previousDefinition, sourceDefinition.presentation),
      );
      continue;
    }
    const prepared = preparedByName.get(sourceDefinition.name);
    if (
      !prepared ||
      prepared.definition.schemaVersion !==
        OFFICIAL_WORKFLOW_CATALOG_PUBLICATION_SCHEMA_VERSION
    ) {
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

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface CatalogCandidatePublication {
  readonly catalog: ValidatedOfficialWorkflowCatalog;
  readonly preparedByName: ReadonlyMap<
    string,
    PreparedOfficialWorkflowDefinition
  >;
  readonly observedReleaseId: string | null;
}
export function catalogPublicationPlan(
  input: CatalogCandidatePublication,
  current: AcceptedOfficialWorkflowCatalog | null,
):
  | OfficialWorkflowCatalogSyncResponse
  | {
      readonly outcome: "publish";
      readonly releaseId: string;
      readonly payload: OfficialWorkflowCatalogReleasePayload;
      readonly hiddenThreadDefinitionNames: readonly string[];
    } {
  const currentReleaseId = current?.releaseId ?? null;
  // Every decodable accepted catalog (v2 or v3) is at or below the publication
  // version, so this writer may upgrade it. A newer catalog fails its strict
  // read before any plan, so it is never replaced.
  const previous = current?.payload ?? null;
  const stale = currentReleaseId !== input.observedReleaseId;
  const candidate = buildCandidateRelease(
    input.catalog,
    previous,
    input.preparedByName,
  );
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
  const hiddenThreadDefinitionNames = input.catalog.source.definitions
    .filter((definition) => {
      return definition.hiddenThread === true;
    })
    .map((definition) => {
      return definition.name;
    })
    .sort(compareStrings);
  // Preserve historical release identities when there is no visibility policy.
  const releaseId = officialWorkflowFingerprint(
    hiddenThreadDefinitionNames.length === 0
      ? candidate.payload
      : { payload: candidate.payload, hiddenThreadDefinitionNames },
  );
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
    input.preparedByName,
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
  return {
    outcome: "publish",
    releaseId,
    payload: candidate.payload,
    hiddenThreadDefinitionNames,
  };
}

export function catalogAuthorityCondition() {
  return eq(
    officialWorkflowCatalogState.authority,
    OFFICIAL_WORKFLOW_CATALOG_AUTHORITY,
  );
}
export function catalogPublicationCondition(previousReleaseId: string) {
  return and(
    catalogAuthorityCondition(),
    eq(officialWorkflowCatalogState.acceptedReleaseId, previousReleaseId),
  );
}
export function preparedStorageVersionCondition(
  artifact: OfficialWorkflowArtifactReference,
) {
  return and(
    eq(storageVersions.storageId, storages.id),
    eq(storageVersions.id, artifact.storageVersion),
  );
}
export function preparedStorageCondition(
  artifact: OfficialWorkflowArtifactReference,
) {
  return and(
    eq(storages.id, artifact.storageId),
    eq(storages.orgId, SYSTEM_ORG_ID),
    eq(storages.userId, VOLUME_ORG_USER_ID),
    eq(storages.name, artifact.storageName),
  );
}
export function preparedStorageMatches(
  row:
    | { readonly storageId: string; readonly storageVersion: string | null }
    | undefined,
  artifact: OfficialWorkflowArtifactReference,
) {
  return (
    row !== undefined &&
    row.storageId === artifact.storageId &&
    (row.storageVersion === null ||
      row.storageVersion === artifact.storageVersion)
  );
}
export function definitionRevisionValues(
  prepared: PreparedOfficialWorkflowDefinition,
) {
  return {
    definitionName: prepared.definition.name,
    revision: prepared.definition.revision,
    payload: prepared.definition,
    storageName: prepared.artifact.storageName,
    storageId: prepared.artifact.storageId,
    storageVersion: prepared.artifact.storageVersion,
  };
}
export function definitionRevisionCondition(
  prepared: PreparedOfficialWorkflowDefinition,
) {
  return and(
    eq(
      officialWorkflowDefinitionRevisions.definitionName,
      prepared.definition.name,
    ),
    eq(
      officialWorkflowDefinitionRevisions.revision,
      prepared.definition.revision,
    ),
  );
}
export function definitionRevisionMatches(
  row:
    | Pick<
        typeof officialWorkflowDefinitionRevisions.$inferSelect,
        "payload" | "storageName" | "storageId" | "storageVersion"
      >
    | undefined,
  prepared: PreparedOfficialWorkflowDefinition,
) {
  return (
    row !== undefined &&
    canonicalJsonString(row.payload) ===
      canonicalJsonString(prepared.definition) &&
    row.storageName === prepared.artifact.storageName &&
    row.storageId === prepared.artifact.storageId &&
    row.storageVersion === prepared.artifact.storageVersion
  );
}

export function changedWorkflowDefinitions(
  previous: AcceptedOfficialWorkflowCatalog | null,
  next: {
    readonly payload: OfficialWorkflowCatalogReleasePayload;
    readonly hiddenThreadDefinitionNames: readonly string[];
  },
) {
  const { payload, hiddenThreadDefinitionNames } = next;
  const previousByName = new Map(
    previous?.payload.definitions.map((definition) => {
      return [definition.name, definition] as const;
    }) ?? [],
  );
  return payload.definitions.filter((definition) => {
    if (
      definition.lifecycle !== "active" ||
      !previousByName.has(definition.name)
    ) {
      return false;
    }
    return (
      blueprintDesiredStateChanged(
        previousByName.get(definition.name),
        definition,
      ) ||
      (previous?.hiddenThreadDefinitionNames.includes(definition.name) ??
        false) !== hiddenThreadDefinitionNames.includes(definition.name)
    );
  });
}
export function reconciliationWorkResetValues(
  releaseId: string,
  currentTime: Date,
) {
  return {
    requestedReleaseId: releaseId,
    cursorWorkflowId: null,
    state: "pending" as const,
    leaseId: null,
    leaseExpiresAt: null,
    availableAt: currentTime,
    attemptCount: 0,
    lastError: null,
    updatedAt: currentTime,
  };
}
export function reconciliationWorkValues(
  definitionName: string,
  releaseId: string,
  currentTime: Date,
) {
  return {
    definitionName,
    requestedReleaseId: releaseId,
    cursorWorkflowId: null,
    state: "pending" as const,
    leaseId: null,
    leaseExpiresAt: null,
    availableAt: currentTime,
    attemptCount: 0,
    lastError: null,
    createdAt: currentTime,
    updatedAt: currentTime,
  };
}

export function catalogReleaseJoinCondition() {
  return eq(
    officialWorkflowCatalogReleases.id,
    officialWorkflowCatalogState.acceptedReleaseId,
  );
}
export function catalogStateValues(releaseId: string, currentTime: Date) {
  return {
    authority: OFFICIAL_WORKFLOW_CATALOG_AUTHORITY,
    acceptedReleaseId: releaseId,
    updatedAt: currentTime,
  };
}
export function reconciliationDefinitionCondition(definitionName: string) {
  return eq(officialWorkflowReconciliationWork.definitionName, definitionName);
}
export function retiredBlueprintDefinitions(
  payload: OfficialWorkflowCatalogReleasePayload,
) {
  return payload.definitions.filter((definition) => {
    return definition.lifecycle !== "active";
  });
}

export function catalogActivationResult<T>(
  activation:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
  definitionName: string | undefined,
): T {
  if (activation.ok) {
    return activation.value;
  }
  if (definitionName !== undefined) {
    throw new OfficialWorkflowCatalogRegistrationError(
      definitionName,
      activation.error,
    );
  }
  throw activation.error;
}
export function assertCatalogReleasePayload(
  stored:
    | {
        readonly payload: unknown;
        readonly hiddenThreadDefinitionNames: unknown;
      }
    | undefined,
  next: {
    readonly payload: OfficialWorkflowCatalogReleasePayload;
    readonly hiddenThreadDefinitionNames: readonly string[];
  },
): void {
  if (
    !stored ||
    canonicalJsonString(stored.payload) !== canonicalJsonString(next.payload) ||
    canonicalJsonString(stored.hiddenThreadDefinitionNames) !==
      canonicalJsonString(next.hiddenThreadDefinitionNames)
  ) {
    throw new OfficialWorkflowCatalogRegistrationError();
  }
}
export function assertPublishedDefinitionCount(
  published: number | null,
  definitionName: string,
): void {
  if (published !== 1) {
    throw new OfficialWorkflowCatalogRegistrationError(definitionName);
  }
}
