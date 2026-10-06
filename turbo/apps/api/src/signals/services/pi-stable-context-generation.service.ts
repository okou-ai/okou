import { command } from "ccstate";
import { z } from "zod";
import { pgInt8ToSafeIntegerSchema } from "../../lib/db-raw-rows";

import type { PiStableContextBuildInput } from "@okouai/db/jsonb-contracts/pi-stable-context";
import {
  piStableContextArtifactResources,
  piStableContextGenerations,
  piStableContextHeads,
  piStableContextPublications,
} from "@okouai/db/schema/pi-stable-context";
import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNotNull,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { piStableContextInputDigest } from "./pi-stable-context-digest.service";

export const PI_STABLE_CONTEXT_AGENT_SUBJECT = "@agent";
export const PI_STABLE_CONTEXT_AGENT_INSTRUCTIONS_PUBLICATION_KEY =
  "agent-instructions";

const HEAD_DEMAND_CAPTURE_LIMIT = 16;
const HEAD_INVALIDATION_BATCH_SIZE = 256;

export function piStableContextWorkflowPublicationKey(
  workflowId: string,
): string {
  return `workflow:${workflowId}`;
}

export interface PiStableContextScope {
  readonly orgId: string;
  readonly agentId: string;
  /** Omit for agent-wide identity, public workflow, or shared resource writes. */
  readonly userId?: string;
}

export interface PiStableContextPublicationFence {
  readonly scope: PiStableContextScope;
  readonly publicationKey: string;
  readonly generation: number;
  readonly token: string;
}

export function subjectForScope(scope: PiStableContextScope): string {
  return scope.userId ?? PI_STABLE_CONTEXT_AGENT_SUBJECT;
}

export function generationScopeCondition(scope: PiStableContextScope): SQL {
  return sql`${eq(piStableContextGenerations.orgId, scope.orgId)} AND ${eq(piStableContextGenerations.agentId, scope.agentId)} AND ${eq(piStableContextGenerations.subject, subjectForScope(scope))}`;
}

function publicationKeyCondition(
  scope: PiStableContextScope,
  publicationKey: string,
): SQL {
  return sql`${eq(piStableContextPublications.orgId, scope.orgId)} AND ${eq(piStableContextPublications.agentId, scope.agentId)} AND ${eq(piStableContextPublications.subject, subjectForScope(scope))} AND ${eq(piStableContextPublications.publicationKey, publicationKey)}`;
}

export function publicationScopeCondition(
  fence: PiStableContextPublicationFence,
): SQL {
  return sql`${publicationKeyCondition(fence.scope, fence.publicationKey)} AND ${eq(piStableContextPublications.generation, fence.generation)} AND ${eq(piStableContextPublications.token, fence.token)}`;
}

export function headScopeCondition(scope: PiStableContextScope): SQL {
  const base = sql`${eq(piStableContextHeads.orgId, scope.orgId)} AND ${eq(piStableContextHeads.agentId, scope.agentId)}`;
  return scope.userId
    ? sql`${base} AND ${eq(piStableContextHeads.userId, scope.userId)}`
    : base;
}

function requireCondition(
  condition: SQL | undefined,
  description: string,
): SQL {
  if (!condition) {
    throw new Error(`Stable-context ${description} condition is empty`);
  }
  return condition;
}

export const piStableContextGenerationReceiptSchema = z.object({
  generation: pgInt8ToSafeIntegerSchema,
});

export function piStableContextGenerationFromReceipt(
  receipts: readonly { readonly generation: number }[],
): number {
  const [receipt] = receipts;
  if (!receipt) {
    throw new Error("Stable-context generation advance returned no row");
  }
  return receipt.generation;
}
export function piStableContextPublicationFromReceipt(
  receipts: readonly { readonly generation: number }[],
  scope: PiStableContextScope,
  publicationKey: string,
  token: string,
): PiStableContextPublicationFence {
  return {
    scope,
    publicationKey,
    token,
    generation: piStableContextGenerationFromReceipt(receipts),
  };
}

