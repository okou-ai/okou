import { randomBytes } from "node:crypto";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import {
  hostedDeployments,
  privateHostedDeployments,
} from "@okouai/db/runtime/hosted-site";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { hostedSiteDownloadGrantSchema } from "@okouai/api-contracts/contracts/hosted-site-access";
import type { HostedSiteManifest } from "@okouai/db/jsonb-contracts/hosted-site";
import { linkLayoutFromSegment } from "@okouai/api-contracts/contracts/link-layout";
import { env } from "../../lib/env";
import { hostedLinkOrigin } from "../../lib/link-layout";
import { nowDate } from "../../lib/time";
import {
  isS3NotFoundError,
  putHostedSitesS3Object,
  readArtifactSharePolicyObject,
} from "../external/s3";
import { settle } from "../utils";
import { db$ } from "../external/db";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";
import {
  checkHostedSiteAccess$,
  readHostedSitePolicy$,
} from "./hosted-site-access.service";

const DOWNLOAD_LIFETIME_MS = 5 * 60 * 1000;

function bucket() {
  const value = env("R2_HOSTED_SITES_BUCKET_NAME");
  if (!value) {
    throw new Error("Hosted site download storage is not configured");
  }
  return value;
}

/** Issue only after the caller has authorized the exact publication or snapshot. */
export const createHostedSiteDownloadGrant$ = command(
  async (
    { get, set },
    args: {
      readonly manifest: HostedSiteManifest;
      readonly prefix: string;
      readonly viewerId?: string;
    },
    signal: AbortSignal,
  ) => {
    const policy = await set(
      readHostedSitePolicy$,
      args.manifest.siteId,
      signal,
    );
    if (!policy) {
      throw new Error("Hosted site is no longer available");
    }
    // Preserve GA direct-storage downloads until #41704 activates the deployed
    // reader and closes the old API rollback window. An explicit policy keeps
    // controlled delivery active even after the management flag is disabled.
    if (policy.revision === null) {
      if (
        env("HOSTED_SITE_ACCESS_ENABLED") !== "true" ||
        !env("HOSTED_SITE_VISIBILITY_SITE_IDS").includes(args.manifest.siteId)
      ) {
        return null;
      }
      const features = await set(
        loadUserFeatureSwitchContext$,
        policy.site.orgId,
        policy.site.userId,
        signal,
      );
      if (!isFeatureEnabled(FeatureSwitchKey.HostedSiteVisibility, features)) {
        return null;
      }
    }
    const access = await set(
      checkHostedSiteAccess$,
      { siteId: args.manifest.siteId, userId: args.viewerId },
      signal,
    );
    if (!access.allowed) {
      throw new Error("Hosted site download is no longer authorized");
    }
    const token = randomBytes(24).toString("hex");
    const grant = hostedSiteDownloadGrantSchema.parse({
      version: 1,
      siteId: args.manifest.siteId,
      deploymentId: args.manifest.deploymentId,
      viewerId: args.viewerId ?? null,
      revision: policy.revision,
      expiresAt: new Date(
        nowDate().getTime() + DOWNLOAD_LIFETIME_MS,
      ).toISOString(),
      prefix: args.prefix,
      files: args.manifest.files,
    });
    await get(
      putHostedSitesS3Object(
        bucket(),
        `site-downloads/${token}.json`,
        JSON.stringify(grant),
        "application/json",
        signal,
      ),
    );
    signal.throwIfAborted();
    return new URL(
      `/.okou/download/${token}`,
      hostedLinkOrigin(
        linkLayoutFromSegment(args.manifest.publicBrand ?? "vm0"),
        `dpl-${args.manifest.deploymentId}`,
      ),
    ).href;
  },
);

export const authorizeHostedSiteDownload$ = command(
  async (
    { get, set },
    args: {
      readonly token: string;
      readonly deploymentId: string;
      readonly path: string;
    },
    signal: AbortSignal,
  ) => {
    const stored = await settle(
      get(
        readArtifactSharePolicyObject(
          bucket(),
          `site-downloads/${args.token}.json`,
          signal,
        ),
      ),
      signal,
    );
    if (!stored.ok) {
      if (isS3NotFoundError(stored.error)) {
        return { file: null };
      }
      throw stored.error;
    }
    const grant = hostedSiteDownloadGrantSchema.parse(
      JSON.parse(stored.value.buffer.toString("utf8")),
    );
    if (
      grant.deploymentId !== args.deploymentId ||
      Date.parse(grant.expiresAt) <= nowDate().getTime()
    ) {
      return { file: null };
    }
    const file = grant.files[args.path];
    if (
      !file ||
      args.path.split("/").some((part) => {
        return part === "." || part === "..";
      })
    ) {
      return { file: null };
    }
    // Site deletion retires deployments while retaining the Site for redeploy.
    // Copied thread/share snapshots keep their separate snapshot authority.
    if (!grant.prefix.startsWith("shared-artifacts/")) {
      const database = get(db$);
      const [deployment] = await database
        .select({ id: hostedDeployments.id })
        .from(hostedDeployments)
        .where(
          and(
            eq(hostedDeployments.id, grant.deploymentId),
            eq(hostedDeployments.siteId, grant.siteId),
            eq(hostedDeployments.status, "ready"),
          ),
        )
        .unionAll(
          database
            .select({ id: privateHostedDeployments.id })
            .from(privateHostedDeployments)
            .where(
              and(
                eq(privateHostedDeployments.id, grant.deploymentId),
                eq(privateHostedDeployments.siteId, grant.siteId),
                eq(privateHostedDeployments.status, "ready"),
              ),
            ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (!deployment) {
        return { file: null };
      }
    }
    const policy = await set(readHostedSitePolicy$, grant.siteId, signal);
    if (!policy || policy.revision !== grant.revision) {
      return { file: null };
    }
    const access = await set(
      checkHostedSiteAccess$,
      { siteId: grant.siteId, userId: grant.viewerId ?? undefined },
      signal,
    );
    if (!access.allowed || Date.parse(grant.expiresAt) <= nowDate().getTime()) {
      return { file: null };
    }
    return {
      file: {
        key: `${grant.prefix}${args.path}`,
        contentType: file.contentType,
        size: file.size,
      },
    };
  },
);
