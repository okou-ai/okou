import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  artifactRun,
  buttonNamed,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_THREAD_ID,
} from "./chat-navigation-artifact-test-helpers.ts";

const context = testContext();
const PDF_URL = "https://cdn.vm7.io/artifacts/tests/sidebar/sidebar-report.pdf";

async function openChatWithSidebarPreview() {
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.ArtifactSidebarPreview]: true },
  });
}

function sentUserFile(
  id: string,
  filename: string,
  contentType: string,
): MockChatEventInput[] {
  return [
    {
      id: `${id}-message`,
      createdAt: "2026-09-01T12:00:00.000Z",
      role: "user",
      content: `Review ${filename}`,
      fileParts: [
        {
          type: "file",
          fileId: `${id}-file`,
          filenameSnapshot: filename,
          contentType,
        },
      ],
      runId: `${id}-run`,
      seqId: 1,
    },
    {
      id: `${id}-completed`,
      createdAt: "2026-09-01T12:00:01.000Z",
      role: "assistant",
      content: null,
      runId: `${id}-run`,
      runLifecycleEvent: "completed",
      seqId: 2,
    },
  ];
}

function mockPrivateFile(url: string, body: string) {
  context.mocks.api(webFilesContract.fileUrl, ({ respond }) => {
    return respond(200, {
      downloadUrl: new URL("?download=1", url).href,
      url,
      publicUrl: null,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
  });
  context.mocks.http.get(url, () => {
    return HttpResponse.text(body);
  });
}

test("A chat artifact opens directly in a closed sidebar and reopens there", async () => {
  mockArtifactConversation(context, {
    catalog: [],
    artifactRuns: () => {
      return [
        artifactRun({
          filename: "sidebar-report.pdf",
          fileId: "sidebar-report-file",
          contentType: "application/pdf",
          url: PDF_URL,
        }),
      ];
    },
    chatEvents: [
      {
        id: "sidebar-artifact-message",
        createdAt: "2026-09-01T12:00:00.000Z",
        role: "assistant",
        content: `![sidebar-report.pdf](${PDF_URL})`,
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
  await openChatWithSidebarPreview();
  const card = await screen.findByLabelText(
    "Open pdf preview for sidebar-report.pdf",
  );
  expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();

  click(card);
  const preview = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(preview).findByTitle("sidebar-report.pdf preview"),
  ).resolves.toHaveAttribute("src", `${PDF_URL}#navpanes=0`);
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
});

test("A sent user attachment opens in the sidebar without artifact sharing", async () => {
  mockPrivateFile(
    "https://files.example.test/upload.txt",
    "Uploaded document content",
  );
  mockArtifactConversation(context, {
    catalog: [],
    chatEvents: sentUserFile("sidebar-upload", "upload.txt", "text/plain"),
  });
  await openChatWithSidebarPreview();

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

test("The CSV sidebar preserves quoted fields and duplicate records", async () => {
  const source =
    'name,name,,\r\n"Doe, Jane","first\r\nsecond ""quoted"" line",,\r\n"Doe, Jane","first\r\nsecond ""quoted"" line",,\r\n';
  mockPrivateFile("https://files.example.test/review.csv", source);
  mockArtifactConversation(context, {
    catalog: [],
    chatEvents: sentUserFile("sidebar-csv", "review.csv", "text/csv"),
  });
  await openChatWithSidebarPreview();

  click(await screen.findByLabelText("Open csv preview for review.csv"));

  const preview = await screen.findByTestId("artifact-sidebar");
  const table = await within(preview).findByRole("table");
  expect(
    Array.from(table.querySelectorAll("tbody td"), (cell) => {
      return cell.textContent;
    }),
  ).toStrictEqual([
    "Doe, Jane",
    'first\r\nsecond "quoted" line',
    "",
    "",
    "Doe, Jane",
    'first\r\nsecond "quoted" line',
    "",
    "",
  ]);
});
