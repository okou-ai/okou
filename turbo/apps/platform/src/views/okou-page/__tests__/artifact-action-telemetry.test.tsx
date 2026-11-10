import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  testContext,
  warmMermaidParser,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  artifact,
  findArtifactAction,
} from "../../artifacts-page/__tests__/artifact-catalog-test-helpers.ts";
import {
  SHARED_THREAD_ID,
  sharedThread,
} from "../../shared-thread-page/__tests__/shared-thread-test-helpers.ts";
import {
  ATTACHMENT_RUN_ID,
  ATTACHMENT_THREAD_ID,
  artifactFile,
  findNamedButton,
  findNamedLink,
  findNamedMenuItem,
  getNamedButton,
  mockAttachmentChat,
  mockPrivateUrlSequence,
  publicArtifactUrl,
  userMessage,
} from "./chat-attachment-test-helpers.ts";

vi.hoisted(() => {
  // Product analytics resolves the deployment environment at module load.
  window.location.href = "https://app.okou.ai/";
});

const context = testContext();
warmMermaidParser();
const CREATED_AT = "2026-03-10T00:00:01Z";

function artifactActions(posthog: ReturnType<typeof context.mocks.posthog>) {
  return posthog.events
    .filter((event) => {
      return event.name === "artifact_action_clicked";
    })
    .map((event) => {
      return event.properties;
    });
}

test("A generic catalog preview counts body and menu downloads, not opening them", async () => {
  const posthog = context.mocks.posthog();
  const browser = context.mocks.browser.blobDownload();
  const filename = "confidential-release-bundle.zip";
  const url = `https://artifacts.example.com/${filename}?signature=private-token`;
  const summary = artifact({ title: filename });
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [summary], nextCursor: null });
  });
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(200, {
      ...summary,
      kind: "file",
      file: {
        id: "f0000000-0000-4000-a000-000000000002",
        filename,
        contentType: "application/zip",
        size: 2048,
        url,
        previewImageUrl: null,
      },
    });
  });

  await setupPage({
    context,
    path: "/artifacts?tab=file",
    host: "app.okou.ai",
  });
  click(await findArtifactAction(filename));
  const dialog = await screen.findByTestId("attachment-lightbox");
  await expect(
    within(dialog).findByText("No inline preview available for this file."),
  ).resolves.toBeInTheDocument();
  expect(artifactActions(posthog)).toStrictEqual([]);

  click(getNamedButton("Download", dialog));

  await waitFor(() => {
    expect(browser.downloads).toHaveLength(1);
  });
  expect(browser.downloads[0]).toStrictEqual({ filename, url, blob: null });
  // Exact custom properties exclude filenames, signed URLs and other file data.
  expect(artifactActions(posthog)).toStrictEqual([
    { action: "download", surface: "file_preview" },
  ]);

  click(getNamedButton("Download options", dialog));
  const menu = await screen.findByRole("menu");
  expect(artifactActions(posthog)).toStrictEqual([
    { action: "download", surface: "file_preview" },
  ]);
  click(await findNamedMenuItem("Download", menu));

  await waitFor(() => {
    expect(browser.downloads).toHaveLength(2);
  });
  expect(browser.downloads[1]).toStrictEqual({ filename, url, blob: null });
  expect(artifactActions(posthog)).toStrictEqual([
    { action: "download", surface: "file_preview" },
    { action: "download", surface: "dialog" },
  ]);
});

test("An Office chip opens a preview without intent; a generic attachment chip downloads", async () => {
  const posthog = context.mocks.posthog();
  const browser = context.mocks.browser.blobDownload();
  const files = [
    {
      id: "intent-binary",
      filename: "confidential-forecast.bin",
      contentType: "application/octet-stream",
    },
    {
      id: "intent-office",
      filename: "confidential-strategy.docx",
      contentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
  ];
  const binaryUrl = "https://private-files.example/confidential-forecast.bin";
  mockAttachmentChat(context, {
    chatEvents: [
      {
        id: "artifact-intent-user-message",
        role: "user",
        content: null,
        runId: ATTACHMENT_RUN_ID,
        createdAt: CREATED_AT,
        userMessage: userMessage([
          ...files.map((file) => {
            return {
              type: "file" as const,
              fileId: file.id,
              filenameSnapshot: file.filename,
              contentType: file.contentType,
            };
          }),
          { type: "text", text: "Private board review materials" },
        ]),
      },
    ],
  });
  mockPrivateUrlSequence(
    context,
    {
      "intent-binary": [binaryUrl],
      "intent-office": [
        "https://private-files.example/confidential-strategy.docx",
      ],
    },
    { "intent-office": publicArtifactUrl("confidential-strategy.docx") },
  );

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    host: "app.okou.ai",
  });
  click(await findNamedButton("Preview confidential-strategy.docx"));
  const dialog = await screen.findByTestId("attachment-lightbox");
  await expect(
    within(dialog).findByTitle("confidential-strategy.docx preview"),
  ).resolves.toHaveAttribute(
    "src",
    expect.stringContaining("https://view.officeapps.live.com/op/embed.aspx?"),
  );
  expect(artifactActions(posthog)).toStrictEqual([]);
  expect(browser.downloads).toStrictEqual([]);

  click(getNamedButton("Close", dialog));
  await waitFor(() => {
    expect(screen.queryByTestId("attachment-lightbox")).not.toBeInTheDocument();
  });
  click(await findNamedButton("Download confidential-forecast.bin"));

  await waitFor(() => {
    expect(browser.downloads).toHaveLength(1);
  });
  expect(browser.downloads[0]).toStrictEqual({
    filename: "confidential-forecast.bin",
    url: `${binaryUrl}?download=1`,
    blob: null,
  });
  expect(artifactActions(posthog)).toStrictEqual([
    { action: "download", surface: "attachment_chip" },
  ]);
});

