import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifact,
  findArtifactAction,
} from "../../artifacts-page/__tests__/artifact-catalog-test-helpers.ts";
import {
  ATTACHMENT_RUN_ID,
  ATTACHMENT_THREAD_ID,
  artifactFile,
  draftAttachment,
  draftForAttachment,
  findNamedButton,
  findNamedLink,
  findNamedMenuItem,
  mockAttachmentChat,
  mockPrivateUrlSequence,
  userMessage,
} from "./chat-attachment-test-helpers.ts";

vi.hoisted(() => {
  // Product analytics resolves the deployment environment at module load.
  window.location.href = "https://app.okou.ai/";
});

const context = testContext();

function downloadEvents(telemetry: ReturnType<typeof context.mocks.posthog>) {
  return telemetry.events
    .filter((event) => {
      return event.name === "artifact_action_clicked";
    })
    .map((event) => {
      return event.properties;
    });
}

test("A hosted-site catalog download from the lightbox keeps its website type", async () => {
  const telemetry = context.mocks.posthog();
  const browser = context.mocks.browser.blobDownload();
  const title = "Confidential board review.png";
  const url = "https://catalog-download.okou.app/";
  const summary = artifact({ kind: "hosted-site", title });
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [summary], nextCursor: null });
  });
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(200, {
      ...summary,
      kind: "hosted-site",
      site: {
        id: "f0000000-0000-4000-a000-000000000982",
        slug: "catalog-download",
        publicSlug: "catalog-download",
        url,
        deploymentVersion: 1,
        entrypoint: "/index.html",
        spaFallback: false,
      },
    });
  });
  context.mocks.api(hostContract.files, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Publication unavailable" },
    });
  });
  context.mocks.http.get(url, () => {
    return HttpResponse.html("<!doctype html><h1>Board review</h1>");
  });

  await setupPage({
    context,
    path: "/artifacts",
    host: "app.okou.ai",
    featureSwitches: {
      [FeatureSwitchKey.ArtifactSidebarPreview]: false,
    },
  });
  click(await findArtifactAction(title));
  const preview = await screen.findByTestId("attachment-lightbox");
  click(await findNamedButton("Download options", preview));
  const menu = await screen.findByRole("menu");
  click(await findNamedMenuItem("Download", menu));

  await waitFor(() => {
    expect(browser.downloads).toHaveLength(1);
  });
  expect(browser.downloads[0]?.filename).toBe("Confidential board review.html");
  expect(downloadEvents(telemetry)).toStrictEqual([
    { action: "download", surface: "dialog", artifact_type: "website" },
  ]);
});

test("A generic chat file link records spreadsheet downloads from its preview and menu", async () => {
  const telemetry = context.mocks.posthog();
  const browser = context.mocks.browser.blobDownload();
  const filename = "forecast.bin";
  const id = "f0000000-0000-4000-a000-000000000983";
  const contentType =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const url = artifactReferencePath(id, filename);
  const downloadUrl = "https://storage.example.test/forecast?grant=private";
  mockAttachmentChat(context, {
    artifacts: [artifactFile(filename, { id, url, contentType })],
    chatEvents: [
      {
        id: "download-type-forecast-message",
        role: "assistant",
        content: `[Forecast](${url})`,
        runId: ATTACHMENT_RUN_ID,
        runEventId: "download-type-forecast-event",
        sequenceNumber: 1,
        createdAt: "2026-03-10T00:00:01Z",
      },
    ],
  });
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(200, {
      url: downloadUrl,
      downloadUrl,
      filename,
      contentType,
      expiresAt: "2099-01-01T00:00:00Z",
      target: { kind: "file", id },
    });
  });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    host: "app.okou.ai",
  });
  click(await findNamedLink("Forecast"));
  const preview = await screen.findByTestId("attachment-lightbox");
  click(await findNamedButton("Download", preview));
  await waitFor(() => {
    expect(browser.downloads).toHaveLength(1);
  });
  click(await findNamedButton("Download options", preview));
  click(await findNamedMenuItem("Download"));

  await waitFor(() => {
    expect(browser.downloads).toHaveLength(2);
  });
  expect(downloadEvents(telemetry)).toStrictEqual([
    {
      action: "download",
      surface: "file_preview",
      artifact_type: "spreadsheet",
    },
    { action: "download", surface: "dialog", artifact_type: "spreadsheet" },
  ]);
});

test("A MIME-only draft video download from its preview is recorded as video", async () => {
  const telemetry = context.mocks.posthog();
  const browser = context.mocks.browser.blobDownload();
  const filename = "recording";
  const attachment = draftAttachment(filename, {
    id: "download-type-draft-video",
    contentType: "video/mp4",
  });
  mockAttachmentChat(context, { draft: draftForAttachment(attachment) });
  mockPrivateUrlSequence(context, {
    [attachment.id]: ["https://files.example.test/recording?signature=private"],
  });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    host: "app.okou.ai",
  });
  click(await findNamedButton(`Open video preview for ${filename}`));
  const preview = await screen.findByTestId("attachment-lightbox");
  click(await findNamedButton("Download options", preview));
  click(await findNamedMenuItem("Download"));

  await waitFor(() => {
    expect(browser.downloads).toHaveLength(1);
  });
  expect(downloadEvents(telemetry)).toStrictEqual([
    { action: "download", surface: "dialog", artifact_type: "video" },
  ]);
});

test("A MIME-only sent audio attachment plays and downloads as audio in the sidebar", async () => {
  const telemetry = context.mocks.posthog();
  const browser = context.mocks.browser.blobDownload();
  const filename = "recording";
  const fileId = "download-type-sent-audio";
  const url = "https://files.example.test/audio?signature=private";
  mockAttachmentChat(context, {
    chatEvents: [
      {
        id: "download-type-sent-audio-message",
        role: "user",
        content: null,
        runId: ATTACHMENT_RUN_ID,
        createdAt: "2026-03-10T00:00:01Z",
        userMessage: userMessage([
          {
            type: "file",
            fileId,
            filenameSnapshot: filename,
            contentType: "audio/mpeg",
          },
        ]),
      },
    ],
  });
  mockPrivateUrlSequence(context, { [fileId]: [url] });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    host: "app.okou.ai",
    featureSwitches: {
      [FeatureSwitchKey.ArtifactSidebarPreview]: true,
    },
  });
  click(await findNamedButton(`Open audio preview for ${filename}`));
  const preview = await screen.findByTestId("artifact-sidebar");
  await waitFor(() => {
    expect(preview.querySelector("audio")).toHaveAttribute("src", url);
  });
  click(await findNamedButton("Download artifact", preview));
  click(await findNamedMenuItem("Download"));

  await waitFor(() => {
    expect(browser.downloads).toHaveLength(1);
  });
  expect(downloadEvents(telemetry)).toStrictEqual([
    { action: "download", surface: "page", artifact_type: "audio" },
  ]);
});
