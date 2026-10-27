import {
  storagePublicationGenerations,
  storagePublicationTokens,
} from "@okouai/db/schema/storage-publication-fence";
import { eq, sql, type SQL } from "drizzle-orm";

/**
 * Visibility changes still arbitrate against outgoing Stage 1 reservations.
 * Remove this bridge after that writer has drained and rollback excludes it;
 * Stage 3 of #42362 owns its retirement.
 */
const AGENT_SUBJECT = "@agent";

export function workflowPublicationKey(workflowId: string): string {
  return `workflow:${workflowId}`;
}

interface PublicationFenceScope {
  readonly orgId: string;
  readonly agentId: string;
  readonly userId?: string;
}

function subjectForScope(scope: PublicationFenceScope): string {
  return scope.userId ?? AGENT_SUBJECT;
}

export function generationScopeCondition(scope: PublicationFenceScope): SQL {
  return sql`${eq(storagePublicationGenerations.orgId, scope.orgId)} AND ${eq(storagePublicationGenerations.agentId, scope.agentId)} AND ${eq(storagePublicationGenerations.subject, subjectForScope(scope))}`;
}

export function publicationKeyCondition(
  scope: PublicationFenceScope,
  publicationKey: string,
): SQL {
  return sql`${eq(storagePublicationTokens.orgId, scope.orgId)} AND ${eq(storagePublicationTokens.agentId, scope.agentId)} AND ${eq(storagePublicationTokens.subject, subjectForScope(scope))} AND ${eq(storagePublicationTokens.publicationKey, publicationKey)}`;
}

/** Keep the existing scope-before-token ordering during API writer overlap. */
export function lockPublicationScopeSql(
  scope: PublicationFenceScope,
  at: Date,
): SQL {
  return sql`UPDATE ${storagePublicationGenerations} SET updated_at = ${at.toISOString()}::timestamp
    WHERE ${generationScopeCondition(scope)}`;
}

export function publicationGenerationValues(
  scopes: readonly PublicationFenceScope[],
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
