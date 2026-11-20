import type { ExecutionContext } from "@okouai/api-contracts/contracts/runners";
import { command } from "ccstate";
import type { ContentBundle } from "@okouai/api-contracts/contracts/content-bundle";
import { presignedGetUrlSignerForBucket } from "../external/s3";
import {
  contentBundleUrlCacheRequest,
  type ContentBundleUrlCacheSnapshot,
} from "./content-bundle-presigned-url-cache";
import {
  signStoragePresignedUrls,
  type StoragePresignedUrlCacheWrite,
} from "./system-storage-presigned-url-cache.service";
import type {
  CapturedExecutionPackages,
  ExecutionPackageMounts,
} from "./execution-workflow-selection";

export function selectExecutionContentBundles(
  packages: CapturedExecutionPackages,
  context: ExecutionPackageMounts & { readonly skillRoot: string },
) {
  const workflows = packages.workflows.map(({ name, contentBundle }) => {
    return { ...contentBundle, mountPath: `${context.skillRoot}/${name}` };
  });
  const workflowMountPaths = new Set(
    workflows.map(({ mountPath }) => {
      return mountPath;
    }),
  );
  const instructions = packages.instructionsBundle;
  const skills = [
    ...workflows,
    ...context.officialWorkflowBundles,
    ...context.seedSkillBundles.filter(({ mountPath }) => {
      return !workflowMountPaths.has(mountPath);
    }),
  ];
  const templates = context.templateGuidanceBundles;
  const hashes = [
    ...new Set(
      [instructions, ...skills, ...templates].map(({ sha256 }) => {
        return sha256;
      }),
    ),
  ];
  return { instructions, skills, templates, hashes };
}

/** Share URLs for identical bytes while retaining each reference's mount metadata. */
export const signExecutionContentBundles$ = command(
  async (
    { get },
    bundles: ReturnType<typeof selectExecutionContentBundles>,
    cache: ContentBundleUrlCacheSnapshot,
    signal: AbortSignal,
  ): Promise<{
    readonly contentBundles: ExecutionContext["contentBundles"];
    readonly cacheWrites: readonly StoragePresignedUrlCacheWrite[];
  }> => {
    signal.throwIfAborted();
    const requests = new Map(
      bundles.hashes.map((sha256) => {
        return [sha256, contentBundleUrlCacheRequest(cache.context, sha256)];
      }),
    );
    const rows = cache.rows.flatMap(({ sha256, url, expiresAtMs }) => {
      const request = requests.get(sha256);
      return request
        ? [
            {
              cacheKey: request.cacheKey,
              presignedUrl: url,
              expiresAt: new Date(expiresAtMs),
            },
          ]
        : [];
    });
    const signed = await signStoragePresignedUrls({
      requests: [...requests.values()],
      rows,
      sign: get(presignedGetUrlSignerForBucket(cache.context.bucket)),
    });
    signal.throwIfAborted();
    const withDownloadUrl = <T extends ContentBundle>(reference: T) => {
      const request = requests.get(reference.sha256);
      const url = request && signed.results.get(request.cacheKey)?.url;
      if (!url) {
        throw new Error("Execution Content Bundle URL is missing");
      }
      return { ...reference, downloadUrl: url };
    };
    return {
      contentBundles: {
        format: "tar-gzip-v1",
        instructions: withDownloadUrl(bundles.instructions),
        skills: bundles.skills.map(withDownloadUrl),
        ...(bundles.templates.length > 0
          ? { templates: bundles.templates.map(withDownloadUrl) }
          : {}),
      },
      cacheWrites: signed.freshValues,
    };
  },
);
