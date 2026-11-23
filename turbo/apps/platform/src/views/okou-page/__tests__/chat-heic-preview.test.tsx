import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_RUN_ID,
  ATTACHMENT_THREAD_ID,
  artifactFile,
  findNamedButton,
  findNamedLink,
  findNamedMenuItem,
  mockAttachmentChat,
  privateAttachmentUrl,
} from "./chat-attachment-test-helpers.ts";

const context = testContext();
const R2_ORIGIN = `https://${"a".repeat(32)}.r2.cloudflarestorage.com`;

test.each([
  { contentType: "image/heic", storedName: "opaque" },
  {
    contentType: "application/octet-stream",
    storedName: "photo.HEIC",
  },
])(
  "an iPhone photo opens at full resolution and downloads its original ($contentType)",
  async ({ contentType, storedName }) => {
    const fileId = "iphone-photo";
    const filename = "photo.HEIC";
    const original = `${R2_ORIGIN}/private/${storedName}?X-Amz-Signature=signature&X-Amz-Credential=key%2Fauto%2Fs3`;
    const downloadUrl = `${original}&response-content-disposition=attachment`;
    const converted = `https://cdn.vm7.io/cdn-cgi/image/fit=scale-down,format=auto,quality=85,metadata=none/${original}`;
    const jpeg = `${R2_ORIGIN}/private/photo.jpg?X-Amz-Signature=jpeg`;
    const downloads = context.mocks.browser.blobDownload();
    mockAttachmentChat(context, {
      chatEvents: [
        {
          id: "iphone-photo-message",
          role: "user",
          content: null,
          runId: ATTACHMENT_RUN_ID,
          createdAt: "2026-03-10T00:00:01Z",
          userMessage: {
            version: 1,
            parts: [
              {
                type: "file",
                fileId,
                filenameSnapshot: filename,
                contentType,
              },
              {
                type: "file",
                fileId: "jpeg-photo",
                filenameSnapshot: "photo.jpg",
                contentType: "image/jpeg",
              },
            ],
          },
        },
      ],
      artifacts: [
        artifactFile(filename, {
          id: fileId,
          url: privateAttachmentUrl(fileId),
          contentType,
        }),
        artifactFile("photo.jpg", {
          id: "jpeg-photo",
          url: privateAttachmentUrl("jpeg-photo"),
          contentType: "image/jpeg",
        }),
      ],
    });
    context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
      const isHeic = query.file_id === fileId;
      return respond(200, {
        url: isHeic ? original : jpeg,
        downloadUrl: isHeic ? downloadUrl : jpeg,
        expiresAt: "2099-01-01T00:00:00.000Z",
        publicUrl: null,
      });
    });

    await setupPage({
      context,
      path: `/chats/${ATTACHMENT_THREAD_ID}`,
    });
    click(await findNamedLink(`Preview ${filename}`));
    const preview = await screen.findByTestId("artifact-sidebar");
    const imageTestId = "artifact-sidebar-body-image";
    await expect(
      within(preview).findByTestId(imageTestId),
    ).resolves.toHaveAttribute("src", converted);

    click(await findNamedButton("Next image artifact", preview));
    await waitFor(() => {
      expect(within(preview).getByTestId(imageTestId)).toHaveAttribute(
        "src",
        jpeg,
      );
    });
    click(await findNamedButton("Previous image artifact", preview));
    await waitFor(() => {
      expect(within(preview).getByTestId(imageTestId)).toHaveAttribute(
        "src",
        converted,
      );
    });
    await expect(
      within(preview).findByTestId("artifact-sidebar-body-image"),
    ).resolves.toHaveAttribute("src", converted);

    click(await findNamedButton("Download artifact", preview));
    click(await findNamedMenuItem("Download"));
    await waitFor(() => {
      expect(downloads.downloads).toHaveLength(1);
    });
    expect(downloads.downloads[0]).toMatchObject({
      filename,
      url: downloadUrl,
    });
  },
);

test("an inaccessible HEIC artifact keeps its access error in the image viewer", async () => {
  const url = "http://localhost/artifacts/abc123def0.heic";
  mockAttachmentChat(context, {
    chatEvents: [
      {
        id: "restricted-heic-message",
        role: "assistant",
        content: `[iPhone photo](${url})`,
        runId: ATTACHMENT_RUN_ID,
        runEventId: "restricted-heic-event",
        sequenceNumber: 1,
        createdAt: "2026-03-10T00:00:01Z",
      },
    ],
  });
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(403, {
      error: { code: "FORBIDDEN", message: "Artifact unavailable" },
    });
  });

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  click(await findNamedLink("iPhone photo"));
  const dialog = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(dialog).findByRole("heading", {
      name: "You can’t view this artifact",
    }),
  ).resolves.toBeInTheDocument();
});
