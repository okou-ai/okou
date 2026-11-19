import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_RUN_ID,
  ATTACHMENT_THREAD_ID,
  artifactFile,
  findNamedButton,
  findNamedLink,
  mockAttachmentChat,
  privateAttachmentUrl,
} from "./chat-attachment-test-helpers.ts";

const context = testContext();
const NOW = Date.parse("2026-09-09T00:00:00.000Z");
const FILE_ID = "f0000000-0000-4000-a000-000000000941";
const SECOND_ID = "f0000000-0000-4000-a000-000000000942";
const R2_ORIGIN = `https://${"a".repeat(32)}.r2.cloudflarestorage.com`;
const FIRST_URL = `${R2_ORIGIN}/private/photo%20%2B.png?X-Amz-Credential=key%2F20260911%2Fauto%2Fs3%2Faws4_request&X-Amz-Security-Token=token%2B%2F%3D&X-Amz-Signature=first&response-cache-control=private%2C%20no-store`;
const NEXT_URL = `${R2_ORIGIN}/private/photo.png?X-Amz-Signature=next`;
const THUMBNAIL_PREFIX =
  "https://cdn.vm7.io/cdn-cgi/image/width=800,height=720,fit=scale-down,format=auto,quality=85,metadata=none/";
const THUMBNAIL_URL = `${THUMBNAIL_PREFIX}${FIRST_URL}`;
const CANONICAL = artifactReferencePath(FILE_ID, "photo.png");

function mockPrivateImage() {
  mockNow(NOW, context.signal);
  mockAttachmentChat(context, {
    artifacts: [
      artifactFile("photo.png", {
        id: FILE_ID,
        contentType: "image/png",
        url: CANONICAL,
      }),
    ],
    chatEvents: [
      {
        id: "private-preview-message",
        role: "assistant",
        content: `![photo.png](${CANONICAL})`,
        runId: ATTACHMENT_RUN_ID,
        runEventId: "private-preview-event",
        sequenceNumber: 1,
        createdAt: "2026-09-09T00:00:00.000Z",
      },
    ],
  });
  let responseUrl = FIRST_URL;
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    const url = responseUrl;
    responseUrl = NEXT_URL;
    return respond(200, {
      downloadUrl: new URL("?download=1", url).href,
      url,
      expiresAt: "2026-09-11T00:00:00.000Z",
      filename: "photo.png",
      contentType: "image/png",
      target: { kind: "file", id: FILE_ID },
    });
  });
}

async function openChatThumbnail() {
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  const image = await screen.findByAltText("photo.png");
  await waitFor(() => {
    expect(image).toHaveAttribute("src", THUMBNAIL_URL);
  });
  return image;
}

async function expectPreviewOriginal(url: string) {
  await waitFor(() => {
    expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
      "src",
      url,
    );
  });
}

test("A relative production artifact reference shows a thumbnail and opens its original", async () => {
  mockPrivateImage();
  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    host: "app.okou.ai",
  });
  const image = await screen.findByAltText("photo.png");
  await waitFor(() => {
    expect(image).toHaveAttribute(
      "src",
      THUMBNAIL_URL.replace("https://cdn.vm7.io/", "https://a.okou.io/"),
    );
  });
  fireEvent.load(image);

  click(image);

  await expectPreviewOriginal(FIRST_URL);
});

test("Reopening an image preview reuses the original resolved for its thumbnail", async () => {
  mockPrivateImage();
  const image = await openChatThumbnail();
  fireEvent.load(image);

  click(image);
  await expectPreviewOriginal(FIRST_URL);
  click(await findNamedButton("Close"));
  await waitFor(() => {
    expect(screen.queryByTestId("attachment-lightbox")).toBeNull();
  });
  click(image);

  await expectPreviewOriginal(FIRST_URL);
  expect(screen.getByAltText("photo.png")).toHaveAttribute(
    "src",
    THUMBNAIL_URL,
  );
  expect(screen.queryByTestId("markdown-image-preview-loading")).toBeNull();
});

