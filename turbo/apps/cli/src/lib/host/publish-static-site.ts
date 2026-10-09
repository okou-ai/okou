import type {
  HostedArtifactKind,
  HostedSiteCompleteResponse,
} from "@okouai/api-contracts/contracts/host";
import { completeHostedSite, prepareHostedSite } from "../api/domains/host";
import { ApiRequestError } from "../api/core/client-factory";
import { readStaticSiteFile, scanStaticSite } from "./static-site";
import { bundleFingerprint, readHostedPreview } from "./preview";

interface PublishStaticSiteProgress {
  readonly phase: "preparing" | "uploading";
  readonly fileCount?: number;
  readonly path?: string;
}

interface PublishStaticSiteResult {
  readonly siteId: string;
  readonly deploymentId: string;
  readonly publicSlug: string;
  readonly url: string;
  readonly deploymentVersion?: number;
  readonly artifactUrl?: string;
  readonly aliasUrl?: string;
  readonly isActive?: boolean;
  readonly activeDeploymentVersion?: number;
  readonly fileCount: number;
  readonly size: number;
  readonly previewImageUrl?: string;
}

interface PublishStaticSiteOptions {
  readonly dir: string;
  readonly site: string;
  readonly slugSuffix?: string;
  readonly artifactKind?: HostedArtifactKind;
  readonly spaFallback?: boolean;
  readonly preview?: string;
  readonly onProgress?: (progress: PublishStaticSiteProgress) => void;
}

async function uploadHostedFile(
  uploadUrl: string,
  contentType: string,
  bytes: Uint8Array,
  label: string,
): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: new Uint8Array(bytes),
  });
  if (!response.ok) {
    throw new Error(`Failed to upload ${label} (HTTP ${response.status})`);
  }
}

export async function publishStaticSite(
  options: PublishStaticSiteOptions,
): Promise<PublishStaticSiteResult> {
  const artifactKind = options.artifactKind ?? "hosted-site";
  const scan = await scanStaticSite(
    options.dir,
    artifactKind === "hosted-site" ? { defaultRobots: "disallow-all" } : {},
  );
  const totalSize = scan.files.reduce((sum, file) => {
    return sum + file.size;
  }, 0);
  let preview = options.preview
    ? await readHostedPreview(
        options.preview,
        bundleFingerprint(scan.files),
        scan.root,
      )
    : undefined;

  options.onProgress?.({
    phase: "preparing",
    fileCount: scan.files.length,
  });

  const prepared = await prepareHostedSite({
    site: options.site,
    ...(options.slugSuffix !== undefined && { slugSuffix: options.slugSuffix }),
    artifactKind,
    spaFallback: Boolean(options.spaFallback),
    ...(preview ? { preview: preview.metadata } : {}),
    files: scan.files.map((file) => {
      return {
        path: file.path,
        size: file.size,
        sha256: file.sha256,
        contentType: file.contentType,
        immutable: file.immutable,
      };
    }),
  });

  if (prepared.previewSkipped) preview = undefined;
  if (preview && prepared.preview?.sha256 !== preview.metadata.sha256) {
    throw new Error(
      "This API did not acknowledge the supplied preview. Deploy the compatible API before publishing; no files were uploaded or activated",
    );
  }

  const uploadByPath = new Map(
    prepared.uploads.map((upload) => {
      return [upload.path, upload.uploadUrl];
    }),
  );

  for (const file of scan.files) {
    const uploadUrl = uploadByPath.get(file.path);
    if (!uploadUrl) {
      throw new Error(`Missing upload URL for ${file.path}`);
    }
    options.onProgress?.({ phase: "uploading", path: file.path });
    const bytes = await readStaticSiteFile(file);
    await uploadHostedFile(uploadUrl, file.contentType, bytes, file.path);
  }

  if (preview && prepared.preview) {
    options.onProgress?.({ phase: "uploading", path: "artifact preview" });
    await uploadHostedFile(
      prepared.preview.uploadUrl,
      preview.metadata.contentType,
      preview.bytes,
      "artifact preview",
    );
  }

  const completed = await completeHostedSite(prepared.deploymentId).catch(
    (error: unknown) => {
      if (error instanceof ApiRequestError && error.status < 500) {
        throw error;
      }
      throw new Error(
        `Deployment ${prepared.deploymentId} could not be confirmed. Retry completion with: okou host complete ${prepared.deploymentId}`,
        { cause: error },
      );
    },
  );
  if (preview && !completed.previewSkipped && !completed.previewImageUrl) {
    throw new Error(
      `API did not confirm the preview for deployment ${prepared.deploymentId}. Retry completion against the compatible API with: okou host complete ${prepared.deploymentId}`,
    );
  }

  return publicationResult(completed, scan.files.length, totalSize);
}

function publicationResult(
  completed: HostedSiteCompleteResponse,
  fileCount: number,
  size: number,
): PublishStaticSiteResult {
  return {
    siteId: completed.siteId,
    deploymentId: completed.deploymentId,
    publicSlug: completed.publicSlug,
    url: completed.url,
    ...(completed.deploymentVersion === undefined
      ? {}
      : { deploymentVersion: completed.deploymentVersion }),
    ...(completed.artifactUrl === undefined
      ? {}
      : { artifactUrl: completed.artifactUrl }),
    ...(completed.aliasUrl === undefined
      ? {}
      : { aliasUrl: completed.aliasUrl }),
    ...(completed.isActive === undefined
      ? {}
      : { isActive: completed.isActive }),
    ...(completed.activeDeploymentVersion === undefined
      ? {}
      : { activeDeploymentVersion: completed.activeDeploymentVersion }),
    fileCount,
    size,
    ...(completed.previewImageUrl
      ? { previewImageUrl: completed.previewImageUrl }
      : {}),
  };
}
