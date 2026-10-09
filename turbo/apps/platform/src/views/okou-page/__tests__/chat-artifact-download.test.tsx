import { screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
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
  publicArtifactUrl,
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
    context.mocks.http.get(url, () => {
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
