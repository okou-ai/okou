import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { appendCapturedPreviewBypassToUrl } from "../../lib/preview-bypass-cookie.ts";
import { resolveApiBase } from "../api-base.ts";
import type { RestorableAttachment } from "../okou-page/chat-draft.ts";

type UserMessageFileAttachment = Omit<RestorableAttachment, "url"> & {
  readonly url: string;
};

export function canonicalUserMessageFileUrl(fileId: string): string {
  const url = new URL("/api/web/file-url", resolveApiBase());
  url.searchParams.set("file_id", fileId);
  appendCapturedPreviewBypassToUrl(url);
  return url.toString();
}

/** Resolve the file parts without consulting legacy chat-event projections. */
export function userMessageFileAttachments(
  document: UserMessageDocument | undefined,
): UserMessageFileAttachment[] {
  return (document?.parts ?? []).flatMap((part) => {
    if (part.type !== "file") {
      return [];
    }
    return [
      {
        id: part.fileId,
        filename: part.filenameSnapshot,
        contentType: part.contentType,
        size: 0,
        url: canonicalUserMessageFileUrl(part.fileId),
        ...(part.annotatedFileId
          ? { annotatedFileId: part.annotatedFileId }
          : {}),
        ...(part.annotations ? { annotations: part.annotations } : {}),
      },
    ];
  });
}
