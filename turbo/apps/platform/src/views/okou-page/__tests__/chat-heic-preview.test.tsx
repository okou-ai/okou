import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { artifactReferencePath } from "@okouai/api-contracts/validators/artifact-references";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_RUN_ID,
  ATTACHMENT_THREAD_ID,
  findNamedButton,
  findNamedLink,
  findNamedMenuItem,
  mockAttachmentChat,
} from "./chat-attachment-test-helpers.ts";

const context = testContext();

const STORAGE = "https://okou-uploads.example.r2.cloudflarestorage.com";

/** A presigned R2 object whose stored key no longer carries the filename. */
function signedObject(key: string, disposition?: string): string {
  const url = new URL(`${STORAGE}/uploads/${key}`);
  if (disposition) {
    url.searchParams.set("response-content-disposition", disposition);
  }
  url.searchParams.set("X-Amz-Expires", "3600");
  url.searchParams.set("X-Amz-Signature", `signature-${key}`);
  return url.href;
}

const HEIC_SOURCE = signedObject("7f3c91d2a4");
const HEIC_DOWNLOAD = signedObject(
  "7f3c91d2a4",
  'attachment; filename="photo.HEIC"',
);
const JPEG_SOURCE = signedObject("c25e8b0f16");

function serveSignedFiles(): void {
  const files = new Map([
    ["file-photo-heic", { url: HEIC_SOURCE, downloadUrl: HEIC_DOWNLOAD }],
    [
      "file-harbor-jpeg",
      {
        url: JPEG_SOURCE,
        downloadUrl: signedObject(
          "c25e8b0f16",
          'attachment; filename="harbor.jpg"',
        ),
      },
    ],
  ]);
  context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
    const file = files.get(query.file_id);
    if (!file) {
      return respond(404, {
        error: { code: "FILE_NOT_FOUND", message: "File not found" },
      });
    }
    return respond(200, {
      ...file,
      expiresAt: "2099-01-01T00:00:00.000Z",
      publicUrl: null,
    });
  });
}

/** A full-resolution converted rendition of the signed original. */
function expectConvertedOriginal(image: HTMLElement): void {
  const src = image.getAttribute("src") ?? "";
  const match = /^https:\/\/cdn\.vm7\.io\/cdn-cgi\/image\/([^/]+)\/(.+)$/u.exec(
    src,
  );
  expect(match?.[2]).toBe(HEIC_SOURCE);
  expect(match?.[1]).toContain("format=auto");
  expect(match?.[1]).not.toMatch(/(?:^|,)(?:width|height)=/u);
}

test("an iPhone photo opens at full resolution and downloads its original (image/heic, sidebar first=false)", async () => {
  mockAttachmentChat(context, {
    chatEvents: [
      {
        role: "user",
        content: "Which photo should go on the cover?",
        createdAt: "2026-03-10T00:00:00Z",
        fileParts: [
          {
            type: "file",
            fileId: "file-photo-heic",
            filenameSnapshot: "photo.HEIC",
            contentType: "image/heic",
          },
          {
            type: "file",
            fileId: "file-harbor-jpeg",
            filenameSnapshot: "harbor.jpg",
            contentType: "image/jpeg",
          },
        ],
      },
    ],
  });
  serveSignedFiles();
  const browser = context.mocks.browser.blobDownload();
  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ArtifactSidebarPreview]: false },
  });

  click(await findNamedLink("Preview photo.HEIC"));
  const lightbox = await screen.findByTestId("attachment-lightbox");
  await waitFor(() => {
    expectConvertedOriginal(
      within(lightbox).getByTestId("attachment-lightbox-image"),
    );
  });

  click(await findNamedButton("Next image artifact", lightbox));
  await waitFor(() => {
    expect(
      within(lightbox).getByTestId("attachment-lightbox-image"),
    ).toHaveAttribute("src", JPEG_SOURCE);
  });
  click(await findNamedButton("Previous image artifact", lightbox));
  await waitFor(() => {
    expectConvertedOriginal(
      within(lightbox).getByTestId("attachment-lightbox-image"),
    );
  });

  click(await findNamedButton("Open in split view", lightbox));
  const sidebar = await screen.findByTestId("artifact-sidebar");
  await waitFor(() => {
    expectConvertedOriginal(
      within(sidebar).getByTestId("artifact-sidebar-body-image"),
    );
  });
  click(await findNamedButton("Download artifact", sidebar));
  click(await findNamedMenuItem("Download"));

  await waitFor(() => {
    expect(
      browser.downloads.map(({ url, filename }) => {
        return { url, filename };
      }),
    ).toStrictEqual([{ url: HEIC_DOWNLOAD, filename: "photo.HEIC" }]);
  });
});

test("an inaccessible HEIC artifact keeps its access error in the image viewer", async () => {
  const reference = artifactReferencePath(
    "a7000000-0000-4000-a000-000000000c51",
    "photo.HEIC",
  );
  mockAttachmentChat(context, {
    chatEvents: [
      {
        role: "assistant",
        content: `Here is the [iPhone photo](${reference}) from the shoot.`,
        runId: ATTACHMENT_RUN_ID,
        runEventId: "heic-reference-event",
        sequenceNumber: 1,
        createdAt: "2026-03-10T00:00:01Z",
      },
    ],
  });
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(403, {
      error: { code: "FORBIDDEN", message: "Artifact access denied" },
    });
  });
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  click(await findNamedLink("iPhone photo"));

  const viewer = await screen.findByTestId("attachment-lightbox");
  await expect(
    within(viewer).findByRole("heading", {
      name: "You can’t view this artifact",
    }),
  ).resolves.toBeInTheDocument();
});
