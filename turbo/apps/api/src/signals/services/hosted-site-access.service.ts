import { createHash } from "node:crypto";
import { command } from "ccstate";
import { and, desc, eq, exists, isNull, sql } from "drizzle-orm";
import type { infer as zInfer } from "zod";
import type {
  HostedSiteAccessDecision,
  HostedSiteVisibility,
  hostedSiteVisibilitySchema,
} from "@okouai/api-contracts/contracts/hosted-site-access";
import {
  CURRENT_LINK_LAYOUT,
  linkLayoutSegment,
} from "@okouai/api-contracts/contracts/link-layout";
import { artifacts, presentationArtifacts } from "@okouai/db/schema/artifact";
import { artifactShares } from "@okouai/db/schema/artifact-share";
import { hostedSites, hostedDeployments } from "@okouai/db/runtime/hosted-site";
import {
  nullableDriverValueDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { clerk$, isClerkResourceNotFound } from "../external/clerk";
import { settle } from "../utils";
import {
  hostedSiteDirectArtifact,
  hostedSiteDirectArtifactJoin,
  hostedSitePresentationArtifact,
  hostedSitePresentationArtifactJoin,
} from "./hosted-site-artifact.service";

type Owner = {
  readonly userId: string;
  readonly orgId: string;
  readonly siteId: string;
  /** Publication preparation establishes the policy before serving any bytes. */
  readonly preparing?: boolean;
};

function deterministicRevisionUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sitePolicyRevision(
  siteId: string,
  sourceId: string,
  visibility: HostedSiteVisibility,
  xmin: string,
): string {
  return deterministicRevisionUuid(
    `hosted-site-visibility-v2:${siteId}:${sourceId}:${visibility}:${xmin}`,
  );
}

export const readHostedSitePolicy$ = command(
  async ({ get }, siteId: string, signal: AbortSignal) => {
    const database = get(db$);
    const [row] = await database
      .select({
        site: hostedSites,
        directArtifactId: hostedSiteDirectArtifact.id,
        directVisibility: hostedSiteDirectArtifact.visibility,
        directXmin: sql`"hosted_site_direct_artifact"."xmin"::text`.mapWith(
          nullableDriverValueDecoder(pgTextDecoder),
        ),
        presentationArtifactId: hostedSitePresentationArtifact.id,
        presentationVisibility: hostedSitePresentationArtifact.visibility,
        presentationXmin:
          sql`"hosted_site_presentation_artifact"."xmin"::text`.mapWith(
            nullableDriverValueDecoder(pgTextDecoder),
          ),
      })
      .from(hostedSites)
      .leftJoin(
        presentationArtifacts,
        eq(presentationArtifacts.hostedSiteId, hostedSites.id),
      )
      .leftJoin(
        hostedSiteDirectArtifact,
        hostedSiteDirectArtifactJoin({ activeOnly: true }),
      )
      .leftJoin(
        hostedSitePresentationArtifact,
        hostedSitePresentationArtifactJoin({ activeOnly: true }),
      )
      .where(and(eq(hostedSites.id, siteId), isNull(hostedSites.deletedAt)))
      .limit(1);
    signal.throwIfAborted();
    if (!row) {
      return null;
    }
    const artifactId = row.directArtifactId ?? row.presentationArtifactId;
    const visibility = row.directArtifactId
      ? row.directVisibility
      : row.presentationVisibility;
    const xmin = row.directArtifactId ? row.directXmin : row.presentationXmin;
    if (artifactId && visibility && xmin) {
      return {
        site: row.site,
        artifactId,
        visibility,
        revision: sitePolicyRevision(row.site.id, artifactId, visibility, xmin),
      };
    }
    // Unpublished sites carry prepared visibility on their latest uploading
    // deployment manifest until completion creates the `artifacts` row.
    if (row.site.activeDeploymentId === null) {
      const [deployment] = await database
        .select({
          id: hostedDeployments.id,
          manifest: hostedDeployments.manifest,
          xmin: sql`"hosted_deployments"."xmin"::text`.mapWith(pgTextDecoder),
        })
        .from(hostedDeployments)
        .where(eq(hostedDeployments.siteId, siteId))
        .orderBy(desc(hostedDeployments.createdAt))
        .limit(1);
      signal.throwIfAborted();
      const prepared = deployment?.manifest.visibility;
      if (deployment && prepared) {
        return {
          site: row.site,
          artifactId: null,
          visibility: prepared,
          revision: sitePolicyRevision(
            row.site.id,
            deployment.id,
            prepared,
            deployment.xmin,
          ),
        };
      }
    }
    return {
      site: row.site,
      artifactId: null,
      visibility: "public" as const,
      revision: null,
    };
  },
);

/** Live hosted-site access evaluated exclusively from `artifacts.visibility` + `artifact_shares`. */
export const checkHostedSiteAccess$ = command(
  async (
    { get, set },
    args: { readonly siteId: string; readonly userId?: string },
    signal: AbortSignal,
  ): Promise<HostedSiteAccessDecision> => {
    const policy = await set(readHostedSitePolicy$, args.siteId, signal);
    if (!policy) {
      return { allowed: false, decision: "deny" };
    }
    if (policy.visibility === "public") {
      return { allowed: true, decision: "allow" };
    }
    if (!args.userId) {
      return { allowed: false, decision: "authenticate" };
    }
    if (args.userId === policy.site.userId) {
      return { allowed: true, decision: "allow" };
    }
    if (policy.artifactId) {
      const [share] = await get(db$)
        .select({ userId: artifactShares.userId })
        .from(artifactShares)
        .where(
          and(
            eq(artifactShares.artifactId, policy.artifactId),
            eq(artifactShares.orgId, policy.site.orgId),
            eq(artifactShares.userId, args.userId),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (share) {
        return { allowed: true, decision: "allow" };
      }
    }
    if (policy.visibility === "private") {
      return { allowed: false, decision: "deny" };
    }
    const membership = await settle(
      get(clerk$).organizations.getOrganizationMembershipList(
        { organizationId: policy.site.orgId, userId: [args.userId], limit: 1 },
        undefined,
        signal,
      ),
      signal,
    );
    if (!membership.ok) {
      if (isClerkResourceNotFound(membership.error)) {
        return { allowed: false, decision: "deny" };
      }
      throw membership.error;
    }
    return membership.value.data.some((member) => {
      return member.publicUserData?.userId === args.userId;
    })
      ? { allowed: true, decision: "allow" }
      : { allowed: false, decision: "deny" };
  },
);

function manageableSiteCondition(owner: Owner) {
  return and(
    eq(hostedSites.id, owner.siteId),
    eq(hostedSites.userId, owner.userId),
    eq(hostedSites.orgId, owner.orgId),
    // Legacy-domain publications remain public and cannot change visibility.
    eq(hostedSites.linkLayoutSegment, linkLayoutSegment(CURRENT_LINK_LAYOUT)),
    isNull(hostedSites.deletedAt),
  );
}

function publishedDeployment() {
  return and(
    eq(hostedDeployments.id, hostedSites.activeDeploymentId),
    eq(hostedDeployments.siteId, hostedSites.id),
    eq(hostedDeployments.status, "ready"),
    sql`NOT (${hostedDeployments.manifest} ? 'access')`,
  );
}

const readManageableSitePolicy$ = command(
  async ({ get }, owner: Owner, signal: AbortSignal) => {
    const database = get(db$);
    const [row] = await database
      .select({
        siteId: hostedSites.id,
        directArtifactId: hostedSiteDirectArtifact.id,
        directVisibility: hostedSiteDirectArtifact.visibility,
        directXmin: sql`"hosted_site_direct_artifact"."xmin"::text`.mapWith(
          nullableDriverValueDecoder(pgTextDecoder),
        ),
        presentationArtifactId: hostedSitePresentationArtifact.id,
        presentationVisibility: hostedSitePresentationArtifact.visibility,
        presentationXmin:
          sql`"hosted_site_presentation_artifact"."xmin"::text`.mapWith(
            nullableDriverValueDecoder(pgTextDecoder),
          ),
      })
      .from(hostedSites)
      .leftJoin(
        presentationArtifacts,
        eq(presentationArtifacts.hostedSiteId, hostedSites.id),
      )
      .leftJoin(
        hostedSiteDirectArtifact,
        hostedSiteDirectArtifactJoin({ activeOnly: true }),
      )
      .leftJoin(
        hostedSitePresentationArtifact,
        hostedSitePresentationArtifactJoin({ activeOnly: true }),
      )
      .where(
        and(
          manageableSiteCondition(owner),
          owner.preparing
            ? undefined
            : exists(
                database
                  .select({ id: hostedDeployments.id })
                  .from(hostedDeployments)
                  .where(publishedDeployment()),
              ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!row) {
      return null;
    }
    const artifactId = row.directArtifactId ?? row.presentationArtifactId;
    const visibility = row.directArtifactId
      ? row.directVisibility
      : row.presentationVisibility;
    const xmin = row.directArtifactId ? row.directXmin : row.presentationXmin;
    if (artifactId && visibility && xmin) {
      return {
        siteId: row.siteId,
        artifactId,
        visibility,
        revision: sitePolicyRevision(row.siteId, artifactId, visibility, xmin),
        rawXmin: xmin,
      };
    }
    if (owner.preparing) {
      const [deployment] = await database
        .select({
          id: hostedDeployments.id,
          manifest: hostedDeployments.manifest,
          xmin: sql`"hosted_deployments"."xmin"::text`.mapWith(pgTextDecoder),
        })
        .from(hostedDeployments)
        .where(
          and(
            eq(hostedDeployments.siteId, owner.siteId),
            sql`${hostedDeployments.manifest} ? 'visibility'`,
          ),
        )
        .orderBy(desc(hostedDeployments.createdAt))
        .limit(1);
      signal.throwIfAborted();
      const prepared = deployment?.manifest.visibility;
      if (deployment && prepared) {
        return {
          siteId: row.siteId,
          artifactId: null,
          visibility: prepared,
          revision: sitePolicyRevision(
            row.siteId,
            deployment.id,
            prepared,
            deployment.xmin,
          ),
          rawXmin: deployment.xmin,
        };
      }
    }
    return {
      siteId: row.siteId,
      artifactId: null,
      visibility: "public" as const,
      revision: null,
      rawXmin: null,
    };
  },
);

export const getHostedSiteVisibility$ = command(
  async ({ set }, owner: Owner, signal: AbortSignal) => {
    const policy = await set(readManageableSitePolicy$, owner, signal);
    if (!policy) {
      return null;
    }
    return {
      siteId: policy.siteId,
      visibility: policy.visibility,
      revision: policy.revision,
    };
  },
);

export const updateHostedSiteVisibility$ = command(
  async (
    { set },
    args: Owner & {
      readonly visibility: zInfer<typeof hostedSiteVisibilitySchema>;
      readonly expectedRevision: string | null;
    },
    signal: AbortSignal,
  ) => {
    const current = await set(readManageableSitePolicy$, args, signal);
    if (!current) {
      return { status: "not_found" as const };
    }
    if (current.revision !== args.expectedRevision) {
      return { status: "conflict" as const };
    }
    if (!current.artifactId) {
      return { status: "not_found" as const };
    }
    const database = set(writeDb$);
    const [changed] = await database
      .update(artifacts)
      .set({
        visibility: args.visibility,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(artifacts.id, current.artifactId),
          isNull(artifacts.deletedAt),
          current.rawXmin !== null
            ? sql`"artifacts"."xmin"::text = ${current.rawXmin}`
            : undefined,
        ),
      )
      .returning({
        id: artifacts.id,
        visibility: artifacts.visibility,
        xmin: sql`"artifacts"."xmin"::text`.mapWith(pgTextDecoder),
      });
    signal.throwIfAborted();
    if (!changed) {
      return { status: "conflict" as const };
    }
    return {
      status: "ok" as const,
      body: {
        siteId: args.siteId,
        visibility: changed.visibility,
        revision: sitePolicyRevision(
          args.siteId,
          changed.id,
          changed.visibility,
          changed.xmin,
        ),
      },
    };
  },
);

export const prepareHostedSiteVisibility$ = command(
  async (
    { set },
    args: Owner & {
      readonly deploymentId?: string;
      readonly visibility?: HostedSiteVisibility;
      readonly unpublished: boolean;
    },
    signal: AbortSignal,
  ) => {
    const owner = { ...args, preparing: true };
    const current = await set(readManageableSitePolicy$, owner, signal);
    if (!current) {
      throw new Error("Allocated hosted site is no longer available");
    }
    // Site already has an active `artifacts` row: update it directly when
    // explicit visibility is requested, or keep its existing visibility.
    if (current.artifactId) {
      if (args.visibility === undefined) {
        return { status: "ok" as const, visibility: current.visibility };
      }
      const updated = await set(
        updateHostedSiteVisibility$,
        {
          ...owner,
          visibility: args.visibility,
          expectedRevision: current.revision,
        },
        signal,
      );
      if (updated.status !== "ok") {
        return {
          status: "conflict" as const,
          message:
            "Website visibility changed; retry publishing after checking its current policy",
        };
      }
      return { status: "ok" as const, visibility: updated.body.visibility };
    }

    // Site has no active `artifacts` row yet (new site or redeploying deleted
    // site). Record the effective visibility on the uploading deployment
    // manifest so completion creates the `artifacts` row with it atomically.
    const nextVisibility: HostedSiteVisibility =
      args.visibility ??
      (current.revision !== null
        ? current.visibility
        : args.unpublished
          ? "private"
          : current.visibility);

    if (args.deploymentId) {
      await set(writeDb$)
        .update(hostedDeployments)
        .set({
          manifest: sql`jsonb_set(${hostedDeployments.manifest}, '{visibility}', to_jsonb(${nextVisibility}::text), true)`,
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(hostedDeployments.id, args.deploymentId),
            eq(hostedDeployments.siteId, args.siteId),
          ),
        );
      signal.throwIfAborted();
    }
    return { status: "ok" as const, visibility: nextVisibility };
  },
);
