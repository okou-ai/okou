import { randomBytes } from "node:crypto";
import { command } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import {
  privateHostedDeployments,
  hostedSites,
} from "@okouai/db/schema/hosted-site";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { PRIVATE_ARTIFACT_PREVIEW_TTL_SECONDS } from "../../lib/private-artifact-preview";
import { db$ } from "../external/db";
import { putHostedSitesS3Object } from "../external/s3";

/** An isolated, temporary origin authorizes every resource without cookies. */
export const createPrivateHostedPreview$ = command(
  async (
    { get },
    args: {
      readonly deploymentId: string;
      readonly userId: string;
      readonly orgId: string;
      readonly snapshotId?: string;
    },
    signal: AbortSignal,
  ) => {
    const [row] = await get(db$)
      .select({ deployment: privateHostedDeployments })
      .from(privateHostedDeployments)
      .innerJoin(
        hostedSites,
        eq(hostedSites.id, privateHostedDeployments.siteId),
      )
      .where(
        and(
          eq(privateHostedDeployments.id, args.deploymentId),
          eq(privateHostedDeployments.userId, args.userId),
          eq(privateHostedDeployments.orgId, args.orgId),
          eq(privateHostedDeployments.status, "ready"),
          isNull(hostedSites.deletedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!row) {
      return null;
    }
    const { deployment } = row;
    if (deployment.manifest.access !== "owner-private-v1") {
      throw new Error("Private hosted deployment has an invalid access policy");
    }
    const bucket = env("R2_HOSTED_SITES_BUCKET_NAME");
    if (
      !bucket ||
      !env("R2_HOSTED_SITES_ACCESS_KEY_ID") ||
      !env("R2_HOSTED_SITES_SECRET_ACCESS_KEY")
    ) {
      throw new Error("Private hosted preview storage is not configured");
    }
    const hostDomain =
      deployment.publicBrand === "okou"
        ? env("OKOU_PUBLIC_HOST_DOMAIN")
        : env("ZERO_HOST_DOMAIN");
    const scheme =
      deployment.publicBrand === "okou"
        ? env("OKOU_HOST_SCHEME")
        : env("ZERO_HOST_SCHEME");
    const token = randomBytes(24).toString("hex");
    const expiresAt = new Date(
      nowDate().getTime() + PRIVATE_ARTIFACT_PREVIEW_TTL_SECONDS * 1000,
    ).toISOString();
    const url = new URL(
      `${scheme}://${args.snapshotId ? "ps" : "pv"}-${token}.${hostDomain}/`,
    );
    await get(
      putHostedSitesS3Object(
        bucket,
        `${args.snapshotId ? "shared-previews" : "private-previews"}/${deployment.publicBrand}/${token}.json`,
        JSON.stringify({
          version: 1,
          publicBrand: deployment.publicBrand,
          deploymentId: deployment.id,
          ...(args.snapshotId ? { snapshotId: args.snapshotId } : {}),
          expiresAt,
        }),
        "application/json",
      ),
    );
    signal.throwIfAborted();
    return { url: url.href, expiresAt };
  },
);
