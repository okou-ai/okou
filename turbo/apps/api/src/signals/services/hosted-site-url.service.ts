import { command } from "ccstate";
import { and, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { z } from "zod";
import { hostedSiteUrlSchema } from "@okouai/api-contracts/contracts/host";
import {
  artifactDeliveryKey,
  artifactDeliveryRecordSchema,
} from "@okouai/api-contracts/contracts/artifact-delivery";
import {
  hostedSitePointerNamespace,
  linkLayoutFromSegment,
  type LinkLayoutSegment,
} from "@okouai/api-contracts/contracts/link-layout";
import { hostedSites, hostedDeployments } from "@okouai/db/runtime/hosted-site";
import { db$, writeDb$ } from "../external/db";
import { env } from "../../lib/env";
import { hostedLinkOrigin } from "../../lib/link-layout";
import { isUniqueViolation } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { hostedSiteAddressCondition } from "../../lib/hosted-site-address";
import {
  hostedSitePointerSchema,
  type HostedSitePointer,
} from "../../lib/hosted-site-pointer";
import { storedObject } from "./hosted-site-publication-migration.service";
import { settle } from "../utils";

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
      readonly body: z.infer<typeof hostedSiteUrlSchema>;
    }
  | { readonly status: "not_found"; readonly message: string }
  | { readonly status: "conflict"; readonly message: string };

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
): z.infer<typeof hostedSiteUrlSchema> {
  return {
    siteId: site.id,
    publicSlug: site.publicSlug,
    url: hostedLinkOrigin(
      linkLayoutFromSegment(site.linkLayoutSegment),
      site.publicSlug,
    ),
    isActive,
  };
}

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
    { get },
    args: Owner & { readonly publicSlug: string; readonly hostname: string },
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
      new URL(
        hostedLinkOrigin(
          linkLayoutFromSegment(row.site.linkLayoutSegment),
          args.publicSlug,
        ),
      ).hostname !== args.hostname.toLowerCase()
    ) {
      return { status: "not_found", message: "Published website not found" };
    }
    return {
      status: "ok",
      body: siteUrl(row.site, row.deploymentId === row.site.activeDeploymentId),
    };
  },
);

const availableForSite$ = command(
  async ({ get }, site: Site, publicSlug: string, signal: AbortSignal) => {
    if (site.publicSlug === publicSlug) {
      return true;
    }
    const [occupied] = await get(db$)
      .select({ id: hostedSites.id })
      .from(hostedSites)
      .where(
        and(
          hostedSiteAddressCondition(publicSlug),
          ne(hostedSites.id, site.id),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (occupied) {
      return false;
    }
    const bucket = env("R2_HOSTED_SITES_BUCKET_NAME");
    if (!bucket) {
      throw new Error("Hosted site storage is not configured");
    }
    const layout = linkLayoutFromSegment(site.linkLayoutSegment);
    const [record, pointer] = await Promise.all([
      get(
        storedObject(
          bucket,
          artifactDeliveryKey(site.linkLayoutSegment, "html", publicSlug),
          signal,
        ),
      ),
      get(
        storedObject(
          bucket,
          `${hostedSitePointerNamespace(layout)}/${publicSlug}/active.json`,
          signal,
        ),
      ),
    ]);
    signal.throwIfAborted();
    if (
      record &&
      artifactDeliveryRecordSchema.parse(
        JSON.parse(record.buffer.toString("utf8")),
      ).kind !== "legacy-site"
    ) {
      return false;
    }
    // Historical publication names remain owned by their original site.
    return pointer
      ? hostedSitePointerSchema.parse(
          JSON.parse(pointer.buffer.toString("utf8")),
        ).siteId === site.id
      : record === null;
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
      return { status: "ok", body: siteUrl(site) };
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
    return updated
      ? { status: "ok", body: siteUrl(updated) }
      : {
          status: "conflict",
          message: "The website changed. Reload it and try again.",
        };
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