/** SQL fragments and prepared values below never borrow a connection. */
function missingHeadAssignments(at: Date) {
  return sql`generation = generation + 1, status = 'missing', input = NULL,
    input_digest = NULL, artifact_digest = NULL, validity_horizon = NULL,
    lease_id = NULL, lease_expires_at = NULL, available_at = ${at.toISOString()}::timestamp,
    attempt_count = 0, last_error_class = NULL, updated_at = ${at.toISOString()}::timestamp`;
}

export function invalidatePiStableContextSql(
  scope: PiStableContextScope,
  at: Date,
): SQL {
  return sql`WITH advanced AS (
    INSERT INTO ${piStableContextGenerations} (org_id, agent_id, subject, publication_state, updated_at)
    VALUES (${scope.orgId}, ${scope.agentId}, ${subjectForScope(scope)}, 'ready', ${at.toISOString()}::timestamp)
    ON CONFLICT (org_id, agent_id, subject) DO UPDATE SET
      generation = ${piStableContextGenerations.generation} + 1, updated_at = EXCLUDED.updated_at
    RETURNING generation
  ), invalidated AS (
    UPDATE ${piStableContextHeads} SET ${missingHeadAssignments(at)} WHERE ${headScopeCondition(scope)} RETURNING id
  ) SELECT generation FROM advanced`;
}

function invalidateSetSql(generations: SQL, heads: SQL, at: Date): SQL {
  return sql`WITH advanced AS (UPDATE ${piStableContextGenerations}
    SET generation = generation + 1, updated_at = ${at.toISOString()}::timestamp WHERE ${generations} RETURNING subject)
    UPDATE ${piStableContextHeads} SET ${missingHeadAssignments(at)} WHERE ${heads}`;
}

export function invalidatePiStableContextsForUserSql(
  args: { readonly orgId: string; readonly userId: string },
  at: Date,
): SQL {
  return invalidateSetSql(
    requireCondition(
      and(
        eq(piStableContextGenerations.orgId, args.orgId),
        eq(piStableContextGenerations.subject, args.userId),
      ),
      "user generation",
    ),
    requireCondition(
      and(
        eq(piStableContextHeads.orgId, args.orgId),
        eq(piStableContextHeads.userId, args.userId),
      ),
      "user heads",
    ),
    at,
  );
}
export function invalidatePiStableContextsForOrgSql(
  orgId: string,
  at: Date,
): SQL {
  return invalidateSetSql(
    eq(piStableContextGenerations.orgId, orgId),
    eq(piStableContextHeads.orgId, orgId),
    at,
  );
}
export function invalidateAllPiStableContextsSql(at: Date): SQL {
  return invalidateSetSql(sql`TRUE`, sql`TRUE`, at);
}
/** Legacy source IDs are only used to retire persisted old-shape demands. */
export function catalogDependentPiHeadCondition(
  schemaVersion: number,
  legacySourceId: string,
): SQL {
  return sql`${isNotNull(piStableContextHeads.input)} AND (
    ${piStableContextHeads.input} -> 'source' -> 'catalog' ->> 'schemaVersion' = ${String(schemaVersion)}
    OR ${piStableContextHeads.input} -> 'source' ->> 'catalogSourceId' = ${legacySourceId}
  )`;
}

export function catalogDependentPiGenerationCondition(
  schemaVersion: number,
  legacySourceId: string,
): SQL {
  return sql`${eq(piStableContextGenerations.subject, PI_STABLE_CONTEXT_AGENT_SUBJECT)} AND ${exists(sql`(SELECT 1 FROM ${piStableContextHeads}
    WHERE ${eq(piStableContextHeads.orgId, piStableContextGenerations.orgId)} AND ${eq(piStableContextHeads.agentId, piStableContextGenerations.agentId)}
    AND ${catalogDependentPiHeadCondition(schemaVersion, legacySourceId)})`)}`;
}

