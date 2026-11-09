import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import type { PresentationTemplateSummary } from "@okouai/api-contracts/contracts/presentation-templates";
import { parseUserPresentationTemplateId } from "@okouai/core/presentation-template-selection";
import type { presentationTemplates } from "@okouai/db/schema/presentation-template";
import { createHash } from "node:crypto";
import { uuid } from "zod";

export type PresentationTemplateRow = typeof presentationTemplates.$inferSelect;

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
    !uuid().safeParse(templateId).success ||
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
