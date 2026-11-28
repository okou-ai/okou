import { availableForSite$ } from "./hosted-site-url-availability.service";
import { selectedHostedCustomUrl$ } from "./hosted-site-domains.service";
import { command } from "ccstate";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { infer as zInfer } from "zod";
import { hostedSiteUrlSchema } from "@okouai/api-contracts/contracts/host";
import {
  CURRENT_LINK_LAYOUT,
  linkLayoutFromSegment,
  linkLayoutSegment,
  type LinkLayoutSegment,
} from "@okouai/api-contracts/contracts/link-layout";
import { artifacts } from "@okouai/db/schema/artifact";
import { hostedSites, hostedDeployments } from "@okouai/db/runtime/hosted-site";
import { db$, writeDb$ } from "../external/db";
import { hostedLinkOrigin } from "../../lib/link-layout";
import { isUniqueViolation } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import type { HostedSitePointer } from "../../lib/hosted-site-pointer";
import { settle } from "../utils";
import { artifactPaywallApplies$ } from "./artifact-paywall.service";

const IMMUTABLE_DEPLOYMENT_HOST_PATTERN =
  /^dpl-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;

type Site = typeof hostedSites.$inferSelect;
interface Owner {
  readonly orgId: string;
  readonly userId: string;
}
export type HostedSiteUrlResult =
  | {
      readonly status: "ok";
      readonly body: zInfer<typeof hostedSiteUrlSchema>;
    }
  | { readonly status: "not_found"; readonly message: string }
  | { readonly status: "conflict"; readonly message: string }
  | { readonly status: "pro_required" };

function ownedSiteCondition(owner: Owner) {
  return and(
    eq(hostedSites.orgId, owner.orgId),
    eq(hostedSites.userId, owner.userId),
    isNull(hostedSites.deletedAt),
    isNotNull(hostedSites.activeDeploymentId),
  );
}

function siteUrl(
  site: Site,
  isActive = true,
  artifactId?: string,
): zInfer<typeof hostedSiteUrlSchema> {
  return {
    siteId: site.id,
    publicSlug: site.publicSlug,
    url: hostedLinkOrigin(
      linkLayoutFromSegment(site.linkLayoutSegment),
      site.publicSlug,
    ),
    isActive,
    ...(artifactId ? { artifactId } : {}),
  };
}

const activeSiteArtifactId$ = command(
  async (
    { get },
    args: { readonly siteId: string; readonly orgId: string },
    signal: AbortSignal,
  ): Promise<string | undefined> => {
    const [row] = await get(db$)
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.orgId, args.orgId),
          eq(artifacts.logicalKey, `site:${args.siteId}`),
          isNull(artifacts.deletedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return row?.id;
  },
);

