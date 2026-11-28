import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { setupPage } from "../../../__tests__/page-helper.ts";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  mockAttachmentChat,
  ATTACHMENT_THREAD_ID,
  type AttachmentChatEvent,
} from "./chat-attachment-test-helpers.ts";

export function attachment(
  filename: string,
  contentType: string,
  id: string = crypto.randomUUID(),
) {
  const path = artifactReferencePath(id, filename);
  return {
    id,
    filename,
    contentType,
    path,
    url:
      "https://cdn.okou.io/artifacts/review/session/" +
      filename +
      "?revision=first",
  };
}
type PreviewFile = ReturnType<typeof attachment>;
export function fileParts(files: PreviewFile[]) {
  return files.map((f) => {
    return {
      type: "file" as const,
      fileId: f.id,
      filenameSnapshot: f.filename,
      contentType: f.contentType,
    };
  });
}
export function userRow(
  parts: UserMessageDocument["parts"],
): AttachmentChatEvent {
  return {
    role: "user",
    content: null,
    createdAt: "2026-09-04T10:00:00Z",
    userMessage: { version: 1, parts },
  };
}
export function assistantRow(content: string): AttachmentChatEvent {
  return { role: "assistant", content, createdAt: "2026-09-04T10:02:00Z" };
}
export function serveUploaded(context: TestContext, files: PreviewFile[]) {
  context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
    const file = files.find((f) => {
      return f.id === query.file_id;
    });
    if (!file) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Unknown file" },
      });
    }
    return respond(200, {
      url: file.url,
      downloadUrl: file.url,
      expiresAt: "2099-01-01T00:00:00.000Z",
      publicUrl: null,
    });
  });
}
export function serveReference(
  context: TestContext,
  file: PreviewFile,
  previewImageUrl?: string,
) {
  context.mocks.api(
    artifactReferencesContract.resolve,
    ({ params, respond }) => {
      if (file.path !== "/artifacts/" + params.reference) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Missing reference" },
        });
      }
      return respond(200, {
        artifactId: file.id,
        url: file.url,
        downloadUrl: file.url,
        filename: file.filename,
        contentType: file.contentType,
        expiresAt: "2099-01-01T00:00:00.000Z",
        target: {
          kind: file.contentType === "text/html" ? "html" : "file",
          id: file.id,
        },
        previewImageUrl,
      });
    },
  );
}
export async function conversation(
  context: TestContext,
  options: NonNullable<Parameters<typeof mockAttachmentChat>[1]>,
) {
  mockAttachmentChat(context, options);
  await setupPage({
    context,
    path: "/chats/" + ATTACHMENT_THREAD_ID,
    host: "app.okou.ai",
  });
}
