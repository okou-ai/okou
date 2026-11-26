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
import { builtInWorkflowBundleUrl } from "./builtin-workflows";

export function selectExecutionContentBundles(
  packages: CapturedExecutionPackages,
  context: ExecutionPackageMounts,
) {
  const workflowNames = new Set(
    packages.workflows.map(({ name }) => {
      return name;
    }),
  );
  const instructions = packages.instructionsBundle;
  const preparedSkills = [
    ...context.officialWorkflowBundles,
    ...context.seedSkillBundles.filter(({ name }) => {
      return !workflowNames.has(name);
    }),
  ];
  const skills = [
    ...packages.workflows,
    ...preparedSkills.map(({ name, mount: { sha256, archiveBytes } }) => {
      return { name, contentBundle: { sha256, archiveBytes } };
    }),
  ];
  const templates = context.templateGuidanceBundles;
  const hashes = [
    ...new Set([
      instructions.sha256,
      ...skills.map(({ contentBundle }) => {
        return contentBundle.sha256;
      }),
      ...templates.map(({ sha256 }) => {
        return sha256;
      }),
    ]),
  ];
  return {
    instructions,
    skills,
    templates,
    hashes: hashes.filter((sha256) => {
      return !builtInWorkflowBundleUrl(sha256);
    }),
  };
}

/** Share URLs across references to identical archives. */
export const signExecutionContentBundles$ = command(
  async (
    { get },
    bundles: ReturnType<typeof selectExecutionContentBundles>,
    cache: ContentBundleUrlCacheSnapshot,
    signal: AbortSignal,
  ): Promise<{
    readonly contentBundles: ExecutionContext["startupInputs"]["contentBundles"];
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
      const url =
        builtInWorkflowBundleUrl(reference.sha256) ??
        (request && signed.results.get(request.cacheKey)?.url);
      if (!url) {
        throw new Error("Execution Content Bundle URL is missing");
      }
      return { ...reference, downloadUrl: url };
    };
    return {
      contentBundles: {
        format: "tar-gzip-v1",
        instructions: withDownloadUrl(bundles.instructions),
        skills: bundles.skills.map(({ name, contentBundle }) => {
          return { name, bundle: withDownloadUrl(contentBundle) };
        }),
        ...(bundles.templates.length > 0
          ? { templates: bundles.templates.map(withDownloadUrl) }
          : {}),
      },
      cacheWrites: signed.freshValues,
    };
  },
);
