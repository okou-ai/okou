import { command } from "ccstate";
import {
  MAX_PRESENTATION_TEMPLATE_PACKAGE_BYTES,
  MAX_PRESENTATION_TEMPLATE_PACKAGE_FILE_BYTES,
  MAX_PRESENTATION_TEMPLATE_PACKAGE_FILES,
  MAX_PRESENTATION_TEMPLATE_PAGE_BYTES,
  MAX_PRESENTATION_TEMPLATE_SOURCE_BYTES,
  MAX_PRESENTATION_TEMPLATE_TOTAL_PAGE_BYTES,
  PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE,
  PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPES,
  REQUIRED_PRESENTATION_TEMPLATE_PACKAGE_FILES,
  type PublishPresentationTemplateBody,
} from "@okouai/api-contracts/contracts/presentation-templates";
import { getPresentationTemplateStorageName } from "@okouai/core/storage-names";
import { presentationTemplates } from "@okouai/db/schema/presentation-template";

import { badRequestMessage } from "../../lib/error";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  checkTemplatePages,
  loadTemplatePackage$,
  resolveTemplateUploads$,
  type ResolvedUpload,
  type TemplatePackageLimits,
} from "./template-package.service";
import { uploadVolumeServerSide$ } from "./storage-volume-upload.service";

function checkSource(source: ResolvedUpload): string | null {
  const accepted: readonly string[] =
    PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPES;
  if (!accepted.includes(source.contentType)) {
    return `The source deck must be one of: ${accepted.join(", ")}`;
  }
  if (source.sizeBytes > MAX_PRESENTATION_TEMPLATE_SOURCE_BYTES) {
    return `The source deck must be ${MAX_PRESENTATION_TEMPLATE_SOURCE_BYTES.toString()} bytes or smaller`;
  }
  return null;
}

const PRESENTATION_TEMPLATE_PACKAGE_LIMITS: TemplatePackageLimits =
  Object.freeze({
    maxBytes: MAX_PRESENTATION_TEMPLATE_PACKAGE_BYTES,
    maxFiles: MAX_PRESENTATION_TEMPLATE_PACKAGE_FILES,
    maxFileBytes: MAX_PRESENTATION_TEMPLATE_PACKAGE_FILE_BYTES,
    requiredPaths: REQUIRED_PRESENTATION_TEMPLATE_PACKAGE_FILES,
  });

type PublishResult =
  | { readonly kind: "published"; readonly templateId: string }
  | {
      readonly kind: "rejected";
      readonly response: ReturnType<typeof badRequestMessage>;
    };

function rejected(message: string): PublishResult {
  return { kind: "rejected", response: badRequestMessage(message) };
}

/**
 * Turn a finished analysis into a ready template.
 *
 * The row is created already `ready`: nothing exists before a package has been
 * validated, so a failed analysis leaves no half-built template behind — only
 * the chat thread that explains what happened.
 */
export const publishPresentationTemplate$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly ownerUserId: string;
      readonly body: PublishPresentationTemplateBody;
    },
    signal: AbortSignal,
  ): Promise<PublishResult> => {
    const db = set(writeDb$);
    const { body } = args;
    const ids = [body.sourceFileId, ...body.pageFileIds, body.packageFileId];
    const uploads = await set(
      resolveTemplateUploads$,
      { ownerUserId: args.ownerUserId, orgId: args.orgId, ids },
      signal,
    );
    signal.throwIfAborted();

    const missing = ids.find((id) => {
      return !uploads.has(id);
    });
    if (missing) {
      return rejected(`Uploaded file not found: ${missing}`);
    }
    // Non-null: every id was just proven present.
    const source = uploads.get(body.sourceFileId)!;
    const packageUpload = uploads.get(body.packageFileId)!;
    const pages = body.pageFileIds.map((id) => {
      return uploads.get(id)!;
    });

    const sourceError = checkSource(source);
    if (sourceError) {
      return rejected(sourceError);
    }
    const pageError = checkTemplatePages(pages, {
      contentType: PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE,
      maxPageBytes: MAX_PRESENTATION_TEMPLATE_PAGE_BYTES,
      maxTotalBytes: MAX_PRESENTATION_TEMPLATE_TOTAL_PAGE_BYTES,
    });
    if (pageError) {
      return rejected(pageError);
    }
    const packageResult = await set(
      loadTemplatePackage$,
      { upload: packageUpload, limits: PRESENTATION_TEMPLATE_PACKAGE_LIMITS },
      signal,
    );
    signal.throwIfAborted();
    if (packageResult.kind === "rejected") {
      return rejected(packageResult.message);
    }
    const files = packageResult.files;

    const currentTime = nowDate();
    const [created] = await db
      .insert(presentationTemplates)
      .values({
        orgId: args.orgId,
        ownerUserId: args.ownerUserId,
        title: body.title,
        sourceStorageKey: source.storageKey,
        sourceFilename: source.filename,
        pageKeys: pages.map((page) => {
          return page.storageKey;
        }),
        createdBy: args.ownerUserId,
        updatedBy: args.ownerUserId,
        createdAt: currentTime,
        updatedAt: currentTime,
      })
      .returning();
    signal.throwIfAborted();
    if (!created) {
      throw new Error("Failed to create the presentation template");
    }

    // The package is stored under a name derived from the row id, so the
    // template needs no column pointing at it.
    await set(
      uploadVolumeServerSide$,
      {
        orgId: args.orgId,
        storageName: getPresentationTemplateStorageName(created.id),
        files,
      },
      signal,
    );
    signal.throwIfAborted();
    return { kind: "published", templateId: created.id };
  },
);
