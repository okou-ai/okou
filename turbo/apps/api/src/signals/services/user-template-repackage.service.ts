import { command } from "ccstate";
import { getUserTemplateStorageName } from "@okouai/core/storage-names";
import { userTemplates } from "@okouai/db/schema/user-template";
import { eq } from "drizzle-orm";

import { badRequestMessage } from "../../lib/error";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  loadTemplatePackage$,
  resolveTemplateUploads$,
} from "./template-package.service";
import {
  loadAccessibleUserTemplate,
  type UserTemplateRow,
} from "./user-template-data.service";
import { packageLimitsFor } from "./user-template-publish.service";
import { uploadVolumeServerSide$ } from "./storage-volume-upload.service";

type RepackageResult =
  | { readonly kind: "replaced"; readonly row: UserTemplateRow }
  | { readonly kind: "not-found" }
  | {
      readonly kind: "rejected";
      readonly response: ReturnType<typeof badRequestMessage>;
    };

function rejected(message: string): RepackageResult {
  return { kind: "rejected", response: badRequestMessage(message) };
}

/**
 * Replace the guidance a published template hands to a later run.
 *
 * This is the "the template is nearly right" path: a member asks for a change,
 * a run rebuilds the package, and the same template starts using it. Nothing
 * else moves. The source is not re-read, so the rendered pages and the
 * manifest still describe it correctly, and the selection every message
 * already carries keeps pointing at the same row.
 *
 * Which files the package must contain follows the row's kind, not the
 * caller's claim — the same rule publish applies, read from the authority
 * rather than the request.
 *
 * Storage is versioned, so the new files land as a whole new version rather
 * than merging into the old one: a file the rebuild dropped is gone rather
 * than left behind to be read by a guide that no longer mentions it.
 */
export const replaceUserTemplatePackage$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly templateId: string;
      readonly packageFileId: string;
    },
    signal: AbortSignal,
  ): Promise<RepackageResult> => {
    const db = set(writeDb$);
    const row = await loadAccessibleUserTemplate(db, {
      orgId: args.orgId,
      userId: args.userId,
      templateId: args.templateId,
    });
    signal.throwIfAborted();
    // A template the caller may see but not manage answers the same way as one
    // that does not exist. Saying "you may read this but not change it" would
    // confirm a colleague's private row to someone who cannot act on it.
    if (!row || row.ownerUserId !== args.userId) {
      return { kind: "not-found" };
    }

    const uploads = await set(
      resolveTemplateUploads$,
      {
        ownerUserId: args.userId,
        orgId: args.orgId,
        ids: [args.packageFileId],
      },
      signal,
    );
    signal.throwIfAborted();
    const packageUpload = uploads.get(args.packageFileId);
    if (!packageUpload) {
      return rejected(`Uploaded file not found: ${args.packageFileId}`);
    }

    const packageResult = await set(
      loadTemplatePackage$,
      {
        upload: packageUpload,
        limits: packageLimitsFor(row.manifest.kind),
      },
      signal,
    );
    signal.throwIfAborted();
    if (packageResult.kind === "rejected") {
      return rejected(packageResult.message);
    }

    await set(
      uploadVolumeServerSide$,
      {
        orgId: args.orgId,
        storageName: getUserTemplateStorageName(row.id),
        files: packageResult.files.map((file) => {
          return { path: file.path, content: file.content };
        }),
      },
      signal,
    );
    signal.throwIfAborted();

    // Recorded after the package is in place, so a member who reads the row
    // and sees a new timestamp is looking at a template whose guidance has
    // already changed.
    const currentTime = nowDate();
    const [updated] = await db
      .update(userTemplates)
      .set({ updatedAt: currentTime, updatedBy: args.userId })
      .where(eq(userTemplates.id, row.id))
      .returning();
    signal.throwIfAborted();
    if (!updated) {
      throw new Error("Failed to record the user template package update");
    }
    return { kind: "replaced", row: updated };
  },
);
