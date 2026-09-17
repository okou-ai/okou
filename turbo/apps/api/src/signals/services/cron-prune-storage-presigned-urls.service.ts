import { command } from "ccstate";
import { writeDb$ } from "../external/db";
import {
  PRESENTATION_TEMPLATE_PREVIEW_PRESIGNED_URL_PRUNE_LIMIT,
  pruneStoragePresignedUrls$,
  READ_ONLY_STORAGE_PRESIGNED_URL_PRUNE_LIMIT,
  SYSTEM_STORAGE_PRESIGNED_URL_PRUNE_LIMIT,
  WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_PRUNE_LIMIT,
} from "./system-storage-presigned-url-cache.service";
export const pruneStoragePresignedUrlCache$ = command(
  async ({ set }, signal: AbortSignal) => {
    const db = set(writeDb$);
    const [system, workflowSkill, readOnly, presentationTemplatePreview] =
      await Promise.all([
        set(
          pruneStoragePresignedUrls$,
          {
            db,
            scope: "system_storage",
            limit: SYSTEM_STORAGE_PRESIGNED_URL_PRUNE_LIMIT,
          },
          signal,
        ),
        set(
          pruneStoragePresignedUrls$,
          {
            db,
            scope: "workflow_skill_storage",
            limit: WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_PRUNE_LIMIT,
          },
          signal,
        ),
        set(
          pruneStoragePresignedUrls$,
          {
            db,
            scope: "readonly_storage",
            limit: READ_ONLY_STORAGE_PRESIGNED_URL_PRUNE_LIMIT,
          },
          signal,
        ),
        set(
          pruneStoragePresignedUrls$,
          {
            db,
            scope: "presentation_template_preview",
            limit: PRESENTATION_TEMPLATE_PREVIEW_PRESIGNED_URL_PRUNE_LIMIT,
          },
          signal,
        ),
      ]);
    signal.throwIfAborted();
    return { system, workflowSkill, readOnly, presentationTemplatePreview };
  },
);
