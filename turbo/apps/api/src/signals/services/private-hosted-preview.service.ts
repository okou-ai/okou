import { randomBytes } from "node:crypto";
import { command } from "ccstate";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { PRIVATE_ARTIFACT_PREVIEW_TTL_SECONDS } from "../../lib/private-artifact-preview";
import { putHostedSitesS3Object } from "../external/s3";

/**
 * Read grants for conversation snapshots published before hosted sites became
 * public. Callers authorize the snapshot before issuing its grant.
 */
export const createHostedPreviewGrant$ = command(
  async (
    { get },
    args: {
      readonly deploymentId: string;
      readonly publicBrand: PublicBrand;
      readonly snapshotId?: string;
      readonly immutableContent?: true;
    },
    signal: AbortSignal,
  ) => {
    const bucket = env("R2_HOSTED_SITES_BUCKET_NAME");
    if (
      !bucket ||
      !env("R2_HOSTED_SITES_ACCESS_KEY_ID") ||
      !env("R2_HOSTED_SITES_SECRET_ACCESS_KEY")
    ) {
      throw new Error("Private hosted preview storage is not configured");
    }
    const hostDomain =
      args.publicBrand === "okou"
        ? env("OKOU_PUBLIC_HOST_DOMAIN")
        : env("ZERO_HOST_DOMAIN");
    const scheme =
      args.publicBrand === "okou"
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
        `${args.snapshotId ? "shared-previews" : "private-previews"}/${args.publicBrand}/${token}.json`,
        JSON.stringify({
          version: 1,
          publicBrand: args.publicBrand,
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
