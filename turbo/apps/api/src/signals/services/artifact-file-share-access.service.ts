import { command } from "ccstate";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { artifactFileShares } from "@okouai/db/schema/artifact-file-share";
import { clerk$ } from "../external/clerk";
import { findClerkUser } from "../external/clerk-users";
import { db$, writeDb$ } from "../external/db";
import type { PrivateArtifactRecord } from "./private-artifact-storage.service";
import { resolveArtifactPreviewUrl$ } from "./artifact-preview-url.service";
import { resolveArtifactDownloadUrl$ } from "./artifact-download-url.service";
import { uploadedArtifactPreviewImageUrl$ } from "./uploaded-artifact.service";
import { syncArtifactUserShareByFileId$ } from "./artifact-access-dual-write.service";
import { nowDate } from "../../lib/time";

const claimFileShareAccess$ = command(
  async (
    { get, set },
    args: { readonly fileId: string; readonly userId: string },
    signal: AbortSignal,
  ) => {
    const shares = await get(db$)
      .select()
      .from(artifactFileShares)
      .where(eq(artifactFileShares.fileId, args.fileId));
    signal.throwIfAborted();
    if (
      shares.some((share) => {
        return share.userId === args.userId;
      })
    ) {
      return true;
    }
    if (
      !shares.some((share) => {
        return share.userId === null;
      })
    ) {
      return false;
    }
    const user = await findClerkUser(get(clerk$), args.userId, signal);
    if (!user || user.banned) {
      return false;
    }
    const emails = user.emailAddresses
      .filter((address) => {
        return address.verification?.status === "verified";
      })
      .map((address) => {
        return address.emailAddress.trim().toLowerCase();
      });
    if (emails.length === 0) {
      return false;
    }
    const claimed = await set(writeDb$)
      .update(artifactFileShares)
      .set({ userId: args.userId })
      .where(
        and(
          eq(artifactFileShares.fileId, args.fileId),
          or(
            isNull(artifactFileShares.userId),
            eq(artifactFileShares.userId, args.userId),
          ),
          inArray(artifactFileShares.email, emails),
        ),
      )
      .returning({
        id: artifactFileShares.id,
        email: artifactFileShares.email,
      });
    signal.throwIfAborted();
    const [firstClaimed] = claimed;
    if (firstClaimed) {
      await set(
        syncArtifactUserShareByFileId$,
        {
          fileId: args.fileId,
          userId: args.userId,
          email: firstClaimed.email,
        },
        signal,
      );
    }
    return firstClaimed !== undefined;
  },
);

/** This credential follows a live named grant, independent of general audience. */
export const resolveInvitedArtifactFile$ = command(
  async (
    { set },
    args: { readonly file: PrivateArtifactRecord; readonly userId: string },
    signal: AbortSignal,
  ) => {
    const file = args.file;
    if (
      file.materializationStatus !== "ready" ||
      !(await set(
        claimFileShareAccess$,
        { fileId: file.id, userId: args.userId },
        signal,
      ))
    ) {
      return null;
    }
    const preview = await set(
      resolveArtifactPreviewUrl$,
      { bucket: file.bucket, key: file.key, signingDate: nowDate() },
      signal,
    );
    const downloadUrl = await set(resolveArtifactDownloadUrl$, file, signal);
    const previewImageUrl = await set(
      uploadedArtifactPreviewImageUrl$,
      { id: file.id, userId: file.userId, orgId: file.orgId },
      signal,
    );
    signal.throwIfAborted();
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
