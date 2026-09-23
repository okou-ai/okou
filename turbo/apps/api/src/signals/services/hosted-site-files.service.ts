import { command } from "ccstate";
import type { HostedSiteFilesResponse } from "@okouai/api-contracts/contracts/host";
import type { HostedSiteManifest } from "@okouai/db/jsonb-contracts/hosted-site";
import { env } from "../../lib/env";
import { resolveArtifactPresignedGet$ } from "./artifact-presigned-url-cache.service";

/** Call only after authorizing this exact deployment or immutable share snapshot. */
export const signHostedSiteFiles$ = command(
  async (
    { set },
    args: {
      readonly metadata: Omit<
        HostedSiteFilesResponse,
        "files" | "fileCount" | "size"
      >;
      readonly manifest: HostedSiteManifest;
      readonly prefix: string;
    },
    signal: AbortSignal,
  ): Promise<HostedSiteFilesResponse> => {
    const bucket = env("R2_HOSTED_SITES_BUCKET_NAME");
    if (
      !bucket ||
      !env("R2_HOSTED_SITES_ACCESS_KEY_ID") ||
      !env("R2_HOSTED_SITES_SECRET_ACCESS_KEY")
    ) {
      throw new Error("Hosted site download storage is not configured");
    }
    const manifestFiles = Object.values(args.manifest.files).sort((a, b) => {
      return a.path.localeCompare(b.path);
    });
    const files = await Promise.all(
      manifestFiles.map(async (file) => {
        const signed = await set(
          resolveArtifactPresignedGet$,
          { bucket, key: `${args.prefix}${file.path}`, signer: "hosted-sites" },
          signal,
        );
        if (!signed) {
          throw new Error("Hosted artifact file is unavailable");
        }
        return { ...file, downloadUrl: signed.url };
      }),
    );
    signal.throwIfAborted();
    return {
      ...args.metadata,
      fileCount: files.length,
      size: files.reduce((sum, file) => {
        return sum + file.size;
      }, 0),
      files,
    };
  },
);
