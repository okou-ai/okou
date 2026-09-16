import { command } from "ccstate";
import {
  MAX_USER_TEMPLATE_PACKAGE_BYTES,
  MAX_USER_TEMPLATE_PACKAGE_FILE_BYTES,
  MAX_USER_TEMPLATE_PACKAGE_FILES,
  MAX_USER_TEMPLATE_PAGE_BYTES,
  MAX_USER_TEMPLATE_SOURCE_BYTES,
  MAX_USER_TEMPLATE_TOTAL_PAGE_BYTES,
  REQUIRED_USER_TEMPLATE_PACKAGE_FILES,
  USER_TEMPLATE_PAGE_CONTENT_TYPE,
  USER_TEMPLATE_SOURCE_CONTENT_TYPES,
  type PublishUserTemplateBody,
} from "@okouai/api-contracts/contracts/user-templates";
import { getUserTemplateStorageName } from "@okouai/core/storage-names";
import { userTemplates } from "@okouai/db/schema/user-template";

import { badRequestMessage } from "../../lib/error";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  loadTemplatePackage$,
  resolveTemplateUploads$,
  type ResolvedUpload,
  type TemplatePackageLimits,
} from "./template-package.service";
import { uploadVolumeServerSide$ } from "./storage-volume-upload.service";

const USER_TEMPLATE_PACKAGE_LIMITS: TemplatePackageLimits = Object.freeze({
  maxBytes: MAX_USER_TEMPLATE_PACKAGE_BYTES,
  maxFiles: MAX_USER_TEMPLATE_PACKAGE_FILES,
  maxFileBytes: MAX_USER_TEMPLATE_PACKAGE_FILE_BYTES,
  requiredPaths: REQUIRED_USER_TEMPLATE_PACKAGE_FILES,
});

function checkSource(source: ResolvedUpload): string | null {
  const accepted: readonly string[] = USER_TEMPLATE_SOURCE_CONTENT_TYPES;
  if (!accepted.includes(source.contentType)) {
    return `The source file must be one of: ${accepted.join(", ")}`;
  }
  if (source.sizeBytes > MAX_USER_TEMPLATE_SOURCE_BYTES) {
    return `The source file must be ${MAX_USER_TEMPLATE_SOURCE_BYTES.toString()} bytes or smaller`;
  }
  return null;
}

function checkPages(pages: readonly ResolvedUpload[]): string | null {
  const wrongType = pages.findIndex((page) => {
    return page.contentType !== USER_TEMPLATE_PAGE_CONTENT_TYPE;
  });
  if (wrongType !== -1) {
    return `Page ${(wrongType + 1).toString()} must be a ${USER_TEMPLATE_PAGE_CONTENT_TYPE}`;
  }
  const oversized = pages.findIndex((page) => {
    return page.sizeBytes > MAX_USER_TEMPLATE_PAGE_BYTES;
  });
  if (oversized !== -1) {
    return `Page ${(oversized + 1).toString()} must be no larger than ${MAX_USER_TEMPLATE_PAGE_BYTES.toString()} bytes`;
  }
  const total = pages.reduce((sum, page) => {
    return sum + page.sizeBytes;
  }, 0);
  if (total > MAX_USER_TEMPLATE_TOTAL_PAGE_BYTES) {
    return `Page images must total ${MAX_USER_TEMPLATE_TOTAL_PAGE_BYTES.toString()} bytes or fewer`;
  }
  return null;
}

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
 * Turn a finished reverse run into a ready template.
 *
 * The row is created already usable: nothing exists before a package has been
 * validated, so a failed reverse leaves no half-built template behind — only
 * the chat thread that explains what happened.
 */
export const publishUserTemplate$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly ownerUserId: string;
      readonly body: PublishUserTemplateBody;
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
    const pageError = checkPages(pages);
    if (pageError) {
      return rejected(pageError);
    }

    const packageResult = await set(
      loadTemplatePackage$,
      { upload: packageUpload, limits: USER_TEMPLATE_PACKAGE_LIMITS },
      signal,
    );
    signal.throwIfAborted();
    if (packageResult.kind === "rejected") {
      return rejected(packageResult.message);
    }

    const currentTime = nowDate();
    const [created] = await db
      .insert(userTemplates)
      .values({
        orgId: args.orgId,
        ownerUserId: args.ownerUserId,
        title: body.title,
        sourceStorageKey: source.storageKey,
        sourceFilename: source.filename,
        manifest: {
          kind: body.kind,
          pageKeys: pages.map((page) => {
            return page.storageKey;
          }),
        },
        createdBy: args.ownerUserId,
        updatedBy: args.ownerUserId,
        createdAt: currentTime,
        updatedAt: currentTime,
      })
      .returning();
    signal.throwIfAborted();
    if (!created) {
      throw new Error("Failed to create the user template");
    }

    // The package is stored under a name derived from the row id, so the
    // template needs no column pointing at it.
    await set(
      uploadVolumeServerSide$,
      {
        orgId: args.orgId,
        storageName: getUserTemplateStorageName(created.id),
        files: packageResult.files.map((file) => {
          return { path: file.path, content: file.content };
        }),
      },
      signal,
    );
    signal.throwIfAborted();
    return { kind: "published", templateId: created.id };
  },
);
