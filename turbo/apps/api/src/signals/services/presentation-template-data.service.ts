import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import type { PresentationTemplateSummary } from "@okouai/api-contracts/contracts/presentation-templates";
import { CANONICAL_WORKING_DIR } from "@okouai/api-contracts/contracts/runners";
import {
  parseUserPresentationTemplateId,
  userPresentationTemplateDirectory,
} from "@okouai/core/presentation-template-selection";
import { getPresentationTemplateStorageName } from "@okouai/core/storage-names";
import { presentationTemplates } from "@okouai/db/schema/presentation-template";
import { and, desc, eq, or } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ReadonlyDb } from "../external/db";

export type PresentationTemplateRow = typeof presentationTemplates.$inferSelect;

export interface PresentationTemplateVolume {
  readonly name: string;
  readonly mountPath: string;
}

const PRESENTATION_TEMPLATE_PREVIEW_ASSET_PREFIX = "ptp:";

interface PresentationTemplatePreviewAssetIdentity {
  readonly templateId: string;
  readonly storageVersionId: string;
}

/**
 * Give a rendered page a stable public identity without exposing its object
 * key. The hash follows the immutable page object if page order changes.
 */
export function presentationTemplatePreviewAssetId(
  templateId: string,
  objectKey: string,
): string {
  const storageVersionId = createHash("sha256")
    .update(objectKey)
    .digest("base64url");
  return `${PRESENTATION_TEMPLATE_PREVIEW_ASSET_PREFIX}${templateId}:${storageVersionId}`;
}

export function parsePresentationTemplatePreviewAssetId(
  previewAssetId: string,
): PresentationTemplatePreviewAssetIdentity | null {
  if (!previewAssetId.startsWith(PRESENTATION_TEMPLATE_PREVIEW_ASSET_PREFIX)) {
    return null;
  }
  const identity = previewAssetId.slice(
    PRESENTATION_TEMPLATE_PREVIEW_ASSET_PREFIX.length,
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
 * Row ids for the uploaded templates a message selected, in selection order.
 *
 * Deduplicated: one row is one package and one mount, so attaching the same
 * template twice must not ask the run to mount it at the same path twice.
 *
 * Syntax only. A well-formed id says nothing about whether that row exists or
 * whether the sender may read it; that is decided by
 * the pick graph's authorized presentation template selection.
 */
export function selectedUserPresentationTemplateIds(
  generationTemplates: readonly GenerationTemplateRequest[],
): readonly string[] {
  const templateIds = new Set<string>();
  for (const template of generationTemplates) {
    if (template.type !== "presentation") {
      continue;
    }
    const rowId = parseUserPresentationTemplateId(
      template.selection.templateId,
    );
    if (rowId !== undefined) {
      templateIds.add(rowId);
    }
  }
  return [...templateIds];
}

/**
 * The storage volumes that carry those templates' guidance packages.
 *
 * Mounted under the working directory rather than the skills root because the
 * skills root is chosen per framework inside run creation, while the prompt
 * naming this path is built before a framework exists.
 */
export function userPresentationTemplateVolumes(
  templateIds: readonly string[],
): readonly PresentationTemplateVolume[] {
  return templateIds.map((templateId) => {
    return {
      name: getPresentationTemplateStorageName(templateId),
      mountPath: `${CANONICAL_WORKING_DIR}/${userPresentationTemplateDirectory(templateId)}`,
    };
  });
}

/**
 * Shape the optional run-body field, so a run with no uploaded template keeps
 * the compose-resolved volume list it would otherwise have had.
 */
export function additionalVolumesForRun(
  volumes: readonly PresentationTemplateVolume[],
): { additionalVolumes?: PresentationTemplateVolume[] } {
  return volumes.length === 0 ? {} : { additionalVolumes: [...volumes] };
}

export function presentationTemplateSummary(
  row: PresentationTemplateRow,
  coverUrl: string | null,
  userId: string,
): PresentationTemplateSummary {
  return {
    id: row.id,
    title: row.title,
    sourceFilename: row.sourceFilename,
    coverUrl,
    pageCount: row.pageKeys.length,
    visibility: row.visibility,
    canManage: row.ownerUserId === userId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function loadAccessiblePresentationTemplate(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly templateId: string;
  },
): Promise<PresentationTemplateRow | null> {
  const [row] = await db
    .select()
    .from(presentationTemplates)
    .where(
      and(
        eq(presentationTemplates.id, args.templateId),
        eq(presentationTemplates.orgId, args.orgId),
        or(
          eq(presentationTemplates.ownerUserId, args.userId),
          eq(presentationTemplates.visibility, "public"),
        ),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listAccessiblePresentationTemplates(
  db: ReadonlyDb,
  args: { readonly orgId: string; readonly userId: string },
): Promise<readonly PresentationTemplateRow[]> {
  return await db
    .select()
    .from(presentationTemplates)
    .where(
      and(
        eq(presentationTemplates.orgId, args.orgId),
        or(
          eq(presentationTemplates.ownerUserId, args.userId),
          eq(presentationTemplates.visibility, "public"),
        ),
      ),
    )
    .orderBy(
      desc(eq(presentationTemplates.ownerUserId, args.userId)),
      desc(presentationTemplates.createdAt),
    );
}