export function invalidateCatalogDependentPiOwnerSql(
  owner: { readonly orgId: string; readonly agentId: string },
  schemaVersion: number,
  legacySourceId: string,
  at: Date,
): SQL {
  const generations: SQL = requireCondition(
    and(
      eq(piStableContextGenerations.orgId, owner.orgId),
      eq(piStableContextGenerations.agentId, owner.agentId),
      eq(piStableContextGenerations.subject, PI_STABLE_CONTEXT_AGENT_SUBJECT),
    ),
    "catalog owner generation",
  );
  // Retain dependency facts, not serving/worker authority, on a missing head.
  // A genuine registration replaces them. No auxiliary registry or epoch.
  return sql`WITH advanced AS (UPDATE ${piStableContextGenerations}
    SET generation = generation + 1, updated_at = ${at.toISOString()}::timestamp
    WHERE ${generations} RETURNING subject)
    UPDATE ${piStableContextHeads} SET generation = generation + 1,
      status = 'missing', input_digest = NULL, artifact_digest = NULL,
      validity_horizon = NULL, lease_id = NULL, lease_expires_at = NULL,
      available_at = ${at.toISOString()}::timestamp, attempt_count = 0,
      last_error_class = NULL, updated_at = ${at.toISOString()}::timestamp
    WHERE ${headScopeCondition(owner)} AND ${catalogDependentPiHeadCondition(schemaVersion, legacySourceId)}`;
}

/** The reservation's scope generation and exact key/token are one statement. */
export function beginPiStableContextPublicationSql(
  scope: PiStableContextScope,
  publicationKey: string,
  token: string,
  at: Date,
): SQL {
  return sql`WITH advanced AS (
    INSERT INTO ${piStableContextGenerations} (org_id, agent_id, subject, publication_state, updated_at)
    VALUES (${scope.orgId}, ${scope.agentId}, ${subjectForScope(scope)}, 'pending', ${at.toISOString()}::timestamp)
    ON CONFLICT (org_id, agent_id, subject) DO UPDATE SET generation = ${piStableContextGenerations.generation} + 1,
      publication_state = 'pending', updated_at = EXCLUDED.updated_at RETURNING generation
  ), reserved AS (
    INSERT INTO ${piStableContextPublications} (org_id, agent_id, subject, publication_key, generation, token, created_at, updated_at)
    SELECT ${scope.orgId}, ${scope.agentId}, ${subjectForScope(scope)}, ${publicationKey}, generation, ${token}::uuid,
      ${at.toISOString()}::timestamp, ${at.toISOString()}::timestamp FROM advanced
    ON CONFLICT (org_id, agent_id, subject, publication_key) DO UPDATE SET generation = EXCLUDED.generation,
      token = EXCLUDED.token, created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at RETURNING generation
  ), invalidated AS (
    UPDATE ${piStableContextHeads} SET ${missingHeadAssignments(at)} WHERE ${headScopeCondition(scope)} RETURNING id
  ) SELECT generation FROM reserved`;
}

/** An actual pending publication write precedes token consumption, matching reservation order. */
export function publicationScopePendingSql(
  scope: PiStableContextScope,
  at: Date,
): SQL {
  return sql`UPDATE ${piStableContextGenerations} SET publication_state = 'pending', updated_at = ${at.toISOString()}::timestamp
    WHERE ${generationScopeCondition(scope)}`;
}
export function publicationReadinessSql(
  scope: PiStableContextScope,
  at: Date,
): SQL {
  return sql`UPDATE ${piStableContextGenerations} SET publication_state = CASE WHEN EXISTS (
    SELECT 1 FROM ${piStableContextPublications} WHERE org_id = ${scope.orgId} AND agent_id = ${scope.agentId} AND subject = ${subjectForScope(scope)}
  ) THEN 'pending' ELSE 'ready' END, updated_at = ${at.toISOString()}::timestamp WHERE ${generationScopeCondition(scope)}`;
}
export function completePiStableContextPublicationSql(
  fence: PiStableContextPublicationFence,
): SQL {
  return sql`DELETE FROM ${piStableContextPublications} WHERE ${publicationScopeCondition(fence)} AND EXISTS (SELECT 1 FROM ${piStableContextGenerations} WHERE ${generationScopeCondition(fence.scope)})`;
}
export function retirePiStableContextPublicationSql(
  scope: PiStableContextScope,
  key: string,
): SQL {
  return sql`DELETE FROM ${piStableContextPublications} WHERE ${publicationKeyCondition(scope, key)} AND EXISTS (SELECT 1 FROM ${piStableContextGenerations} WHERE ${generationScopeCondition(scope)})`;
}
export function piStableContextGenerationValues(
  scopes: readonly PiStableContextScope[],
) {
  return [
    ...new Map(
      scopes.map((scope) => {
        return [
          `${scope.orgId}\0${scope.agentId}\0${subjectForScope(scope)}`,
          scope,
        ];
      }),
    ).values(),
  ].map((scope) => {
    return {
      orgId: scope.orgId,
      agentId: scope.agentId,
      subject: subjectForScope(scope),
    };
  });
}
export function piStableContextPublicationKeyCondition(
  scope: PiStableContextScope,
  key: string,
) {
  return publicationKeyCondition(scope, key);
}

