import { command } from "ccstate";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { uuid } from "zod";
import { artifacts } from "@okouai/db/schema/artifact";
import { files as filesTable } from "@okouai/db/schema/file";
import type { ArtifactLibraryPreview } from "@okouai/api-contracts/contracts/artifact-library-previews";
import { sharedThreadArtifactAuthorUserId } from "../../lib/shared-thread-artifact";
import { db$ } from "../external/db";
import {
  privateArtifactFromRow,
  resolveArtifactFileReference$,
} from "./private-artifact-storage.service";
import {
  privateArtifactPreviewPresignedUrlCacheKey,
  resolvePrivateArtifactPreviewPresignedUrls$,
} from "./system-storage-presigned-url-cache.service";

export const resolveArtifactLibraryPreviews$ = command(
  async (
    { get, set },
    args: {
      readonly artifactIds: readonly string[];
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<ArtifactLibraryPreview[]> => {
    const db = get(db$);
    const rows = await db
      .select({
        id: artifacts.id,
        thumbnail: artifacts.thumbnail,
        sourceUrl: artifacts.sourceUrl,
        projectionFileId: artifacts.projectionFileId,
      })
      .from(artifacts)
      .where(
        and(
          inArray(artifacts.id, args.artifactIds),
          eq(artifacts.orgId, args.orgId),
          inArray(artifacts.authorUserId, [
            args.userId,
            sharedThreadArtifactAuthorUserId(args.userId),
          ]),
          isNull(artifacts.deletedAt),
        ),
      );
    signal.throwIfAborted();
    // File covers already carry their identity in the catalog. Only separate
    // posters/screenshots need their short reference resolved from storage.
    const targets = await Promise.all(
      rows.map(async (row) => {
        if (!row.thumbnail) {
          return null;
        }
        const fileId =
          row.thumbnail.url === row.sourceUrl && row.projectionFileId
            ? row.projectionFileId
            : (
                await set(
                  resolveArtifactFileReference$,
                  row.thumbnail.url,
                  signal,
                )
              )?.id;
        signal.throwIfAborted();
        return fileId && uuid().safeParse(fileId).success
          ? { artifactId: row.id, fileId }
          : null;
      }),
    );
    signal.throwIfAborted();
    const fileIds = [
      ...new Set(
        targets.flatMap((target) => {
          return target ? [target.fileId] : [];
        }),
      ),
    ];
    if (fileIds.length === 0) {
      return [];
    }
    const fileRows = await db
      .select()
      .from(filesTable)
      .where(
        and(
          inArray(filesTable.id, fileIds),
          eq(filesTable.orgId, args.orgId),
          eq(filesTable.ownerUserId, args.userId),
          isNull(filesTable.deletedAt),
          isNotNull(filesTable.sizeBytes),
        ),
      );
    signal.throwIfAborted();
    const owned = fileRows.flatMap((row) => {
      const file = privateArtifactFromRow(row);
      return file ? [file] : [];
    });
    // This endpoint only serves published catalog covers. Their writers have
    // already completed the upload; a missing object uses the card's image-error
    // fallback instead of another HEAD, download signature, or paywall lookup.
    const signed = await set(
      resolvePrivateArtifactPreviewPresignedUrls$,
      {
        requests: owned.map((file) => {
          return {
            bucket: file.bucket,
            objectKey: file.key,
          };
        }),
      },
      signal,
    );
    signal.throwIfAborted();
    const byId = new Map(
      owned.map((file) => {
        return [file.id, file];
      }),
    );
    return targets.flatMap((target) => {
      const file = target && byId.get(target.fileId);
      if (!target || !file) {
        return [];
      }
      const preview = signed.get(
        privateArtifactPreviewPresignedUrlCacheKey({
          bucket: file.bucket,
          objectKey: file.key,
        }),
      );
      if (!preview) {
        throw new Error("Private artifact preview URL was not resolved");
      }
      return [
        {
          artifactId: target.artifactId,
          url: preview.url,
          expiresAt: preview.expiresAt.toISOString(),
          contentType: file.contentType,
        },
      ];
    });
  },
);
