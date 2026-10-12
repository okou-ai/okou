import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifactRun,
  buttonNamed,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_THREAD_ID,
} from "./chat-navigation-artifact-test-helpers.ts";

const context = testContext();
const FILE_URL =
  "https://cdn.vm7.io/artifacts/tests/sidebar/sidebar-report.pdf";

// Both the page-owned and stable shell-owned sidebar must work from a closed
// state; neither path should require opening the artifact list first.
test.each([false, true])(
  "Chat artifacts open a closed sidebar directly (stable host: %s)",
  async (stableHost) => {
    mockArtifactConversation(context, {
      catalog: [],
      artifactRuns: () => {
        return [
          artifactRun({
            filename: "sidebar-report.pdf",
            fileId: "sidebar-report-file",
            contentType: "application/pdf",
            url: FILE_URL,
          }),
        ];
      },
      chatEvents: [
        {
          id: "sidebar-artifact-message",
          createdAt: "2026-09-01T12:00:00.000Z",
          role: "assistant",
          content: `![sidebar-report.pdf](${FILE_URL})`,
          runId: "navigation-artifact-run",
          seqId: 1,
        },
        {
          id: "sidebar-artifact-completed",
          createdAt: "2026-09-01T12:00:01.000Z",
          role: "assistant",
          content: null,
          runId: "navigation-artifact-run",
          runLifecycleEvent: "completed",
          seqId: 2,
        },
      ],
    });
    await setupPage({
      context,
      path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
      host: "app.okou.ai",
      featureSwitches: {
        [FeatureSwitchKey.ArtifactSidebarPreview]: true,
        [FeatureSwitchKey.StablePreviewFullscreen]: stableHost,
      },
    });
    const card = await screen.findByLabelText(
      "Open pdf preview for sidebar-report.pdf",
    );
    expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
    click(card);
    const preview = await screen.findByTestId("artifact-sidebar");
    await expect(
      within(preview).findByTitle("sidebar-report.pdf preview"),
    ).resolves.toHaveAttribute("src", `${FILE_URL}#navpanes=0`);
    expect(screen.queryByTestId("attachment-lightbox")).not.toBeInTheDocument();
    click(buttonNamed("Close artifact", preview));
    await waitFor(() => {
      expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
    });
    click(card);
    await expect(
      screen.findByTestId("artifact-sidebar"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByTestId("attachment-lightbox")).not.toBeInTheDocument();
  },
);

test("Sent user attachments open in the sidebar and retain their private sharing behavior", async () => {
  const url = "https://files.example.test/upload.txt";
  context.mocks.api(webFilesContract.fileUrl, ({ respond }) => {
    return respond(200, {
      url,
      publicUrl: null,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
  });
  context.mocks.http.get(url, () => {
    return HttpResponse.text("Uploaded document content");
  });
  mockArtifactConversation(context, {
    catalog: [],
    chatEvents: [
      {
        id: "sidebar-user-message",
        createdAt: "2026-09-01T12:00:00.000Z",
        role: "user",
        content: "Review this document",
        fileParts: [
          {
            type: "file",
            fileId: "sidebar-upload-file",
            filenameSnapshot: "upload.txt",
            contentType: "text/plain",
          },
        ],
        runId: "sidebar-upload-run",
        seqId: 1,
      },
      {
        id: "sidebar-upload-completed",
        createdAt: "2026-09-01T12:00:01.000Z",
        role: "assistant",
        content: null,
        runId: "sidebar-upload-run",
        runLifecycleEvent: "completed",
        seqId: 2,
      },
    ],
  });
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.ArtifactSidebarPreview]: true },
  });
  click(await screen.findByLabelText("Open text preview for upload.txt"));
  const preview = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(preview).findByText("Uploaded document content"),
  ).resolves.toBeInTheDocument();
  expect(
    within(preview).queryByLabelText("Share artifact"),
  ).not.toBeInTheDocument();
  expect(screen.queryByTestId("attachment-lightbox")).not.toBeInTheDocument();
});
