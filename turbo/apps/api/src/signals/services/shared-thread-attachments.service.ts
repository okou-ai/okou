import { randomUUID } from "node:crypto";
import { command } from "ccstate";
import {
  annotatedImageFilename,
  type UserMessageDocument,
  type UserMessagePart,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import type { SharedMessageAttachment } from "@okouai/api-contracts/contracts/shared-threads";

import {
  buildFileUrlFromKey,
  sanitizeArtifactFilename,
} from "../../lib/file-url";
import { uploadedArtifactObject } from "./uploaded-artifact.service";
import { copyPublicArtifactObject$ } from "../external/s3";

export interface SharedThreadAttachmentCopy {
  readonly isPrivate: boolean;
  readonly sourceBucket: string;
  readonly sourceKey: string;
  readonly key: string;
  readonly publicBrand: PublicBrand;
  readonly attachment: SharedMessageAttachment;
}

const prepareSharedThreadAttachment$ = command(
  async (
    { get },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly shareId: string;
      readonly publicBrand: PublicBrand;
      readonly part: Extract<UserMessagePart, { type: "file" }>;
    },
    signal: AbortSignal,
  ): Promise<SharedThreadAttachmentCopy> => {
    const fileId = args.part.annotatedFileId ?? args.part.fileId;
    const object = await get(
      uploadedArtifactObject({
        id: fileId,
        userId: args.userId,
        orgId: args.orgId,
      }),
    );
    signal.throwIfAborted();
    if (!object) {
      throw new Error(
        `Attachment is unavailable: ${args.part.filenameSnapshot}`,
      );
    }
    const filename = args.part.annotatedFileId
      ? annotatedImageFilename(args.part.filenameSnapshot)
      : args.part.filenameSnapshot;
    const key = `artifacts/shared-threads/${args.shareId}/${randomUUID()}-${sanitizeArtifactFilename(filename)}`;
    return {
      isPrivate: object.isPrivate,
      sourceBucket: object.bucket,
      sourceKey: object.key,
      key,
      publicBrand: args.publicBrand,
      attachment: {
        filename,
        contentType: object.contentType,
        size: object.size,
        url: object.isPrivate
          ? object.url
          : buildFileUrlFromKey(key, args.publicBrand),
      },
    };
  },
);

export const prepareSharedThreadMessageAttachments$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly shareId: string;
      readonly publicBrand: PublicBrand;
      readonly document: UserMessageDocument | null;
      readonly copies: Map<string, SharedThreadAttachmentCopy>;
    },
    signal: AbortSignal,
  ): Promise<SharedMessageAttachment[]> => {
    const attachments: SharedMessageAttachment[] = [];
    if (args.document === null) {
      return attachments;
    }
    for (const part of args.document.parts) {
      if (part.type !== "file") {
        continue;
      }
      const fileId = part.annotatedFileId ?? part.fileId;
      let copy = args.copies.get(fileId);
      if (!copy) {
        copy = await set(
          prepareSharedThreadAttachment$,
          { ...args, part },
          signal,
        );
        args.copies.set(fileId, copy);
      }
      attachments.push(copy.attachment);
    }
    return attachments;
  },
);

export const publishSharedThreadAttachments$ = command(
  async (
    { set },
    copies: Iterable<SharedThreadAttachmentCopy>,
    signal: AbortSignal,
  ) => {
    for (const copy of copies) {
      if (copy.isPrivate) {
        // The shared-thread policy snapshots these bytes in private storage.
        continue;
      }
      await set(
        copyPublicArtifactObject$,
        {
          sourceBucket: copy.sourceBucket,
          sourceKey: copy.sourceKey,
          key: copy.key,
          publicBrand: copy.publicBrand,
          filename: copy.attachment.filename,
          contentType: copy.attachment.contentType,
          size: copy.attachment.size,
        },
        signal,
      );
    }
  },
);
