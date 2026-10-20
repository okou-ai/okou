import { randomUUID } from "node:crypto";
import { command } from "ccstate";
import { and, eq, exists, isNull, sql } from "drizzle-orm";
import type { z } from "zod";
import type {
  HostedSiteAccessDecision,
  hostedSiteVisibilitySchema,
} from "@okouai/api-contracts/contracts/hosted-site-access";
import { hostedSites, hostedDeployments } from "@okouai/db/runtime/hosted-site";
import { hostedSiteVisibility } from "@okouai/db/schema/hosted-site-visibility";
import { db$, writeDb$ } from "../external/db";
import { clerk$, isClerkResourceNotFound } from "../external/clerk";
import { settle } from "../utils";

type Owner = {
  readonly userId: string;
  readonly orgId: string;
  readonly siteId: string;
};

export const readHostedSitePolicy$ = command(
  async ({ get }, siteId: string, signal: AbortSignal) => {
    const [row] = await get(db$)
      .select({ site: hostedSites, policy: hostedSiteVisibility })
      .from(hostedSites)
      .leftJoin(
        hostedSiteVisibility,
        eq(hostedSiteVisibility.siteId, hostedSites.id),
      )
      .where(and(eq(hostedSites.id, siteId), isNull(hostedSites.deletedAt)))
      .limit(1);
    signal.throwIfAborted();
    if (!row) {
      return null;
    }
    return {
      site: row.site,
      visibility: row.policy?.visibility ?? "public",
      revision: row.policy?.revision ?? null,
    };
  },
);

/** A Site override only narrows an existing publication or preview grant. */
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

function ownedSite(owner: Owner) {
  return and(
    eq(hostedSites.id, owner.siteId),
    eq(hostedSites.userId, owner.userId),
    eq(hostedSites.orgId, owner.orgId),
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

export const getHostedSiteVisibility$ = command(
  async ({ get }, owner: Owner, signal: AbortSignal) => {
    const [row] = await get(db$)
      .select({ siteId: hostedSites.id, policy: hostedSiteVisibility })
      .from(hostedSites)
      .leftJoin(
        hostedSiteVisibility,
        eq(hostedSiteVisibility.siteId, hostedSites.id),
      )
      .where(
        and(
          ownedSite(owner),
          exists(
            get(db$)
              .select({ id: hostedDeployments.id })
              .from(hostedDeployments)
              .where(publishedDeployment()),
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return row
      ? {
          siteId: row.siteId,
          visibility: row.policy?.visibility ?? "public",
          revision: row.policy?.revision ?? null,
        }
      : null;
  },
);

export const updateHostedSiteVisibility$ = command(
  async (
    { set },
    args: Owner & {
      readonly visibility: z.infer<typeof hostedSiteVisibilitySchema>;
      readonly expectedRevision: string | null;
    },
    signal: AbortSignal,
  ) => {
    const current = await set(getHostedSiteVisibility$, args, signal);
    if (!current) {
      return { status: "not_found" as const };
    }
    if (current.revision !== args.expectedRevision) {
      return { status: "conflict" as const };
    }
    const revision = randomUUID();
    const database = set(writeDb$);
    const [changed] = await database
      .insert(hostedSiteVisibility)
      .select(
        database
          .select({
            siteId: hostedSites.id,
            visibility: sql`${args.visibility}::text`
              .mapWith(hostedSiteVisibility.visibility)
              .as("visibility"),
            revision: sql`${revision}::uuid`
              .mapWith(hostedSiteVisibility.revision)
              .as("revision"),
          })
          .from(hostedSites)
          .where(
            and(
              ownedSite(args),
              exists(
                database
                  .select({ id: hostedDeployments.id })
                  .from(hostedDeployments)
                  .where(publishedDeployment()),
              ),
              args.expectedRevision === null
                ? undefined
                : exists(
                    database
                      .select({ siteId: hostedSiteVisibility.siteId })
                      .from(hostedSiteVisibility)
                      .where(
                        and(
                          eq(hostedSiteVisibility.siteId, args.siteId),
                          eq(
                            hostedSiteVisibility.revision,
                            args.expectedRevision,
                          ),
                        ),
                      ),
                  ),
            ),
          ),
      )
      .onConflictDoUpdate({
        target: hostedSiteVisibility.siteId,
        set: { visibility: args.visibility, revision },
        setWhere:
          args.expectedRevision === null
            ? sql`false`
            : eq(hostedSiteVisibility.revision, args.expectedRevision),
      })
      .returning();
    signal.throwIfAborted();
    return changed
      ? { status: "ok" as const, body: changed }
      : { status: "conflict" as const };
  },
);