export function storageDependentHeadCondition(
  storageIds: readonly string[],
): SQL {
  return sql`EXISTS (SELECT 1 FROM ${piStableContextArtifactResources} WHERE
    ${eq(piStableContextArtifactResources.artifactDigest, piStableContextHeads.artifactDigest)}
    AND ${inArray(piStableContextArtifactResources.storageId, storageIds)})
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(${piStableContextHeads.input}->'storageMounts','[]'::jsonb)) AS mount
      WHERE mount->>'storageId' = ANY(${sql.param(storageIds)}::text[]))`;
}
export function retirePiStableContextStorageDemandsSql(
  storageIds: readonly string[],
  at: Date,
): SQL {
  return sql`UPDATE ${piStableContextHeads} SET ${missingHeadAssignments(at)} WHERE ${storageDependentHeadCondition(storageIds)}`;
}

/** One compact snapshot: at most one worker batch carries large immutable inputs. */
export function piStableContextDemandInputSql(): SQL {
  return sql`CASE WHEN ${piStableContextHeads.input} IS NOT NULL AND ${piStableContextHeads.inputDigest} IS NOT NULL
    AND SUM(CASE WHEN ${piStableContextHeads.input} IS NOT NULL AND ${piStableContextHeads.inputDigest} IS NOT NULL THEN 1 ELSE 0 END)
      OVER (ORDER BY ${piStableContextHeads.id}) <= ${HEAD_DEMAND_CAPTURE_LIMIT}
    THEN ${piStableContextHeads.input} ELSE NULL END`;
}
export interface PiStableContextCapturedHead {
  readonly id: string;
  readonly generation: number;
  readonly input: PiStableContextBuildInput | null;
}
export interface PiStableContextStorageResource {
  readonly storageId: string;
  readonly versionId: string;
  readonly archiveSize: number;
  readonly fileCount: number;
}
export function piStableContextCapturedHeadCondition(head: {
  readonly id: string;
  readonly generation: number;
}) {
  return and(
    eq(piStableContextHeads.id, head.id),
    eq(piStableContextHeads.generation, head.generation),
  );
}

export function piStableContextStorageDemandValues(
  head: PiStableContextCapturedHead,
  resource: PiStableContextStorageResource,
  at: Date,
) {
  const missing = {
    generation: head.generation + 1,
    status: "missing" as const,
    input: null,
    inputDigest: null,
    artifactDigest: null,
    validityHorizon: null,
    leaseId: null,
    leaseExpiresAt: null,
    availableAt: at,
    attemptCount: 0,
    lastErrorClass: null,
    updatedAt: at,
  };
  if (
    !head.input ||
    !head.input.storageMounts.some((mount) => {
      return mount.storageId === resource.storageId;
    })
  ) {
    return missing;
  }
  const input: PiStableContextBuildInput = {
    ...head.input,
    storageMounts: head.input.storageMounts.map((mount) => {
      return rebindStorageMount(mount, resource);
    }),
    persistedStorageMounts: head.input.persistedStorageMounts.map((mount) => {
      return mount.storageId === resource.storageId
        ? { ...mount, version: resource.versionId }
        : mount;
    }),
  };
  return {
    ...missing,
    status: "pending" as const,
    input,
    inputDigest: piStableContextInputDigest(input),
    agentGeneration: input.source.agentGeneration,
    userGeneration: input.source.userGeneration,
    validityHorizon: input.source.validityHorizon
      ? new Date(input.source.validityHorizon)
      : null,
  };
}

