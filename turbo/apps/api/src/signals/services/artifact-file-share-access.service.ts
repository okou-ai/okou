import { command } from "ccstate";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { artifacts, imageArtifacts } from "@okouai/db/schema/artifact";
import { artifactUserShares } from "@okouai/db/schema/artifact-user-share";
import { db$ } from "../external/db";
import type { PrivateArtifactRecord } from "./private-artifact-storage.service";
import { resolveArtifactPreviewUrl$ } from "./artifact-preview-url.service";
import { resolveArtifactDownloadUrl$ } from "./artifact-download-url.service";
import { nowDate } from "../../lib/time";

/**
 * Find the active (non-deleted) `artifacts` row backing a stored file.
 *
 * Principle 3 & 4: a file without an active `artifacts` row (including user
 * attachments, system captures, and Library-deleted artifacts) is strictly
 * owner-only for `(ownerUserId, orgId)`.
 */
export const findActiveArtifactForFile$ = command(
  async (
    { get },
    file: {
      readonly id: string;
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ) => {
    const database = get(db$);
    const [artifact] = await database
      .select({
        id: artifacts.id,
        kind: artifacts.kind,
        title: artifacts.title,
        visibility: artifacts.visibility,
        thumbnail: artifacts.thumbnail,
        updatedAt: artifacts.updatedAt,
      })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.orgId, file.orgId),
          eq(artifacts.authorUserId, file.userId),
          isNull(artifacts.deletedAt),
          or(
            and(eq(artifacts.kind, "file"), eq(artifacts.entityId, file.id)),
            and(
              eq(artifacts.kind, "image"),
              inArray(
                artifacts.entityId,
                database
                  .select({ id: imageArtifacts.id })
                  .from(imageArtifacts)
                  .where(eq(imageArtifacts.fileId, file.id)),
              ),
            ),
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return artifact ?? null;
  },
);

/** Grant temporary file credentials when the viewer has an active `artifact_user_shares` row. */
export const resolveInvitedArtifactFile$ = command(
  async (
    { get, set },
    args: { readonly file: PrivateArtifactRecord; readonly userId: string },
    signal: AbortSignal,
  ) => {
    const file = args.file;
    if (!file.isReady) {
      return null;
    }
    const artifact = await set(findActiveArtifactForFile$, file, signal);
    if (!artifact) {
      return null;
    }
    const [share] = await get(db$)
      .select({ userId: artifactUserShares.userId })
      .from(artifactUserShares)
      .where(
        and(
          eq(artifactUserShares.artifactId, artifact.id),
          eq(artifactUserShares.orgId, file.orgId),
          eq(artifactUserShares.userId, args.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!share) {
      return null;
    }
    const preview = await set(
      resolveArtifactPreviewUrl$,
      { bucket: file.bucket, key: file.key, signingDate: nowDate() },
      signal,
    );
    const downloadUrl = await set(resolveArtifactDownloadUrl$, file, signal);
    signal.throwIfAborted();
    const previewImageUrl = artifact.thumbnail?.url ?? null;
    return {
      ...preview,
      downloadUrl,
      filename: file.filename,
      contentType: file.contentType,
      ...(previewImageUrl ? { previewImageUrl } : {}),
      target: { kind: "file" as const, id: file.id },
    };
  },
);
