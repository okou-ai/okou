import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";

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

vi.hoisted(() => {
  // Product analytics resolves the deployment environment at module load.
  window.location.href = "https://app.okou.ai/";
});

const context = testContext();
const ARTIFACT_ID = "00000000-0000-4000-8000-000000000951";

function mockReportMessage(
  url: string,
  filename: string,
  contentType: string,
  id?: string,
) {
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
    artifacts: [artifactFile(filename, { id, url, contentType })],
  });
}

async function openReportPreview() {
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  click(await findNamedLink("Report"));
  return screen.findByRole("dialog");
}

async function chooseDownload(dialog: HTMLElement) {
  click(await findNamedButton("Download options", dialog));
  click(await findNamedMenuItem("Download"));
}

test.each([
  { filename: "report.png", contentType: "image/png" },
  { filename: "report.pdf", contentType: "application/pdf" },
])(
  "$filename stays downloadable when the browser reads its bytes after the click",
  async ({ filename, contentType }) => {
    const url = publicArtifactUrl(filename);
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 255]);
    context.mocks.data.availableRunModels([]);
    context.mocks.browser.requestCacheMode();
    mockReportMessage(url, filename, contentType);
    context.mocks.http.get(url, ({ request }) => {
      if (request.cache !== "reload") {
        return new HttpResponse(null, { status: 403 });
      }
      return HttpResponse.arrayBuffer(bytes.buffer, {
        headers: { "Content-Type": contentType },
      });
    });
    const browser = context.mocks.browser.blobDownload({ deferRead: true });
    const dialog = await openReportPreview();

    await chooseDownload(dialog);

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
  { filename: "photo.png", contentType: "image/png", artifactType: "image" },
  {
    filename: "report.pdf",
    contentType: "application/pdf",
    artifactType: "pdf",
  },
  {
    filename: "proposal.DOCX",
    contentType: "application/octet-stream",
    artifactType: "document",
  },
])(
  "$filename downloads through a newly granted URL on every click",
  async ({ filename, contentType, artifactType }) => {
    const telemetry = context.mocks.posthog();
    const url = artifactReferencePath(ARTIFACT_ID, filename);
    let downloadUrl = `https://storage.example.test/download/${filename}?grant=preview`;
    mockReportMessage(url, filename, contentType, ARTIFACT_ID);
    context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
      return respond(200, {
        url: `https://storage.example.test/preview/${filename}`,
        downloadUrl,
        expiresAt: "2099-01-01T00:00:00Z",
        filename,
        contentType,
        target: { kind: "file", id: ARTIFACT_ID },
      });
    });
    const browser = context.mocks.browser.blobDownload();
    const dialog = await openReportPreview();

    for (const grant of ["first-click", "second-click"]) {
      downloadUrl = `https://storage.example.test/download/${filename}?grant=${grant}`;
      await chooseDownload(dialog);
      await waitFor(() => {
        expect(browser.downloads.at(-1)).toMatchObject({
          url: downloadUrl,
          filename,
        });
      });
    }

    expect(browser.downloads).toHaveLength(2);
    expect(location.pathname).toBe(`/chats/${ATTACHMENT_THREAD_ID}`);
    expect(
      telemetry.events
        .filter((event) => {
          return event.name === "artifact_action_clicked";
        })
        .map((event) => {
          return event.properties;
        }),
    ).toStrictEqual([
      { action: "download", surface: "dialog", artifact_type: artifactType },
      { action: "download", surface: "dialog", artifact_type: artifactType },
    ]);
  },
);

test("A server-denied download keeps the preview available and opens the plans", async () => {
  const filename = "report.pdf";
  mockReportMessage(
    artifactReferencePath(ARTIFACT_ID, filename),
    filename,
    "application/pdf",
    ARTIFACT_ID,
  );
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(200, {
      url: "https://storage.example.test/preview/report.pdf",
      downloadUrl: `https://api.okou.ai/api/artifact-references/${ARTIFACT_ID.replaceAll("-", "")}/download`,
      downloadAllowed: false,
      expiresAt: "2099-01-01T00:00:00Z",
      filename,
      contentType: "application/pdf",
      target: { kind: "file", id: ARTIFACT_ID },
    });
  });
  const browser = context.mocks.browser.blobDownload();
  const preview = await openReportPreview();

  await chooseDownload(preview);

  await expect(
    screen.findByRole("dialog", { name: "Choose a plan" }),
  ).resolves.toBeInTheDocument();
  expect(preview).toBeInTheDocument();
  expect(browser.downloads).toStrictEqual([]);
});
