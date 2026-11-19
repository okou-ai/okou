import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { artifactSharesContract } from "@okouai/api-contracts/contracts/artifact-shares";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
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
  findNamedButton,
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

function artifactActions(posthog: ReturnType<typeof context.mocks.posthog>) {
  return posthog.events
    .filter((event) => {
      return event.name === "artifact_action_clicked";
    })
    .map((event) => {
      return event.properties;
    });
}

test("A catalog ZIP records only its two downloads and copies its owner link", async () => {
  const posthog = context.mocks.posthog();
  const browser = context.mocks.browser.blobDownload();
  const clipboard = context.mocks.browser.clipboardWriteText();
  const filename = "confidential-release-bundle.zip";
  const fileId = "f0000000-0000-4000-a000-000000000002";
  const ownerUrl = new URL(
    artifactReferencePath(fileId, filename),
    "https://app.okou.ai",
  ).href;
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
        id: fileId,
        filename,
        contentType: "application/zip",
        size: 2048,
        url: ownerUrl,
        previewImageUrl: null,
      },
    });
  });
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(200, {
      url,
      downloadUrl: url,
      filename,
      contentType: "application/zip",
      expiresAt: "2099-01-01T00:00:00Z",
      target: { kind: "file", id: fileId },
    });
  });
  context.mocks.api(artifactSharesContract.status, ({ respond }) => {
    return respond(200, {
      ownerUrl,
      shareId: null,
      audience: "private",
      organization: { id: "org_test", name: "Acme" },
      selectedTarget: null,
      selectedVersion: null,
      candidateVersion: null,
      url: null,
      shortUrl: null,
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
  expect(artifactActions(posthog)).toStrictEqual([
    { action: "download", surface: "file_preview", artifact_type: "archive" },
  ]);

  click(getNamedButton("Download options", dialog));
  const menu = await screen.findByRole("menu");
  expect(artifactActions(posthog)).toStrictEqual([
    { action: "download", surface: "file_preview", artifact_type: "archive" },
  ]);
  click(await findNamedMenuItem("Download", menu));
  await waitFor(() => {
    expect(browser.downloads).toHaveLength(2);
  });
  expect(
    browser.downloads.map((download) => {
      return download.url;
    }),
  ).toStrictEqual([url, url]);

  click(await findNamedButton("Share", dialog));
  const share = await screen.findByRole("dialog", { name: "Share" });
  const copy = await findNamedButton("Copy link", share);
  click(copy);
  await expect(findNamedButton("Copied", share)).resolves.toBeInTheDocument();
  expect(clipboard.writes).toStrictEqual([ownerUrl]);
  expect(artifactActions(posthog)).toStrictEqual([
    { action: "download", surface: "file_preview", artifact_type: "archive" },
    { action: "download", surface: "dialog", artifact_type: "archive" },
  ]);
});

test("An Office chip preview records nothing and a binary chip download records type other", async () => {
  const posthog = context.mocks.posthog();
  const browser = context.mocks.browser.blobDownload();
  const filename = "confidential-forecast.bin";
  const binaryUrl = "https://private-files.example/confidential-forecast.bin";
  mockAttachmentChat(context, {
    chatEvents: [
      {
        id: "artifact-intent-user-message",
        role: "user",
        content: null,
        runId: ATTACHMENT_RUN_ID,
        createdAt: "2026-03-10T00:00:01Z",
        userMessage: userMessage([
          {
            type: "file",
            fileId: "intent-binary",
            filenameSnapshot: filename,
            contentType: "application/octet-stream",
          },
          {
            type: "file",
            fileId: "intent-office",
            filenameSnapshot: "confidential-strategy.docx",
            contentType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          },
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
  click(await findNamedButton(`Download ${filename}`));

  await waitFor(() => {
    expect(browser.downloads).toHaveLength(1);
  });
  expect(browser.downloads[0]?.url).toBe(`${binaryUrl}?download=1`);
  expect(artifactActions(posthog)).toStrictEqual([
    { action: "download", surface: "attachment_chip", artifact_type: "other" },
  ]);
});

test("A shared-thread video records only its download with the fresh URL", async () => {
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
  context.mocks.api(artifactReferencesContract.publicUrl, ({ respond }) => {
    return respond(200, {
      url: previewUrl,
      downloadUrl,
      expiresAt: "2099-01-01T00:00:00Z",
      sharedThreadSnapshot: true,
      preview: { filename: "lightvid01.mp4", contentType: "video/mp4" },
    });
  });

  await setupPage({
    context,
    path: `/share/threads/${SHARED_THREAD_ID}`,
    host: "app.okou.ai",
    auth: null,
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
  click(getNamedButton("Download", dialog));
  await waitFor(() => {
    expect(browser.downloads).toHaveLength(1);
  });
  expect(browser.downloads[0]?.url).toBe(freshUrl);
  expect(artifactActions(posthog)).toStrictEqual([
    { action: "download", surface: "shared_preview", artifact_type: "video" },
  ]);
});