test("An uploaded private image without a public URL previews its resolved original", async () => {
  mockNow(NOW, context.signal);
  const url = privateAttachmentUrl(FILE_ID);
  mockAttachmentChat(context, {
    artifacts: [
      artifactFile("upload.png", {
        id: FILE_ID,
        contentType: "image/png",
        url,
      }),
    ],
    chatEvents: [
      {
        id: "uploaded-image-message",
        role: "user",
        content: null,
        runId: ATTACHMENT_RUN_ID,
        createdAt: "2026-09-09T00:00:00.000Z",
        userMessage: {
          version: 1,
          parts: [
            {
              type: "file",
              fileId: FILE_ID,
              filenameSnapshot: "upload.png",
              contentType: "image/png",
            },
          ],
        },
      },
    ],
  });
  let responseUrl = FIRST_URL;
  context.mocks.api(webFilesContract.fileUrl, ({ respond }) => {
    const resolved = responseUrl;
    responseUrl = NEXT_URL;
    return respond(200, {
      downloadUrl: new URL("?download=1", resolved).href,
      url: resolved,
      expiresAt: "2026-09-13T00:00:00.000Z",
      publicUrl: null,
    });
  });
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  const image = await screen.findByAltText("upload.png");
  await waitFor(() => {
    expect(image).toHaveAttribute("src", THUMBNAIL_URL);
  });
  expect(image.closest("a")).toHaveAttribute("href", FIRST_URL);

  click(await findNamedLink("Preview upload.png"));

  await expectPreviewOriginal(FIRST_URL);
  expect(image).toHaveAttribute("src", THUMBNAIL_URL);
});

test("Opening a previewed image in split view keeps its resolved original", async () => {
  mockPrivateImage();
  const image = await openChatThumbnail();
  click(image);
  const dialog = await screen.findByTestId("attachment-lightbox");
  await expect(
    within(dialog).findByTestId("attachment-lightbox-image"),
  ).resolves.toHaveAttribute("src", FIRST_URL);

  click(await findNamedButton("Open in split view"));

  const splitView = await screen.findByTestId("artifact-sidebar");
  await waitFor(() => {
    expect(within(splitView).getByAltText("photo.png")).toHaveAttribute(
      "src",
      FIRST_URL,
    );
  });
  expect(image).toHaveAttribute("src", THUMBNAIL_URL);
});

test("Navigating assistant images reuses the original each thread card resolved", async () => {
  mockNow(NOW, context.signal);
  const files = [
    { id: FILE_ID, filename: "photo.png", original: FIRST_URL },
    { id: SECOND_ID, filename: "second.png", original: NEXT_URL },
  ].map((file) => {
    return { ...file, url: artifactReferencePath(file.id, file.filename) };
  });
  mockAttachmentChat(context, {
    artifacts: files.map((file) => {
      return artifactFile(file.filename, {
        id: file.id,
        contentType: "image/png",
        url: file.url,
      });
    }),
    chatEvents: [
      {
        id: "two-private-images",
        role: "assistant",
        content: files
          .map((file) => {
            return `![${file.filename}](${file.url})`;
          })
          .join("\n\n"),
        runId: ATTACHMENT_RUN_ID,
        runEventId: "two-private-images-event",
        sequenceNumber: 1,
        createdAt: "2026-09-09T00:00:00.000Z",
      },
    ],
  });
  const resolvedIds = new Set<string>();
  context.mocks.api(
    artifactReferencesContract.resolve,
    ({ params, respond }) => {
      const file = files.find((candidate) => {
        return candidate.url.endsWith(params.reference);
      });
      if (!file) {
        throw new Error("Unexpected image reference");
      }
      const url = resolvedIds.has(file.id)
        ? `${R2_ORIGIN}/unexpected.png?X-Amz-Signature=reissued`
        : file.original;
      resolvedIds.add(file.id);
      return respond(200, {
        url,
        downloadUrl: new URL("?download=1", url).href,
        filename: file.filename,
        expiresAt: "2026-09-13T00:00:00.000Z",
        contentType: "image/png",
        target: { kind: "file", id: file.id },
      });
    },
  );
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  const first = await screen.findByAltText("photo.png");
  const second = await screen.findByAltText("second.png");
  await waitFor(() => {
    expect(first).toHaveAttribute("src", THUMBNAIL_URL);
    expect(second).toHaveAttribute("src", `${THUMBNAIL_PREFIX}${NEXT_URL}`);
  });

  click(first);
  await expectPreviewOriginal(FIRST_URL);
  click(await findNamedButton("Next image artifact"));
  await expectPreviewOriginal(NEXT_URL);
  click(await findNamedButton("Previous image artifact"));
  await expectPreviewOriginal(FIRST_URL);

  expect(first).toHaveAttribute("src", THUMBNAIL_URL);
  expect(second).toHaveAttribute("src", `${THUMBNAIL_PREFIX}${NEXT_URL}`);
});