test("A shared-thread viewer reports its independent download, not preview or fullscreen", async () => {
  const posthog = context.mocks.posthog();
  const browser = context.mocks.browser.blobDownload();
  const reference = "https://app.okou.ai/artifacts/lightvid01.mp4";
  const previewUrl =
    "https://storage.example.test/private-launch.mp4?grant=preview";
  const freshUrl =
    "https://storage.example.test/private-launch.mp4?grant=download";
  let downloadUrl = `${freshUrl}-stale`;
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(
      200,
      sharedThread({
        messages: [
          {
            messageIndex: 0,
            role: "assistant",
            content: `![Private launch](${reference})`,
          },
        ],
      }),
    );
  });
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(200, {
      url: previewUrl,
      downloadUrl,
      filename: "lightvid01.mp4",
      contentType: "video/mp4",
      expiresAt: "2099-01-01T00:00:00Z",
      target: { kind: "file", id: "f0000000-0000-4000-a000-000000000942" },
    });
  });

  await setupPage({
    context,
    path: `/share/threads/${SHARED_THREAD_ID}`,
    host: "app.okou.ai",
  });
  click(await screen.findByTestId("markdown-artifact-preview-video"));
  const dialog = await screen.findByTestId("public-artifact-lightbox");
  await waitFor(() => {
    expect(dialog.querySelector("video")).toHaveAttribute("src", previewUrl);
  });
  click(getNamedButton("Enter fullscreen", dialog));
  await waitFor(() => {
    expect(dialog).toHaveAttribute("data-mode", "fullscreen");
  });
  expect(artifactActions(posthog)).toStrictEqual([]);

  downloadUrl = freshUrl;
  const download = getNamedButton("Download", dialog);
  expect(download).toBeEnabled();
  click(download);

  await waitFor(() => {
    expect(browser.downloads).toHaveLength(1);
  });
  expect(browser.downloads[0]).toStrictEqual({
    filename: "lightvid01.mp4",
    url: freshUrl,
    blob: null,
  });
  expect(artifactActions(posthog)).toStrictEqual([
    { action: "download", surface: "shared_preview" },
  ]);
});

test("An expanded diagram reports only its download, never its document or source", async () => {
  const posthog = context.mocks.posthog();
  const browser = context.mocks.browser.blobDownload();
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
    1600,
  );
  vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(
    900,
  );
  const filename = "private-deployment-notes.md";
  const url = publicArtifactUrl(filename);
  context.mocks.http.get(url, () => {
    return HttpResponse.text(
      "# Private deployment notes\n\n```mermaid\nflowchart LR\n  PrivateBuild --> PrivateDeploy\n```",
    );
  });
  mockAttachmentChat(context, {
    chatEvents: [
      {
        id: "artifact-intent-diagram-message",
        role: "assistant",
        content: `[Private deployment notes](${url})`,
        runId: ATTACHMENT_RUN_ID,
        runEventId: "artifact-intent-diagram-event",
        sequenceNumber: 1,
        createdAt: CREATED_AT,
      },
    ],
    artifacts: [artifactFile(filename, { contentType: "text/markdown" })],
  });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    host: "app.okou.ai",
  });
  click(await findNamedLink("Private deployment notes"));
  const documentDialog = await screen.findByTestId("attachment-lightbox");
  await within(documentDialog).findByRole("img", { name: "Diagram" });
  click(within(documentDialog).getByText("Diagram source"));
  expect(
    within(documentDialog).getByText(/PrivateBuild --> PrivateDeploy/),
  ).toBeInTheDocument();
  click(getNamedButton("Expand diagram", documentDialog));
  const diagram = await screen.findByTestId("artifact-diagram-lightbox");
  const expandedUrl = within(diagram)
    .getByAltText("diagram.svg")
    .getAttribute("src");
  click(getNamedButton("Fill view", diagram));
  await waitFor(() => {
    expect(diagram).toHaveAttribute("data-mode", "fullscreen");
  });
  expect(artifactActions(posthog)).toStrictEqual([]);

  click(getNamedButton("Download", diagram));

  await waitFor(() => {
    expect(browser.downloads).toHaveLength(1);
  });
  expect(browser.downloads[0]).toMatchObject({
    filename: "diagram.svg",
    url: expandedUrl,
  });
  expect(browser.downloads[0]?.blob?.type).toBe("image/svg+xml");
  expect(artifactActions(posthog)).toStrictEqual([
    { action: "download", surface: "diagram_preview" },
  ]);
});
