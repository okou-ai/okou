import { randomUUID } from "node:crypto";
import { command } from "ccstate";
import { and, eq, exists, isNull, sql } from "drizzle-orm";
import { hostedSites, hostedDeployments } from "@okouai/db/runtime/hosted-site";
import { artifacts } from "@okouai/db/schema/artifact";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { db$, writeDb$ } from "../external/db";
import { hostedLinkOrigin } from "../../lib/link-layout";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";

type Owner = {
  readonly siteId: string;
  readonly userId: string;
  readonly orgId: string;
};

function ownedSite(owner: Owner) {
  return and(
    eq(hostedSites.id, owner.siteId),
    eq(hostedSites.userId, owner.userId),
    eq(hostedSites.orgId, owner.orgId),
    eq(hostedSites.linkLayoutSegment, "okou"),
    isNull(hostedSites.deletedAt),
  );
}

export const getHostedSiteBanner$ = command(
  async ({ get }, owner: Owner, signal: AbortSignal) => {
    const database = get(db$);
    const [site] = await database
      .select({
        siteId: hostedSites.id,
        showBanner: hostedSites.showBanner,
        revision: hostedSites.bannerRevision,
      })
      .from(hostedSites)
      .where(
        and(
          ownedSite(owner),
          exists(
            database
              .select({ id: hostedDeployments.id })
              .from(hostedDeployments)
              .where(
                and(
                  eq(hostedDeployments.id, hostedSites.activeDeploymentId),
                  eq(hostedDeployments.siteId, hostedSites.id),
                  eq(hostedDeployments.status, "ready"),
                  sql`NOT (${hostedDeployments.manifest} ? 'access')`,
                ),
              ),
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return site ?? null;
  },
);

export const updateHostedSiteBanner$ = command(
  async (
    { set },
    args: Owner & {
      readonly showBanner: boolean;
      readonly expectedRevision: string | null;
    },
    signal: AbortSignal,
  ) => {
    const current = await set(getHostedSiteBanner$, args, signal);
    if (!current) {
      return { status: "not_found" as const };
    }
    const [updated] = await set(writeDb$)
      .update(hostedSites)
      .set({ showBanner: args.showBanner, bannerRevision: randomUUID() })
      .where(
        and(
          ownedSite(args),
          args.expectedRevision === null
            ? isNull(hostedSites.bannerRevision)
            : eq(hostedSites.bannerRevision, args.expectedRevision),
        ),
      )
      .returning({
        siteId: hostedSites.id,
        showBanner: hostedSites.showBanner,
        revision: hostedSites.bannerRevision,
      });
    signal.throwIfAborted();
    return updated
      ? { status: "ok" as const, body: updated }
      : { status: "conflict" as const };
  },
);

/** Call only after delivery authority and the current viewer have been checked. */
export const hostedSitePresentation$ = command(
  async ({ get, set }, siteId: string, signal: AbortSignal) => {
    const [site] = await get(db$)
      .select({
        userId: hostedSites.userId,
        orgId: hostedSites.orgId,
        publicSlug: hostedSites.publicSlug,
        slug: hostedSites.slug,
        showBanner: hostedSites.showBanner,
        title: artifacts.title,
      })
      .from(hostedSites)
      .leftJoin(
        artifacts,
        and(
          eq(artifacts.logicalKey, sql`'site:' || ${hostedSites.id}::text`),
          eq(artifacts.orgId, hostedSites.orgId),
          eq(artifacts.authorUserId, hostedSites.userId),
        ),
      )
      .where(
        and(
          eq(hostedSites.id, siteId),
          eq(hostedSites.linkLayoutSegment, "okou"),
          isNull(hostedSites.deletedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!site) {
      return undefined;
    }
    const features = await set(
      loadUserFeatureSwitchContext$,
      site.orgId,
      site.userId,
      signal,
    );
    if (!isFeatureEnabled(FeatureSwitchKey.HostedSiteVisibility, features)) {
      return undefined;
    }
    return {
      showBanner: site.showBanner,
      title: site.title ?? site.slug,
      siteUrl: `${hostedLinkOrigin("current", site.publicSlug)}/`,
    };
  },
);
