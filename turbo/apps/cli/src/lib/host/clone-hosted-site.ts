import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { HostedSiteFilesResponse } from "@okouai/api-contracts/contracts/host";
import { parseArtifactReference } from "@okouai/api-contracts/contracts/artifact-references";
import { readHostedArtifactFiles } from "../api/domains/artifact-references";
import { privateHostedDeploymentId } from "@okouai/core/private-hosted-artifact";
import { getPlatformOrigin } from "../platform-url";
import { getBaseUrl } from "../api/core/client-factory";
import { getHostedSiteFiles } from "../api/domains/host";
import { checkDirectoryStatus } from "../utils/file-utils";

interface CloneHostedSiteProgress {
  readonly phase: "checking" | "creating" | "downloading";
  readonly fileCount?: number;
  readonly path?: string;
}

interface CloneHostedSiteResult {
  readonly siteId: string;
  readonly deploymentId: string;
  readonly publicSlug: string;
  readonly url: string;
  readonly deploymentVersion?: number;
  readonly artifactUrl?: string;
  readonly destination: string;
  readonly fileCount: number;
  readonly size: number;
}

interface CloneHostedSiteOptions {
  readonly site: string;
  readonly destination?: string;
  readonly version?: number;
  readonly onProgress?: (progress: CloneHostedSiteProgress) => void;
}

async function publicSlugFromSite(value: string): Promise<string> {
  const trimmed = value.trim();
  if (URL.canParse(trimmed)) {
    const deploymentId = privateHostedDeploymentId(trimmed, await getBaseUrl());
    if (deploymentId) {
      return `dpl-${deploymentId}`;
    }
    const url = new URL(trimmed);
    return url.hostname.split(".")[0] ?? trimmed;
  }
  if (trimmed.includes(".")) {
    return trimmed.split(".")[0] ?? trimmed;
  }
  return trimmed;
}

async function siteFilesFromSource(options: CloneHostedSiteOptions) {
  const source = options.site.trim();
  const reference = parseArtifactReference(source, await getPlatformOrigin());
  if (!reference) {
    return getHostedSiteFiles(
      await publicSlugFromSite(source),
      options.version,
      URL.canParse(source)
        ? new URL(source).hostname
        : source.includes(".")
          ? source
          : undefined,
    );
  }
  const site = await readHostedArtifactFiles(
    `${reference.hash}${reference.extension}`,
  );
  if (
    options.version !== undefined &&
    site.deploymentVersion !== options.version
  ) {
    throw new Error(`Hosted deployment version not found: ${options.version}`);
  }
  return site;
}

function isInsideDirectory(parent: string, target: string): boolean {
  const relativePath = relative(parent, target);
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) &&
      relativePath !== ".." &&
      !isAbsolute(relativePath))
  );
}

function outputPathForHostedFile(
  destination: string,
  hostedPath: string,
): string {
  if (
    !hostedPath.startsWith("/") ||
    hostedPath.startsWith("//") ||
    hostedPath.includes("\\") ||
    hostedPath.includes("\0")
  ) {
    throw new Error(`Invalid hosted-site path: ${hostedPath}`);
  }

  const segments = hostedPath.split("/").filter((segment) => {
    return segment.length > 0;
  });
  if (
    segments.length === 0 ||
    segments.some((segment) => {
      return segment === "." || segment === "..";
    })
  ) {
    throw new Error(`Invalid hosted-site path: ${hostedPath}`);
  }

  const destinationRoot = resolve(destination);
  const outputPath = resolve(destinationRoot, ...segments);
  if (!isInsideDirectory(destinationRoot, outputPath)) {
    throw new Error(`Invalid hosted-site path: ${hostedPath}`);
  }

  return outputPath;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function downloadHostedFile(
  file: HostedSiteFilesResponse["files"][number],
  destination: string,
): Promise<void> {
  const response = await fetch(file.downloadUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to download ${file.path} (HTTP ${response.status})`,
    );
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength !== file.size) {
    throw new Error(`Downloaded size mismatch for ${file.path}`);
  }
  if (sha256(bytes) !== file.sha256) {
    throw new Error(`Downloaded hash mismatch for ${file.path}`);
  }

  const outputPath = outputPathForHostedFile(destination, file.path);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, bytes);
}

function requireEmptyDirectory(destination: string): void {
  const dirStatus = checkDirectoryStatus(destination);
  if (dirStatus.exists && !dirStatus.empty) {
    throw new Error(`Directory "${destination}" is not empty`);
  }
}

export async function downloadHostedSiteFiles(
  hostedSite: HostedSiteFilesResponse,
  destination: string,
  onProgress?: (progress: CloneHostedSiteProgress) => void,
): Promise<void> {
  requireEmptyDirectory(destination);
  for (const file of hostedSite.files) {
    outputPathForHostedFile(destination, file.path);
  }
  onProgress?.({
    phase: "creating",
    fileCount: hostedSite.fileCount,
  });
  await mkdir(destination, { recursive: true });

  for (const file of hostedSite.files) {
    onProgress?.({ phase: "downloading", path: file.path });
    await downloadHostedFile(file, destination);
  }
}

export async function cloneHostedSite(
  options: CloneHostedSiteOptions,
): Promise<CloneHostedSiteResult> {
  if (options.destination !== undefined) {
    requireEmptyDirectory(options.destination);
  }
  options.onProgress?.({ phase: "checking" });
  const hostedSite = await siteFilesFromSource(options);
  const destination = options.destination ?? hostedSite.publicSlug;
  await downloadHostedSiteFiles(hostedSite, destination, options.onProgress);

  return {
    siteId: hostedSite.siteId,
    deploymentId: hostedSite.deploymentId,
    publicSlug: hostedSite.publicSlug,
    url: hostedSite.url,
    ...(hostedSite.deploymentVersion === undefined
      ? {}
      : { deploymentVersion: hostedSite.deploymentVersion }),
    ...(hostedSite.artifactUrl === undefined
      ? {}
      : { artifactUrl: hostedSite.artifactUrl }),
    destination,
    fileCount: hostedSite.fileCount,
    size: hostedSite.size,
  };
}
