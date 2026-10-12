import { screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";

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
  publicArtifactUrl,
  privateAttachmentUrl,
} from "./chat-attachment-test-helpers.ts";

const context = testContext();

test.each([
  { filename: "report.png", contentType: "image/png" },
  { filename: "report.pdf", contentType: "application/pdf" },
])(
  "$filename remains downloadable when the browser reads bytes after the click",
  async ({ filename, contentType }) => {
    const url = publicArtifactUrl(filename);
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 255]);
    context.mocks.browser.requestCacheMode();
    mockAttachmentChat(context, {
      chatEvents: [
        {
          id: "download-report-message",
          role: "assistant",
          content: `[Report](${url})`,
          runId: ATTACHMENT_RUN_ID,
          runEventId: "download-report-event",
          sequenceNumber: 1,
          createdAt: "2026-03-10T00:00:01Z",
        },
      ],
      artifacts: [artifactFile(filename, { url, contentType })],
    });
    context.mocks.http.get(url, ({ request }) => {
      if (request.cache !== "reload") {
        return new HttpResponse(null, { status: 403 });
      }
      return HttpResponse.arrayBuffer(bytes.buffer, {
        headers: { "Content-Type": contentType },
      });
    });
    const browser = context.mocks.browser.blobDownload({ deferRead: true });

    await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
    click(await findNamedLink("Report"));
    const dialog = await screen.findByRole("dialog");
    click(await findNamedButton("Download options", dialog));
    click(await findNamedMenuItem("Download"));

    await waitFor(() => {
      expect(browser.downloads).toHaveLength(1);
    });
    const download = browser.downloads[0];
    expect(download?.filename).toBe(filename);
    expect(download?.blob?.type).toBe(contentType);
    const downloadedBytes = await download?.blob?.arrayBuffer();
    expect(new Uint8Array(downloadedBytes!)).toStrictEqual(bytes);
    expect(location.pathname).toBe(`/chats/${ATTACHMENT_THREAD_ID}`);

    click(await findNamedButton("Close", dialog));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(browser.blobForUrl(download!.url)).toBe(download?.blob);

    click(await findNamedButton("New chat"));
    await waitFor(() => {
      expect(location.pathname).not.toBe(`/chats/${ATTACHMENT_THREAD_ID}`);
      expect(browser.blobForUrl(download!.url)).toBeNull();
    });
  },
);

test.each([
  { filename: "photo.png", contentType: "image/png", webFile: false },
  { filename: "report.pdf", contentType: "application/pdf", webFile: false },
  { filename: "clip.mp4", contentType: "video/mp4", webFile: false },
  { filename: "voice.mp3", contentType: "audio/mpeg", webFile: false },
  { filename: "upload.png", contentType: "image/png", webFile: true },
])(
  "$filename downloads through a newly resolved attachment URL on every click",
  async ({ filename, contentType, webFile }) => {
    const id = "00000000-0000-4000-8000-000000000951";
    const url = webFile
      ? privateAttachmentUrl(id)
      : artifactReferencePath(id, filename);
    const previewUrl = `https://storage.example.test/preview/${filename}`;
    let downloadUrl = `https://storage.example.test/download/${filename}?grant=preview`;
    mockAttachmentChat(context, {
      chatEvents: [
        {
          id: "native-download-message",
          role: "assistant",
          content: `[Report](${url})`,
          runId: ATTACHMENT_RUN_ID,
          runEventId: "native-download-event",
          sequenceNumber: 1,
          createdAt: "2026-03-10T00:00:01Z",
        },
      ],
      artifacts: [artifactFile(filename, { id, url, contentType })],
    });
    context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
      return respond(200, {
        url: previewUrl,
        downloadUrl,
        expiresAt: "2099-01-01T00:00:00Z",
        filename,
        contentType,
        target: { kind: "file", id },
      });
    });
    context.mocks.api(webFilesContract.fileUrl, ({ respond }) => {
      return respond(200, {
        url: previewUrl,
        downloadUrl,
        expiresAt: "2099-01-01T00:00:00Z",
        publicUrl: null,
      });
    });
    const browser = context.mocks.browser.blobDownload();
    await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
    click(await findNamedLink("Report"));
    const dialog = await screen.findByRole("dialog");
    for (const grant of ["first-click", "second-click"]) {
      downloadUrl = `https://storage.example.test/download/${filename}?grant=${grant}`;
      click(await findNamedButton("Download options", dialog));
      click(await findNamedMenuItem("Download"));
      await waitFor(() => {
        expect(browser.downloads.at(-1)).toMatchObject({
          url: downloadUrl,
          filename,
          blob: null,
        });
      });
    }
    expect(browser.downloads).toHaveLength(2);
    expect(location.pathname).toBe(`/chats/${ATTACHMENT_THREAD_ID}`);
  },
);
