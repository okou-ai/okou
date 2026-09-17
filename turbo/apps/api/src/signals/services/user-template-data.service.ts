import { createHash } from "node:crypto";

import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import { CANONICAL_WORKING_DIR } from "@okouai/api-contracts/contracts/runners";
import { getUserTemplateStorageName } from "@okouai/core/storage-names";
import { userTemplateDirectory } from "@okouai/core/user-template-selection";
import type {
  UserTemplateKind,
  UserTemplateSummary,
} from "@okouai/api-contracts/contracts/user-templates";
import { userTemplates } from "@okouai/db/schema/user-template";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";

import type { ReadonlyDb } from "../external/db";
import type { PresentationTemplateVolume } from "./presentation-template-data.service";

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
 * One selected custom template, reduced to what a run needs: where to mount it
 * and what the package inside will turn out to be.
 */
export interface MountedUserTemplate {
  readonly templateId: string;
  readonly kind: UserTemplateKind;
}

/**
 * The custom templates one message names.
 *
 * Syntax only, and no database yet: the prompt builder rejects a selection
 * this run does not mount, so the candidate set has to be known before the
 * rows are read.
 */
export function selectedUserTemplateIds(
  generationTemplates: readonly GenerationTemplateRequest[],
): readonly string[] {
  const templateIds = new Set<string>();
  for (const template of generationTemplates) {
    if (template.type === "custom") {
      templateIds.add(template.selection.userTemplateId);
    }
  }
  return [...templateIds];
}

/**
 * The subset of those the caller may use, in selection order, each with the
 * kind its row says it is.
 *
 * The row is the authority for its own existence and visibility, and for what
 * it produces. A caller cannot claim a kind: an id that does not come back is
 * indistinguishable from an inaccessible template and from a deleted one, so
 * the answer cannot be used to probe which.
 */
export async function authorizedUserTemplates(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly templateIds: readonly string[];
    /**
     * Whether this member has the feature. Required rather than read here, so
     * every caller states it: the routes that read and write this catalog are
     * gated, but a send is not, and a crafted selection would otherwise reach
     * the table through a path with no gate of its own.
     */
    readonly enabled: boolean;
  },
): Promise<readonly MountedUserTemplate[]> {
  if (!args.enabled || args.templateIds.length === 0) {
    return [];
  }
  const rows = await db
    .select()
    .from(userTemplates)
    .where(
      and(
        inArray(userTemplates.id, [...args.templateIds]),
        accessibleWhere(args),
      ),
    );
  const byId = new Map(
    rows.map((row) => {
      return [row.id, row.manifest.kind];
    }),
  );
  return args.templateIds.flatMap((templateId) => {
    const kind = byId.get(templateId);
    return kind === undefined ? [] : [{ templateId, kind }];
  });
}

/**
 * The storage volumes that carry those templates' packages.
 *
 * Mounted under the working directory rather than the skills root because the
 * skills root is chosen per framework inside run creation, while the prompt
 * naming this path is built before a framework exists.
 */
export function userTemplateVolumes(
  mounted: readonly MountedUserTemplate[],
): readonly PresentationTemplateVolume[] {
  return mounted.map((template) => {
    return {
      name: getUserTemplateStorageName(template.templateId),
      mountPath: `${CANONICAL_WORKING_DIR}/${userTemplateDirectory(template.templateId)}`,
    };
  });
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
