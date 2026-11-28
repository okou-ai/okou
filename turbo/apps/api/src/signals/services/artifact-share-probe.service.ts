import { command } from "ccstate";
import {
  artifactSharePolicySchema,
  type ArtifactSharePolicy,
} from "@okouai/api-contracts/contracts/artifact-shares";
import {
  CURRENT_LINK_LAYOUT,
  linkLayoutSegment,
  type LinkLayout,
} from "@okouai/api-contracts/contracts/link-layout";
import { uuid } from "zod";
import { env } from "../../lib/env";
import {
  isS3NotFoundError,
  readArtifactSharePolicyObject,
} from "../external/s3";
import { settle } from "../utils";

const LEGACY_SHARE_LAYOUTS: readonly LinkLayout[] = [
  CURRENT_LINK_LAYOUT,
  "legacy",
];

function sharePolicyBucket(): string {
  const bucket = env("R2_HOSTED_SITES_BUCKET_NAME");
  if (!bucket) {
    throw new Error("Artifact sharing storage is not configured");
  }
  return bucket;
}

/**
 * Read-only R2 probe for historical `/share/artifacts/:shareId` policies.
 * Queries zero database rows on the retired `artifact_shares` table so legacy
 * external links stay functional while `artifact_shares` reaches 0 reads / 0 writes.
 */
export const probeLegacyArtifactSharePolicy$ = command(
  async (
    { get },
    args: { readonly shareId: string; readonly layout?: LinkLayout },
    signal: AbortSignal,
  ): Promise<ArtifactSharePolicy | null> => {
    if (!uuid().safeParse(args.shareId).success) {
      return null;
    }
    const bucket = env("R2_HOSTED_SITES_BUCKET_NAME");
    if (!bucket) {
      return null;
    }
    const layouts =
      args.layout !== undefined ? [args.layout] : LEGACY_SHARE_LAYOUTS;
    for (const layout of layouts) {
      const segment = linkLayoutSegment(layout);
      const key = `artifact-shares/${segment}/${args.shareId}.json`;
      const downloaded = await settle(
        get(readArtifactSharePolicyObject(sharePolicyBucket(), key, signal)),
        signal,
      );
      if (!downloaded.ok) {
        if (isS3NotFoundError(downloaded.error)) {
          continue;
        }
        throw downloaded.error;
      }
      const policy = artifactSharePolicySchema.parse(
        JSON.parse(downloaded.value.buffer.toString("utf8")),
      );
      if (policy.shareId !== args.shareId || policy.publicBrand !== segment) {
        throw new Error("Artifact share policy does not match its identity");
      }
      return policy;
    }
    return null;
  },
);
