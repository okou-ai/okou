import { createHostedSitePreviewGrant$ } from "./hosted-site-preview-grant.service";
import { readHostedSitePolicy$ } from "./hosted-site-access.service";
import { randomBytes } from "node:crypto";
import { command } from "ccstate";
import {
  linkLayoutSegment,
  type LinkLayout,
} from "@okouai/api-contracts/contracts/link-layout";
import { env } from "../../lib/env";
import { hostedLinkOrigin } from "../../lib/link-layout";
import { nowDate } from "../../lib/time";
import { PRIVATE_ARTIFACT_PREVIEW_TTL_SECONDS } from "../../lib/private-artifact-preview";
import { putHostedSitesS3Object } from "../external/s3";

/**
 * Read grants for conversation snapshots published before hosted sites became
 * public. Callers authorize the snapshot before issuing its grant.
 */
export const createHostedPreviewGrant$ = command(
  async (
    { get, set },
    args: {
      readonly siteId: string;
      readonly deploymentId: string;
      // The previewed deployment's layout; grants live in its namespace.
      readonly layout: LinkLayout;
      readonly snapshotId?: string;
      readonly immutableContent?: true;
    },
    signal: AbortSignal,
  ) => {
    const policy = await set(readHostedSitePolicy$, args.siteId, signal);
    if (!policy) {
      throw new Error("Hosted preview Site is unavailable");
    }
    if (policy.visibility !== "public" && args.layout === "current") {
      return set(
        createHostedSitePreviewGrant$,
        {
          siteId: args.siteId,
          deploymentId: args.deploymentId,
          prefix: args.snapshotId
            ? `shared-artifacts/okou/${args.snapshotId}/${args.deploymentId}`
            : `private-sites/okou/${args.deploymentId}`,
          revision: policy.revision,
          ...(args.snapshotId || args.immutableContent
            ? { immutableContent: true as const }
            : {}),
        },
        signal,
      );
    }
    const bucket = env("R2_HOSTED_SITES_BUCKET_NAME");
    if (
      !bucket ||
      !env("R2_HOSTED_SITES_ACCESS_KEY_ID") ||
      !env("R2_HOSTED_SITES_SECRET_ACCESS_KEY")
    ) {
      throw new Error("Private hosted preview storage is not configured");
    }
    const segment = linkLayoutSegment(args.layout);
    const token = randomBytes(24).toString("hex");
    const expiresAt = new Date(
      nowDate().getTime() + PRIVATE_ARTIFACT_PREVIEW_TTL_SECONDS * 1000,
    ).toISOString();
    const url = new URL(
      `${hostedLinkOrigin(args.layout, `${args.snapshotId ? "ps" : "pv"}-${token}`)}/`,
    );
    await get(
      putHostedSitesS3Object(
        bucket,
        `${args.snapshotId ? "shared-previews" : "private-previews"}/${segment}/${token}.json`,
        JSON.stringify({
          version: 1,
          publicBrand: segment,
          deploymentId: args.deploymentId,
          ...(args.snapshotId ? { snapshotId: args.snapshotId } : {}),
          ...(args.immutableContent ? { immutableContent: true } : {}),
          expiresAt,
        }),
        "application/json",
      ),
    );
    signal.throwIfAborted();
    return { url: url.href, expiresAt };
  },
);
