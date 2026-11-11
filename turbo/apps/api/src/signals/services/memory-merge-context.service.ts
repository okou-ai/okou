import type { MemoryMergeContext } from "@okouai/api-contracts/contracts/webhooks";
import { storageVersions } from "@okouai/db/schema/storage";
import { command } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";

import { env } from "../../lib/env";
import { db$ } from "../external/db";
import { generatePresignedGetUrl } from "../external/s3";
import type { StorageRow } from "./storage-write.service";

/** Issue immutable download capabilities after active Memory authority is established. */
export const prepareMemoryMergeContext$ = command(
  async (
    { get },
    args: { readonly storage: StorageRow; readonly baseVersionId: string },
    signal: AbortSignal,
  ): Promise<MemoryMergeContext> => {
    const headVersionId = args.storage.headVersionId;
    if (!headVersionId) {
      throw new Error("Memory has no HEAD version");
    }
    const versions = await get(db$)
      .select()
      .from(storageVersions)
      .where(
        and(
          eq(storageVersions.storageId, args.storage.id),
          inArray(storageVersions.id, [args.baseVersionId, headVersionId]),
        ),
      );
    signal.throwIfAborted();
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const snapshots = await Promise.all(
      [args.baseVersionId, headVersionId].map(async (versionId) => {
        const version = versions.find((candidate) => {
          return candidate.id === versionId;
        });
        if (
          !version ||
          version.s3Key !== `${args.storage.s3Prefix}/${versionId}`
        ) {
          throw new Error("Memory merge version is unavailable");
        }
        if (version.fileCount === 0) {
          return { versionId, empty: true };
        }
        const [manifestUrl, archiveUrl] = await Promise.all([
          get(
            generatePresignedGetUrl(
              bucket,
              `${version.s3Key}/manifest.json`,
              undefined,
              true,
            ),
          ),
          get(
            generatePresignedGetUrl(
              bucket,
              `${version.s3Key}/archive.tar.gz`,
              undefined,
              true,
            ),
          ),
        ]);
        signal.throwIfAborted();
        return { versionId, empty: false, manifestUrl, archiveUrl };
      }),
    );
    signal.throwIfAborted();
    const [base, head] = snapshots;
    if (!base || !head) {
      throw new Error("Memory merge snapshots are unavailable");
    }
    return { base, head };
  },
);