export function rebindStorageMount(
  mount: PiStableContextBuildInput["storageMounts"][number],
  resource: {
    readonly storageId: string;
    readonly versionId: string;
    readonly archiveSize: number;
    readonly fileCount: number;
  },
): PiStableContextBuildInput["storageMounts"][number] {
  if (mount.storageId !== resource.storageId) {
    return mount;
  }
  const { empty: _empty, ...canonical } = mount;
  return {
    ...canonical,
    versionId: resource.versionId,
    archiveSize: resource.archiveSize,
    ...(resource.fileCount === 0 ? { empty: true as const } : {}),
  };
}

/**
 * Low-frequency overrides commit independently of their disposable projections.
 * Generation advancement fences old builders immediately; canonical demand
 * registration recaptures the latest configuration on the next use. No stale
 * captured input is republished and no source transaction owns rebuild work.
 */
export const invalidateFeatureSwitchPiStableContexts$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly userId?: string },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const generationCondition = and(
      eq(piStableContextGenerations.orgId, args.orgId),
      args.userId === undefined
        ? undefined
        : eq(piStableContextGenerations.subject, args.userId),
    );
    await db
      .update(piStableContextGenerations)
      .set({
        generation: sql`${piStableContextGenerations.generation} + 1`,
        updatedAt: nowDate(),
      })
      .where(generationCondition);
    signal.throwIfAborted();

    const staleGeneration = exists(
      db
        .select({ subject: piStableContextGenerations.subject })
        .from(piStableContextGenerations)
        .where(
          and(
            eq(piStableContextGenerations.orgId, piStableContextHeads.orgId),
            eq(
              piStableContextGenerations.agentId,
              piStableContextHeads.agentId,
            ),
            or(
              and(
                eq(
                  piStableContextGenerations.subject,
                  PI_STABLE_CONTEXT_AGENT_SUBJECT,
                ),
                ne(
                  piStableContextGenerations.generation,
                  piStableContextHeads.agentGeneration,
                ),
              ),
              and(
                eq(
                  piStableContextGenerations.subject,
                  piStableContextHeads.userId,
                ),
                ne(
                  piStableContextGenerations.generation,
                  piStableContextHeads.userGeneration,
                ),
              ),
            ),
          ),
        ),
    );
    const heads = await db
      .select({
        id: piStableContextHeads.id,
        generation: piStableContextHeads.generation,
      })
      .from(piStableContextHeads)
      .where(
        and(
          eq(piStableContextHeads.orgId, args.orgId),
          args.userId === undefined
            ? undefined
            : eq(piStableContextHeads.userId, args.userId),
          staleGeneration,
        ),
      )
      .orderBy(asc(piStableContextHeads.id));
    signal.throwIfAborted();
    const invalidatedAt = nowDate();
    for (
      let offset = 0;
      offset < heads.length;
      offset += HEAD_INVALIDATION_BATCH_SIZE
    ) {
      const batch = heads.slice(offset, offset + HEAD_INVALIDATION_BATCH_SIZE);
      await db
        .update(piStableContextHeads)
        .set({
          generation: sql`${piStableContextHeads.generation} + 1`,
          status: "missing",
          input: null,
          inputDigest: null,
          artifactDigest: null,
          validityHorizon: null,
          leaseId: null,
          leaseExpiresAt: null,
          availableAt: invalidatedAt,
          attemptCount: 0,
          lastErrorClass: null,
          updatedAt: invalidatedAt,
        })
        .where(
          and(
            staleGeneration,
            or(
              ...batch.map((head) => {
                return and(
                  eq(piStableContextHeads.id, head.id),
                  eq(piStableContextHeads.generation, head.generation),
                );
              }),
            ),
          ),
        );
      signal.throwIfAborted();
    }
  },
);
