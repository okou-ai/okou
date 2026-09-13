import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_RUN_ID,
  ATTACHMENT_THREAD_ID,
  artifactFile,
  findNamedLink,
  mockAttachmentChat,
  privateAttachmentUrl,
} from "./chat-attachment-test-helpers.ts";

const context = testContext();
const FILE_ID = "f0000000-0000-4000-a000-000000000946";
const FILENAME = "photo.BMP";
const ORIGINAL_URL =
  `https://${"a".repeat(32)}.r2.cloudflarestorage.com/private/photo%20%2B.BMP` +
  "?X-Amz-Signature=original&response-cache-control=private%2C%20no-store";

test.each(["assistant", "user"] as const)(
  "%s BMP images display the original in the thread and lightbox",
  async (role) => {
    const canonical =
      role === "assistant"
        ? artifactReferencePath(FILE_ID, FILENAME)
        : privateAttachmentUrl(FILE_ID);
    mockAttachmentChat(context, {
      artifacts: [
        artifactFile(FILENAME, {
          id: FILE_ID,
          contentType: "image/bmp",
          url: canonical,
        }),
      ],
      chatEvents: [
        {
          id: "bmp-preview-message",
          role,
          content: role === "assistant" ? `![${FILENAME}](${canonical})` : null,
          runId: ATTACHMENT_RUN_ID,
          runEventId: "bmp-preview-event",
          sequenceNumber: 1,
          createdAt: "2026-09-11T00:00:00.000Z",
          ...(role === "user"
            ? {
                userMessage: {
                  version: 1 as const,
                  parts: [
                    {
                      type: "file" as const,
                      fileId: FILE_ID,
                      filenameSnapshot: FILENAME,
                      contentType: "image/bmp",
                    },
                  ],
                },
              }
            : {}),
        },
      ],
    });
    let responseUrl = ORIGINAL_URL;
    const resolveOriginal = () => {
      const url = responseUrl;
      responseUrl = ORIGINAL_URL.replace("=original", "=reissued");
      return { url, expiresAt: "2026-09-13T00:00:00.000Z" };
    };
    context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
      return respond(200, {
        ...resolveOriginal(),
        filename: FILENAME,
        contentType: "image/bmp",
        target: { kind: "file", id: FILE_ID },
      });
    });
    context.mocks.api(webFilesContract.fileUrl, ({ respond }) => {
      return respond(200, { ...resolveOriginal(), publicUrl: null });
    });

    await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
    const image = await screen.findByAltText(FILENAME);
    await waitFor(() => {
      expect(image).toHaveAttribute("src", ORIGINAL_URL);
    });
    fireEvent.load(image);
    await waitFor(() => {
      expect(
        screen.queryByTestId(
          role === "assistant"
            ? "markdown-image-preview-loading"
            : "chat-image-preview-loading",
        ),
      ).toBeNull();
    });

    if (role === "user") {
      click(await findNamedLink(`Preview ${FILENAME}`));
    } else {
      click(image);
    }
    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
        "src",
        ORIGINAL_URL,
      );
    });
    expect(image).toHaveAttribute("src", ORIGINAL_URL);
  },
);
