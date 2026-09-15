import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { HostedSiteFilesResponse } from "@okouai/api-contracts/contracts/host";
import { parseArtifactReference } from "@okouai/api-contracts/contracts/artifact-references";
import { privateHostedDeploymentId } from "@okouai/core/private-hosted-artifact";
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
  readonly destination: string;
  readonly version?: number;
  readonly onProgress?: (progress: CloneHostedSiteProgress) => void;
}

export async function publicSlugFromSite(value: string): Promise<string> {
  const trimmed = value.trim();
  const reference = parseArtifactReference(trimmed);
  if (reference) {
    if (!reference.id) {
      throw new Error(
        "Open organization share links in the app. To clone your own site, use its owner artifact reference.",
      );
    }
    return `dpl-${reference.id}`;
  }
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

export async function cloneHostedSite(
  options: CloneHostedSiteOptions,
): Promise<CloneHostedSiteResult> {
  const publicSlug = await publicSlugFromSite(options.site);
  const dirStatus = checkDirectoryStatus(options.destination);
  if (dirStatus.exists && !dirStatus.empty) {
    throw new Error(`Directory "${options.destination}" is not empty`);
  }

  options.onProgress?.({ phase: "checking" });
  const hostedSite = await getHostedSiteFiles(publicSlug, options.version);

  options.onProgress?.({
    phase: "creating",
    fileCount: hostedSite.fileCount,
  });
  await mkdir(options.destination, { recursive: true });

  for (const file of hostedSite.files) {
    options.onProgress?.({ phase: "downloading", path: file.path });
    await downloadHostedFile(file, options.destination);
  }

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
    destination: options.destination,
    fileCount: hostedSite.fileCount,
    size: hostedSite.size,
  };
}
