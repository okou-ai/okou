import { generateHostedSitesPresignedGetUrl } from "../external/s3";
import { command } from "ccstate";
import type { HostedSiteFilesResponse } from "@okouai/api-contracts/contracts/host";
import type { HostedSiteManifest } from "@okouai/db/jsonb-contracts/hosted-site";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { createHostedSiteDownloadGrant$ } from "./hosted-site-download.service";

/** Call only after authorizing this exact deployment or immutable share snapshot. */
export const signHostedSiteFiles$ = command(
  async (
    { get, set },
    args: {
      readonly metadata: Omit<
        HostedSiteFilesResponse,
        "files" | "fileCount" | "size"
      >;
      readonly manifest: HostedSiteManifest;
      readonly prefix: string;
      readonly viewerId?: string;
      readonly attachment?: boolean;
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
    const grant = await set(createHostedSiteDownloadGrant$, args, signal);
    const files = await Promise.all(
      manifestFiles.map(async (file) => {
        if (grant) {
          const url = new URL(grant);
          url.searchParams.set("path", file.path);
          return { ...file, downloadUrl: url.href };
        }
        const downloadUrl = await get(
          generateHostedSitesPresignedGetUrl(
            bucket,
            `${args.prefix}${file.path}`,
            true,
            args.attachment
              ? {
                  filename: file.path.slice(file.path.lastIndexOf("/") + 1),
                  responseCacheControl: "private, no-store",
                  signingDate: nowDate(),
                }
              : undefined,
          ),
        );
        signal.throwIfAborted();
        return { ...file, downloadUrl };
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
