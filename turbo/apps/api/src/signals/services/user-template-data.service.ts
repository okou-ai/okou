import { createHash } from "node:crypto";

import type {
  UserTemplateKind,
  UserTemplateSummary,
} from "@okouai/api-contracts/contracts/user-templates";
import { userTemplates } from "@okouai/db/schema/user-template";
import { and, desc, eq, or } from "drizzle-orm";
import { z } from "zod";

import type { ReadonlyDb } from "../external/db";

export type UserTemplateRow = typeof userTemplates.$inferSelect;

/**
 * Distinct from the presentation table's `ptp:`. The two tables have separate
 * id spaces, so an asset id minted for one must never resolve against the
 * other while both exist.
 */
const USER_TEMPLATE_PREVIEW_ASSET_PREFIX = "utp:";

interface UserTemplatePreviewAssetIdentity {
  readonly templateId: string;
  readonly storageVersionId: string;
}

/**
 * Give a rendered page a stable public identity without exposing its object
 * key. The hash follows the immutable page object if page order changes.
 */
export function userTemplatePreviewAssetId(
  templateId: string,
  objectKey: string,
): string {
  const storageVersionId = createHash("sha256")
    .update(objectKey)
    .digest("base64url");
  return `${USER_TEMPLATE_PREVIEW_ASSET_PREFIX}${templateId}:${storageVersionId}`;
}

export function parseUserTemplatePreviewAssetId(
  previewAssetId: string,
): UserTemplatePreviewAssetIdentity | null {
  if (!previewAssetId.startsWith(USER_TEMPLATE_PREVIEW_ASSET_PREFIX)) {
    return null;
  }
  const identity = previewAssetId.slice(
    USER_TEMPLATE_PREVIEW_ASSET_PREFIX.length,
  );
  const separator = identity.indexOf(":");
  const templateId = identity.slice(0, separator);
  const storageVersionId = identity.slice(separator + 1);
  if (
    separator === -1 ||
    !z.uuid().safeParse(templateId).success ||
    !/^[\w-]{43}$/.test(storageVersionId)
  ) {
    return null;
  }
  return { templateId, storageVersionId };
}

/**
 * The rendered pages this row owns, in page order. Element 0 is the cover.
 *
 * Every kind answers for itself rather than one being what the others fall
 * through to, so a kind added to the manifest union fails this switch until
 * someone says whether it has pages.
 */
export function userTemplatePageKeys(row: UserTemplateRow): readonly string[] {
  switch (row.manifest.kind) {
    case "presentation": {
      return row.manifest.pageKeys;
    }
    case "document": {
      return [];
    }
  }
}

/**
 * How many pages to report, or null for a kind that has none.
 *
 * Null rather than zero: a document template is its styles, so counting its
 * pages would report an emptiness it does not have.
 */
function userTemplatePageCount(row: UserTemplateRow): number | null {
  switch (row.manifest.kind) {
    case "presentation": {
      return row.manifest.pageKeys.length;
    }
    case "document": {
      return null;
    }
  }
}

function userTemplateKind(row: UserTemplateRow): UserTemplateKind {
  return row.manifest.kind;
}

export function userTemplateSummary(
  row: UserTemplateRow,
  coverUrl: string | null,
  userId: string,
): UserTemplateSummary {
  return {
    id: row.id,
    title: row.title,
    sourceFilename: row.sourceFilename,
    kind: userTemplateKind(row),
    coverUrl,
    pageCount: userTemplatePageCount(row),
    visibility: row.visibility,
    ownerUserId: row.ownerUserId,
    canManage: row.ownerUserId === userId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The caller's own rows plus every member's organization-visible ones.
 *
 * The row is the authority for its own existence and visibility: a template
 * that does not come back is indistinguishable from one that never existed, so
 * a caller cannot use the answer to probe which case it was.
 */
function accessibleWhere(args: {
  readonly orgId: string;
  readonly userId: string;
}) {
  return and(
    eq(userTemplates.orgId, args.orgId),
    or(
      eq(userTemplates.ownerUserId, args.userId),
      eq(userTemplates.visibility, "organization"),
    ),
  );
}

export async function loadAccessibleUserTemplate(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly templateId: string;
  },
): Promise<UserTemplateRow | null> {
  const [row] = await db
    .select()
    .from(userTemplates)
    .where(and(eq(userTemplates.id, args.templateId), accessibleWhere(args)))
    .limit(1);
  return row ?? null;
}

/**
 * Newest first, with no owner-first tier.
 *
 * The catalog exposes ownership as a filter the reader controls, so sorting
 * the reader's own rows to the top would compete with that filter and bury a
 * colleague's template the reader just went looking for.
 */
export async function listAccessibleUserTemplates(
  db: ReadonlyDb,
  args: { readonly orgId: string; readonly userId: string },
): Promise<readonly UserTemplateRow[]> {
  return await db
    .select()
    .from(userTemplates)
    .where(accessibleWhere(args))
    .orderBy(desc(userTemplates.createdAt));
}
