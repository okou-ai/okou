import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { artifacts, presentationArtifacts } from "@okouai/db/schema/artifact";
import {
  hostedSites,
  privateHostedDeployments,
} from "@okouai/db/runtime/hosted-site";

/**
 * Aliased `artifacts` tables for single-query O(1) site->artifact joins via
 * `presentation_artifacts_site_unique` + `artifacts_kind_entity_unique`.
 */
export const hostedSiteDirectArtifact = alias(
  artifacts,
  "hosted_site_direct_artifact",
);
export const hostedSitePresentationArtifact = alias(
  artifacts,
  "hosted_site_presentation_artifact",
);

interface SiteArtifactJoinOptions {
  readonly activeOnly?: boolean;
  readonly matchAuthor?: boolean;
}

/**
 * Join predicate pairing `hosted_sites` with its `kind = 'hosted-site'`
 * artifact via `artifacts_kind_entity_unique (kind, entity_id)`.
 */
export function hostedSiteDirectArtifactJoin(
  options?: SiteArtifactJoinOptions,
): SQL | undefined {
  return and(
    eq(hostedSiteDirectArtifact.kind, "hosted-site"),
    eq(hostedSiteDirectArtifact.entityId, hostedSites.id),
    eq(hostedSiteDirectArtifact.orgId, hostedSites.orgId),
    options?.matchAuthor
      ? eq(hostedSiteDirectArtifact.authorUserId, hostedSites.userId)
      : undefined,
    options?.activeOnly
      ? isNull(hostedSiteDirectArtifact.deletedAt)
      : undefined,
  );
}

/**
 * Join predicate pairing `presentation_artifacts` (joined on
 * `presentation_artifacts_site_unique`) with its `kind = 'presentation'`
 * artifact via `artifacts_kind_entity_unique (kind, entity_id)`.
 */
export function hostedSitePresentationArtifactJoin(
  options?: SiteArtifactJoinOptions,
): SQL | undefined {
  return and(
    eq(hostedSitePresentationArtifact.kind, "presentation"),
    eq(hostedSitePresentationArtifact.entityId, presentationArtifacts.id),
    eq(hostedSitePresentationArtifact.orgId, hostedSites.orgId),
    options?.matchAuthor
      ? eq(hostedSitePresentationArtifact.authorUserId, hostedSites.userId)
      : undefined,
    options?.activeOnly
      ? isNull(hostedSitePresentationArtifact.deletedAt)
      : undefined,
  );
}

/**
 * O(1) predicate matching the canonical `artifacts` row for `siteId` across
 * both `hosted-site` and `presentation` kinds via
 * `artifacts_kind_entity_unique` + `presentation_artifacts_site_unique`.
 *
 * Uses a scalar subquery (`= (SELECT ... LIMIT 1)`) so PostgreSQL plans a
 * non-correlated InitPlan + BitmapOr of two unique index scans on
 * `artifacts_kind_entity_unique` rather than a sequential or wide index scan.
 */
export function siteArtifactIdentityPredicate(siteId: string): SQL | undefined {
  return or(
    and(eq(artifacts.kind, "hosted-site"), eq(artifacts.entityId, siteId)),
    and(
      eq(artifacts.kind, "presentation"),
      sql`${artifacts.entityId} = (
        SELECT ${presentationArtifacts.id}
        FROM ${presentationArtifacts}
        WHERE ${eq(presentationArtifacts.hostedSiteId, siteId)}
        LIMIT 1
      )`,
    ),
  );
}

/**
 * O(1) predicate matching the live site `artifacts` row corresponding to a
 * historical `private_hosted_deployments` row via
 * `artifacts_kind_entity_unique` + `presentation_artifacts_site_unique`.
 */
export function privateDeploymentSiteArtifactPredicate(args: {
  readonly deploymentId: string;
  readonly orgId: string;
  readonly userId: string;
}): SQL | undefined {
  return or(
    and(
      eq(artifacts.kind, "hosted-site"),
      sql`${artifacts.entityId} = (
        SELECT ${privateHostedDeployments.siteId}
        FROM ${privateHostedDeployments}
        WHERE ${eq(privateHostedDeployments.id, args.deploymentId)}
          AND ${eq(privateHostedDeployments.orgId, args.orgId)}
          AND ${eq(privateHostedDeployments.userId, args.userId)}
        LIMIT 1
      )`,
    ),
    and(
      eq(artifacts.kind, "presentation"),
      sql`${artifacts.entityId} = (
        SELECT ${presentationArtifacts.id}
        FROM ${presentationArtifacts}
        INNER JOIN ${privateHostedDeployments}
          ON ${eq(
            privateHostedDeployments.siteId,
            presentationArtifacts.hostedSiteId,
          )}
        WHERE ${eq(privateHostedDeployments.id, args.deploymentId)}
          AND ${eq(privateHostedDeployments.orgId, args.orgId)}
          AND ${eq(privateHostedDeployments.userId, args.userId)}
        LIMIT 1
      )`,
    ),
  );
}