const ownedSite$ = command(
  async (
    { get },
    args: Owner & { readonly siteId: string },
    signal: AbortSignal,
  ) => {
    const [row] = await get(db$)
      .select({ site: hostedSites })
      .from(hostedSites)
      .innerJoin(
        hostedDeployments,
        and(
          eq(hostedDeployments.id, hostedSites.activeDeploymentId),
          eq(hostedDeployments.siteId, hostedSites.id),
        ),
      )
      .where(
        and(
          ownedSiteCondition(args),
          eq(hostedSites.id, args.siteId),
          eq(
            hostedSites.linkLayoutSegment,
            linkLayoutSegment(CURRENT_LINK_LAYOUT),
          ),
          eq(hostedDeployments.status, "ready"),
          isNull(sql`${hostedDeployments.manifest}->>'access'`),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return row?.site;
  },
);

export const getHostedSiteUrl$ = command(
  async (
    { get, set },
    args: Owner & { readonly publicSlug: string; readonly hostname?: string },
    signal: AbortSignal,
  ): Promise<HostedSiteUrlResult> => {
    const deploymentId = IMMUTABLE_DEPLOYMENT_HOST_PATTERN.exec(
      args.publicSlug,
    )?.[1];
    const [row] = await get(db$)
      .select({ site: hostedSites, deploymentId: hostedDeployments.id })
      .from(hostedSites)
      .innerJoin(
        hostedDeployments,
        eq(hostedDeployments.siteId, hostedSites.id),
      )
      .where(
        and(
          ownedSiteCondition(args),
          eq(hostedDeployments.status, "ready"),
          isNull(sql`${hostedDeployments.manifest}->>'access'`),
          deploymentId
            ? eq(hostedDeployments.id, deploymentId)
            : and(
                eq(hostedSites.publicSlug, args.publicSlug),
                eq(hostedDeployments.id, hostedSites.activeDeploymentId),
              ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (
      !row ||
      (args.hostname !== undefined &&
        new URL(
          hostedLinkOrigin(
            linkLayoutFromSegment(row.site.linkLayoutSegment),
            args.publicSlug,
          ),
        ).hostname !== args.hostname.toLowerCase())
    ) {
      return { status: "not_found", message: "Published website not found" };
    }
    const [effectiveUrl, artifactId] = await Promise.all([
      set(selectedHostedCustomUrl$, row.site.id, signal),
      set(
        activeSiteArtifactId$,
        { siteId: row.site.id, orgId: args.orgId },
        signal,
      ),
    ]);
    signal.throwIfAborted();
    return {
      status: "ok",
      body: {
        ...siteUrl(
          row.site,
          row.deploymentId === row.site.activeDeploymentId,
          artifactId,
        ),
        ...(effectiveUrl ? { effectiveUrl } : {}),
      },
    };
  },
);

export const checkHostedSiteUrl$ = command(
  async (
    { set },
    args: Owner & { readonly siteId: string; readonly publicSlug: string },
    signal: AbortSignal,
  ) => {
    const site = await set(ownedSite$, args, signal);
    if (!site) {
      return null;
    }
    return {
      available: await set(availableForSite$, site, args.publicSlug, signal),
    };
  },
);

export const updateHostedSiteUrl$ = command(
  async (
    { set },
    args: Owner & {
      readonly siteId: string;
      readonly publicSlug: string;
      readonly expectedPublicSlug: string;
    },
    signal: AbortSignal,
  ): Promise<HostedSiteUrlResult> => {
    const site = await set(ownedSite$, args, signal);
    if (!site) {
      return { status: "not_found", message: "Published website not found" };
    }
    if (site.publicSlug === args.publicSlug) {
      const artifactId = await set(
        activeSiteArtifactId$,
        { siteId: site.id, orgId: args.orgId },
        signal,
      );
      return { status: "ok", body: siteUrl(site, true, artifactId) };
    }
    if (await set(artifactPaywallApplies$, args, signal)) {
      return { status: "pro_required" };
    }
    if (site.publicSlug !== args.expectedPublicSlug) {
      return {
        status: "conflict",
        message: "The website URL changed. Reload it and try again.",
      };
    }
    if (!(await set(availableForSite$, site, args.publicSlug, signal))) {
      return {
        status: "conflict",
        message: "This website address is already taken",
      };
    }
    signal.throwIfAborted();
    // One conditional write selects the winner. Delivery resolves the live name
    // from SQL, so renaming needs no remote publication or compensating writes.
    const result = await settle(
      set(writeDb$)
        .update(hostedSites)
        .set({ publicSlug: args.publicSlug, updatedAt: nowDate() })
        .where(
          and(
            ownedSiteCondition(args),
            eq(hostedSites.id, args.siteId),
            eq(hostedSites.publicSlug, args.expectedPublicSlug),
          ),
        )
        .returning(),
    );
    signal.throwIfAborted();
    if (!result.ok) {
      if (isUniqueViolation(result.error, "idx_hosted_sites_public_slug")) {
        return {
          status: "conflict",
          message: "This website address is already taken",
        };
      }
      throw result.error;
    }
    const updated = result.value[0];
    if (!updated) {
      return {
        status: "conflict",
        message: "The website changed. Reload it and try again.",
      };
    }
    const artifactId = await set(
      activeSiteArtifactId$,
      { siteId: updated.id, orgId: args.orgId },
      signal,
    );
    return { status: "ok", body: siteUrl(updated, true, artifactId) };
  },
);

/** Current names are routing data; immutable manifests keep their original name. */
export const resolveHostedSiteAlias$ = command(
  async (
    { get },
    args: {
      readonly publicSlug: string;
      readonly publicBrand: LinkLayoutSegment;
    },
    signal: AbortSignal,
  ): Promise<HostedSitePointer | null> => {
    const [row] = await get(db$)
      .select({ site: hostedSites, deployment: hostedDeployments })
      .from(hostedSites)
      .innerJoin(
        hostedDeployments,
        and(
          eq(hostedDeployments.id, hostedSites.activeDeploymentId),
          eq(hostedDeployments.siteId, hostedSites.id),
        ),
      )
      .where(
        and(
          eq(hostedSites.publicSlug, args.publicSlug),
          eq(hostedSites.linkLayoutSegment, args.publicBrand),
          eq(hostedDeployments.status, "ready"),
          isNull(hostedSites.deletedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!row) {
      return null;
    }
    const { deployment, site } = row;
    if (
      deployment.manifest.access ||
      deployment.manifest.siteId !== site.id ||
      deployment.manifest.deploymentId !== deployment.id ||
      deployment.orgId !== site.orgId ||
      deployment.linkLayoutSegment !== args.publicBrand
    ) {
      throw new Error("Hosted site has an invalid public deployment binding");
    }
    return {
      version: 1,
      publicBrand: args.publicBrand,
      publicSlug: deployment.manifest.publicSlug,
      siteId: site.id,
      deploymentId: deployment.id,
      prefix: deployment.r2Prefix,
      manifestKey: `${deployment.r2Prefix}/manifest.json`,
      spaFallback: deployment.spaFallback,
      updatedAt: deployment.updatedAt.toISOString(),
    };
  },
);
