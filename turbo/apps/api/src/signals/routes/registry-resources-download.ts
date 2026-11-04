import { computed } from "ccstate";
import { registryResourceDownloadContract } from "@okouai/api-contracts/contracts/registry-resources";
import { findPresentationRunbookResource } from "@okouai/core/resource-registry";
import {
  registryResourceArchives,
  registryResourceHeads,
} from "@okouai/db/schema/registry-resource-archive";
import { registryResourceArchiveKey } from "@okouai/core/registry-resource-archive";
import { and, eq } from "drizzle-orm";

import { env } from "../../lib/env";
import { notFound } from "../../lib/error";
import {
  findRegistryArchiveEntry,
  resolvePrivateRegistryResourceArchive,
} from "@okouai/core/private-registry-resource-archives";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { db$ } from "../external/db";
import { generatePresignedGetUrl } from "../external/s3";
import type { RouteEntry } from "../route-entry";
import { PRESIGNED_URL_TTL_SECONDS } from "@okouai/api-contracts/contracts/presigned-urls";

const DOWNLOAD_URL_TTL_SECONDS = PRESIGNED_URL_TTL_SECONDS;

function storageServiceNotConfigured() {
  return {
    status: 500 as const,
    body: {
      error: {
        message: "Storage service is not properly configured",
        code: "INTERNAL_ERROR" as const,
      },
    },
  };
}

function archiveFilename(id: string): string {
  return `${id.replace(/[^a-zA-Z0-9._-]/g, "-")}.tar.gz`;
}

const downloadPresentationTemplateInner$ = computed(async (get) => {
  const query = get(
    queryOf(registryResourceDownloadContract.downloadPresentationTemplate),
  );
  const entry = findPresentationRunbookResource(query.id);
  if (!entry || !entry.source.archive) {
    return notFound(`Presentation template "${query.id}" was not found`);
  }

  const anchor = resolvePrivateRegistryResourceArchive(
    query.id,
    entry.source.archive.sha256,
    entry.source.archive.sha256,
  );
  if (!anchor) {
    return notFound(`Presentation template "${query.id}" was not found`);
  }

  const db = get(db$);
  const [archive] = await db
    .select({
      sha256: registryResourceArchives.sha256,
    })
    .from(registryResourceHeads)
    .innerJoin(
      registryResourceArchives,
      and(
        eq(
          registryResourceArchives.resourceId,
          registryResourceHeads.resourceId,
        ),
        eq(registryResourceArchives.sha256, registryResourceHeads.sha256),
      ),
    )
    .where(eq(registryResourceHeads.resourceId, entry.id))
    .limit(1);

  if (!archive) {
    return notFound(`Current archive for "${query.id}" was not found`);
  }

  const bucket = env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME");
  if (!bucket) {
    return storageServiceNotConfigured();
  }

  const url = await get(
    generatePresignedGetUrl(
      bucket,
      registryResourceArchiveKey(archive.sha256),
      archiveFilename(query.id),
      true,
    ),
  );

  return {
    status: 200 as const,
    body: {
      url,
    },
  };
});

const downloadRegistryResourceInner$ = computed(async (get) => {
  const query = get(queryOf(registryResourceDownloadContract.download));
  const entry = findRegistryArchiveEntry(query.id);
  const archive = entry?.source.archive;
  if (!entry || !archive) {
    return notFound(`Registry resource "${query.id}" has no archive source`);
  }

  const privateArchive = resolvePrivateRegistryResourceArchive(
    query.id,
    query.expectedSha256,
    archive.sha256,
  );
  if (!privateArchive) {
    return notFound(`Registry resource "${query.id}" is not private-pullable`);
  }

  const db = get(db$);
  const [version] = await db
    .select({
      versionId: registryResourceArchives.versionId,
      fileCount: registryResourceArchives.fileCount,
      size: registryResourceArchives.totalBytes,
    })
    .from(registryResourceArchives)
    .where(
      and(
        eq(registryResourceArchives.resourceId, entry.id),
        eq(registryResourceArchives.sha256, privateArchive.sha256),
      ),
    )
    .limit(1);

  if (!version) {
    return notFound(`Private archive for "${query.id}" was not found`);
  }

  const bucket = env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME");
  if (!bucket) {
    return storageServiceNotConfigured();
  }

  const url = await get(
    generatePresignedGetUrl(
      bucket,
      registryResourceArchiveKey(privateArchive.sha256),
      archiveFilename(query.id),
      true,
    ),
  );

  return {
    status: 200 as const,
    body: {
      url,
      id: entry.id,
      type: archive.type,
      sha256: privateArchive.sha256,
      expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
      versionId: version.versionId,
      fileCount: version.fileCount,
      size: Number(version.size),
    },
  };
});

export const registryResourceDownloadRoutes: readonly RouteEntry[] = [
  {
    route: registryResourceDownloadContract.downloadPresentationTemplate,
    handler: authRoute(
      { requiredCapability: "file:read" },
      downloadPresentationTemplateInner$,
    ),
  },
  {
    route: registryResourceDownloadContract.download,
    handler: authRoute(
      { requiredCapability: "file:read" },
      downloadRegistryResourceInner$,
    ),
  },
];
