import { computed, type Computed } from "ccstate";
import {
  getCustomSkillStorageName,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { and, eq } from "drizzle-orm";

import { db$ } from "../external/db";
import { downloadManifest, downloadS3Buffer } from "../external/s3";
import { settle } from "../utils";
import { env } from "../../lib/env";
import { extractFilesFromTarGz } from "../../lib/tar";

export const SKILL_FILENAME = "SKILL.md";

interface WorkflowVolumeFile {
  readonly path: string;
  readonly content: string;
  readonly size: number;
}

function normalizePath(p: string): string {
  return p.replace(/^\.\//, "");
}

const EMPTY_S3_BODY_MESSAGE = "S3 object body is empty";

function isMissingS3ObjectError(error: unknown): boolean {
  const candidate = error as {
    readonly name?: string;
    readonly message?: string;
    readonly Code?: string;
    readonly code?: string;
    readonly $metadata?: { readonly httpStatusCode?: number };
  };
  const code = candidate.Code ?? candidate.code ?? candidate.name;
  return (
    code === "NoSuchKey" ||
    code === "NotFound" ||
    candidate.message === EMPTY_S3_BODY_MESSAGE ||
    (candidate.name === "NotFound" &&
      candidate.$metadata?.httpStatusCode === 404)
  );
}

/**
 * Load every file (path + content + size) from a workflow's volume, keyed by
 * the workflow id. The synthesized SKILL.md is included; callers filter it out
 * as needed.
 *
 * Returns `null` when the volume's backing storage is absent or unloadable:
 * the workflow has no volume yet (no storage row / head version), or the
 * head version's S3 objects are missing/empty. This is distinct from a volume
 * that loads successfully but contains no files (returns `[]`).
 */
export function loadWorkflowVolumeFiles(args: {
  readonly orgId: string;
  readonly workflowId: string;
  readonly version?: { readonly storageId: string; readonly versionId: string };
}): Computed<Promise<readonly WorkflowVolumeFile[] | null>> {
  return computed(async (get) => {
    let storage:
      | { readonly id: string; readonly headVersionId: string | null }
      | undefined;
    if (args.version) {
      // Copy preparation pins the exact immutable version it will revalidate
      // at publication, rather than independently rereading a moving HEAD.
      storage = {
        id: args.version.storageId,
        headVersionId: args.version.versionId,
      };
    } else {
      const storageName = getCustomSkillStorageName(args.workflowId);
      const [current] = await get(db$)
        .select({ id: storages.id, headVersionId: storages.headVersionId })
        .from(storages)
        .where(
          and(
            eq(storages.orgId, args.orgId),
            eq(storages.userId, VOLUME_ORG_USER_ID),
            eq(storages.name, storageName),
          ),
        )
        .limit(1);
      storage = current;
    }

    if (!storage?.headVersionId) {
      return null;
    }

    const [version] = await get(db$)
      .select({ s3Key: storageVersions.s3Key })
      .from(storageVersions)
      .where(
        and(
          eq(storageVersions.storageId, storage.id),
          eq(storageVersions.id, storage.headVersionId),
        ),
      )
      .limit(1);

    if (!version) {
      return null;
    }

    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    if (!bucket) {
      return null;
    }

    const manifestResult = await settle(
      get(downloadManifest(bucket, version.s3Key)),
    );
    if (!manifestResult.ok) {
      if (isMissingS3ObjectError(manifestResult.error)) {
        return null;
      }
      throw manifestResult.error;
    }

    const filesList = manifestResult.value.files.map((f) => {
      return { path: normalizePath(f.path), size: f.size };
    });

    const archiveKey = `${version.s3Key}/archive.tar.gz`;
    const archiveResult = await settle(
      get(downloadS3Buffer(bucket, archiveKey)),
    );
    if (!archiveResult.ok) {
      if (isMissingS3ObjectError(archiveResult.error)) {
        return null;
      }
      throw archiveResult.error;
    }

    const contents = extractFilesFromTarGz(
      archiveResult.value,
      filesList.map((file) => {
        return file.path;
      }),
    );
    const sizeByPath = new Map(
      filesList.map((file) => {
        return [file.path, file.size];
      }),
    );

    return contents.map((file) => {
      const path = normalizePath(file.path);
      return {
        path,
        content: file.content,
        size: sizeByPath.get(path) ?? Buffer.byteLength(file.content, "utf8"),
      };
    });
  });
}
