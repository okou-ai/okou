import { command } from "ccstate";
import { userTemplates } from "@okouai/db/schema/user-template";
import { and, eq, getTableColumns, isNull, or, sql } from "drizzle-orm";

import { pgTextDecoder } from "../../lib/db-structured-result";
import { badRequestMessage } from "../../lib/error";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import {
  loadTemplatePackage$,
  resolveTemplateUploads$,
} from "./template-package.service";
import type { UserTemplateRow } from "./user-template-data.service";
import { packageLimitsFor } from "./user-template-publish.service";
import { publishTemplateGuidanceBundle$ } from "./template-guidance-bundle.service";

type RepackageResult =
  | { readonly kind: "replaced"; readonly row: UserTemplateRow }
  | { readonly kind: "not-found" }
  | { readonly kind: "conflict" }
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
 * Each publication is a complete immutable archive. Files removed by the
 * rebuild are absent from the replacement; retained Runs keep their captured
 * archive rather than following the owner's later pointer.
 */
export const replaceUserTemplatePackage$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly templateId: string;
      readonly packageFileId: string;
    },
    signal: AbortSignal,
  ): Promise<RepackageResult> => {
    const db = set(writeDb$);
    const [selectedRow] = await get(db$)
      .select({
        ...getTableColumns(userTemplates),
        // Date decoding loses the microseconds written by metadata edits.
        observedUpdatedAt: sql`${userTemplates.updatedAt}::text`.mapWith(
          pgTextDecoder,
        ),
      })
      .from(userTemplates)
      .where(
        and(
          eq(userTemplates.id, args.templateId),
          and(
            eq(userTemplates.orgId, args.orgId),
            or(
              eq(userTemplates.ownerUserId, args.userId),
              eq(userTemplates.visibility, "organization"),
            ),
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    const row = selectedRow ?? null;
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

    const guidanceBundle = await set(
      publishTemplateGuidanceBundle$,
      packageResult.files,
      signal,
    );
    signal.throwIfAborted();

    // Publish bytes first, then switch only the owner revision we selected.
    // Outgoing prepared APIs also compare the pointer before invalidating it.
    const currentTime = nowDate();
    const [updated] = await db
      .update(userTemplates)
      .set({
        updatedAt: currentTime,
        updatedBy: args.userId,
        guidanceBundle,
      })
      .where(
        and(
          eq(userTemplates.id, row.id),
          eq(userTemplates.orgId, args.orgId),
          eq(userTemplates.ownerUserId, args.userId),
          eq(userTemplates.updatedAt, sql`${row.observedUpdatedAt}::timestamp`),
          row.guidanceBundle === null
            ? isNull(userTemplates.guidanceBundle)
            : eq(userTemplates.guidanceBundle, row.guidanceBundle),
        ),
      )
      .returning();
    signal.throwIfAborted();
    if (!updated) {
      return { kind: "conflict" };
    }
    return { kind: "replaced", row: updated };
  },
);
