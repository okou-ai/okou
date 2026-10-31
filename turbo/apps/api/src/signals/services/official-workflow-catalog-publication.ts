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
import { storages } from "@okouai/db/schema/storage";
import { and, count, eq, exists, sql, type SQL } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { pgIntegerDecoder } from "../../lib/db-structured-result";
import {
  OFFICIAL_WORKFLOW_CATALOG_AUTHORITY,
  type AcceptedOfficialWorkflowCatalog,
} from "./official-workflow-catalog-read.service";
import { canonicalJsonString } from "../../lib/canonical-json";
import {
  officialWorkflowFingerprint,
  type ValidatedOfficialWorkflowCatalog,
} from "./official-workflow-catalog-validation.service";
import type { PreparedServerSideVolume } from "./storage-volume-publication.service";
import { preparedVolumePublicationPlan } from "./storage-volume-publication-sql";
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
      return definition.lifecycle === "active";
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
function preparedStorageCondition(artifact: OfficialWorkflowArtifactReference) {
  return and(
    eq(storages.id, artifact.storageId),
    eq(storages.orgId, SYSTEM_ORG_ID),
    eq(storages.userId, VOLUME_ORG_USER_ID),
    eq(storages.name, artifact.storageName),
  );
}
/** Publish the owned volume and its exact immutable definition together. */
export function preparedDefinitionPublicationPlan(
  prepared: PreparedOfficialWorkflowDefinition,
  publishedAt: Date,
  admitted: SQL,
  namespace: string,
) {
  const volume = preparedVolumePublicationPlan(
    prepared.volume,
    publishedAt,
    and(preparedStorageCondition(prepared.artifact), admitted),
    namespace,
  );
  const query = new QueryBuilder();
  const table = officialWorkflowDefinitionRevisions;
  const registered = query.$with(`${namespace}registered_definition`, {
    definitionName: table.definitionName,
  }).as(sql`INSERT INTO ${table}
      (definition_name, revision, payload, storage_name, storage_id, storage_version)
    SELECT ${prepared.definition.name}, ${prepared.definition.revision},
      ${sql.param(prepared.definition, table.payload)}, ${prepared.artifact.storageName},
      ${prepared.artifact.storageId}, ${prepared.artifact.storageVersion}
    FROM ${volume.published}
    WHERE true
    ON CONFLICT (definition_name, revision) DO UPDATE
      SET definition_name = EXCLUDED.definition_name
    WHERE ${table.payload} = EXCLUDED.payload
      AND ${table.storageName} = EXCLUDED.storage_name
      AND ${table.storageId} = EXCLUDED.storage_id
      AND ${table.storageVersion} = EXCLUDED.storage_version
    RETURNING definition_name`);
  return { ctes: [...volume.ctes, registered], registered };
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

function catalogRepairWorkSql(
  definitionName: string,
  releaseId: string,
  at: Date,
  admitted: SQL,
) {
  const v = reconciliationWorkValues(definitionName, releaseId, at);
  const u = reconciliationWorkResetValues(releaseId, at);
  const t = officialWorkflowReconciliationWork;
  return sql`INSERT INTO ${t}
    (definition_name, requested_release_id, cursor_workflow_id, state, lease_id,
     lease_expires_at, available_at, attempt_count, last_error, created_at, updated_at)
    SELECT ${v.definitionName}, ${v.requestedReleaseId}, ${sql.param(v.cursorWorkflowId, t.cursorWorkflowId)}, ${v.state},
      ${sql.param(v.leaseId, t.leaseId)}, ${sql.param(v.leaseExpiresAt, t.leaseExpiresAt)},
      ${sql.param(v.availableAt, t.availableAt)}, ${v.attemptCount}, ${v.lastError},
      ${sql.param(v.createdAt, t.createdAt)}, ${sql.param(v.updatedAt, t.updatedAt)}
    WHERE ${admitted}
    ON CONFLICT (definition_name) DO UPDATE SET
      requested_release_id = ${u.requestedReleaseId}, cursor_workflow_id = ${sql.param(u.cursorWorkflowId, t.cursorWorkflowId)},
      state = ${u.state}, lease_id = ${sql.param(u.leaseId, t.leaseId)},
      lease_expires_at = ${sql.param(u.leaseExpiresAt, t.leaseExpiresAt)},
      available_at = ${sql.param(u.availableAt, t.availableAt)}, attempt_count = ${u.attemptCount},
      last_error = ${u.lastError}, updated_at = ${sql.param(u.updatedAt, t.updatedAt)}
    RETURNING definition_name`;
}

/** Claim the existing accepted-pointer version before publishing dependent rows. */
export function catalogActivationSql(
  input: CatalogCandidatePublication,
  current: AcceptedOfficialWorkflowCatalog | null,
  plan: Extract<
    ReturnType<typeof catalogPublicationPlan>,
    { readonly outcome: "publish" }
  >,
  publishedAt: Date,
) {
  const query = new QueryBuilder();
  const state = officialWorkflowCatalogState;
  const stateValues = catalogStateValues(plan.releaseId, publishedAt);
  const admitted = query
    .$with("catalog_activation_authority", { authority: state.authority })
    .as(
      current
        ? query
            .select({ authority: state.authority })
            .from(state)
            .where(catalogPublicationCondition(current.releaseId))
            .for("update")
            .getSQL()
        : query
            .select({
              authority:
                sql`${sql.param(stateValues.authority, state.authority)}`
                  .mapWith(state.authority)
                  .as("authority"),
            })
            .from(sql`(SELECT 1) AS initial_catalog_authority`)
            .getSQL(),
    );
  const releases = officialWorkflowCatalogReleases;
  const release = query
    .$with("registered_catalog_release", { id: releases.id })
    .as(
      sql`INSERT INTO ${releases} (id, payload, hidden_thread_definition_names)
      SELECT ${plan.releaseId}, ${sql.param(plan.payload, releases.payload)},
        ${sql.param(plan.hiddenThreadDefinitionNames, releases.hiddenThreadDefinitionNames)}
      FROM ${admitted} WHERE true
      ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
      WHERE ${and(eq(releases.payload, sql`EXCLUDED.payload`), eq(releases.hiddenThreadDefinitionNames, sql`EXCLUDED.hidden_thread_definition_names`))}
      RETURNING id`,
    );
  const publication = current
    ? sql`UPDATE ${state} SET accepted_release_id = ${plan.releaseId},
        updated_at = ${sql.param(publishedAt, state.updatedAt)}
      WHERE ${and(catalogPublicationCondition(current.releaseId), exists(query.select({ id: release.id }).from(release)))}
      RETURNING authority`
    : sql`INSERT INTO ${state} (authority, accepted_release_id, updated_at)
      SELECT ${admitted.authority}, ${release.id}, ${sql.param(publishedAt, state.updatedAt)}
      FROM ${release} CROSS JOIN ${admitted}
      ON CONFLICT (authority) DO NOTHING RETURNING authority`;
  const published = query
    .$with("published_catalog_pointer", { authority: state.authority })
    .as(publication);
  const commitAuthority = exists(
    query.select({ authority: published.authority }).from(published),
  );
  let ready = commitAuthority;
  const definitions = [...input.preparedByName.values()].map(
    (prepared, index) => {
      const definition = preparedDefinitionPublicationPlan(
        prepared,
        publishedAt,
        ready,
        `catalog_definition_${index}_`,
      );
      ready = exists(
        query
          .select({ name: definition.registered.definitionName })
          .from(definition.registered),
      );
      return definition;
    },
  );
  const retired = retiredBlueprintDefinitions(plan.payload).map(
    (definition, index) => {
      return query
        .$with(`retired_catalog_repair_${index}`, {
          definitionName: officialWorkflowReconciliationWork.definitionName,
        })
        .as(
          sql`DELETE FROM ${officialWorkflowReconciliationWork}
        WHERE ${and(reconciliationDefinitionCondition(definition.name), ready)} RETURNING definition_name`,
        );
    },
  );
  const changed = changedWorkflowDefinitions(current, plan).map(
    (definition, index) => {
      return query
        .$with(`changed_catalog_repair_${index}`, {
          definitionName: officialWorkflowReconciliationWork.definitionName,
        })
        .as(
          catalogRepairWorkSql(
            definition.name,
            plan.releaseId,
            publishedAt,
            ready,
          ),
        );
    },
  );
  const required = definitions.map((definition) => {
    return sql`(${query.select({ count: count() }).from(definition.registered)}) = 1`;
  });
  // Even an empty/lost pointer emits the aggregate. A failed publication raises
  // inside this statement, rolling back release, pointer, resources and work.
  return query
    .with(
      admitted,
      release,
      published,
      ...definitions.flatMap((definition) => {
        return definition.ctes;
      }),
      ...retired,
      ...changed,
    )
    .select({
      guard:
        sql`(1 / CASE WHEN ${count(published.authority)} = 1 AND ${and(sql`(${query.select({ count: count() }).from(release)}) = 1`, ...required)} THEN 1 ELSE 0 END)::int`
          .mapWith(pgIntegerDecoder)
          .as("guard"),
    })
    .from(published)
    .getSQL();
}
