import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { getButtonByName } from "../../artifacts-page/__tests__/artifact-catalog-test-helpers.ts";
import {
  ATTACHMENT_THREAD_ID,
  mockAttachmentChat,
} from "./chat-attachment-test-helpers.ts";

const context = testContext();
const fileId = "a1800000-0000-4000-8000-000000000001";
const filename = "analysis.json";
const fileUrl = "https://files.example.test/private/analysis.json";

async function openPrivateJson(source: string, response?: ResponseInit) {
  context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
    expect(query.file_id).toBe(fileId);
    return respond(200, {
      url: fileUrl,
      downloadUrl: `${fileUrl}?download=1`,
      expiresAt: "2099-01-01T00:00:00Z",
      publicUrl: null,
    });
  });
  context.mocks.http.get(fileUrl, () => {
    return HttpResponse.text(source, response);
  });
  mockAttachmentChat(context, {
    chatEvents: [
      {
        id: "analysis-upload",
        createdAt: "2026-03-10T10:00:00Z",
        role: "user",
        content: "Review this analysis.",
        fileParts: [
          {
            type: "file",
            fileId,
            filenameSnapshot: filename,
            contentType: "application/json",
          },
        ],
        runId: "analysis-run",
        seqId: 1,
      },
      {
        id: "analysis-complete",
        createdAt: "2026-03-10T10:00:01Z",
        role: "assistant",
        content: null,
        runId: "analysis-run",
        runLifecycleEvent: "completed",
        seqId: 2,
      },
    ],
  });

  await setupPage({
    context,
    host: "app.okou.ai",
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ArtifactSidebarPreview]: true },
  });
  click(await screen.findByLabelText(`Open json preview for ${filename}`));

  const sidebar = await screen.findByTestId("artifact-sidebar");
  return await within(sidebar).findByTestId("json-preview");
}

test("A private chat attachment preserves the exact large number in the sidebar JSON tree", async () => {
  const source = '{"items":[{"id":9223372036854775807}],"empty":{}}';
  const preview = await openPrivateJson(source);

  click(getButtonByName('Expand "items"', preview));
  click(getButtonByName("Expand [0]", preview));
  expect(within(preview).getByText("9223372036854775807")).toBeInTheDocument();
  expect(within(preview).getByText("{}")).toBeInTheDocument();
  click(getButtonByName("Source", preview));
  expect(preview.querySelector("pre")?.textContent).toBe(source);
});

test("A truncated JSON response shows only the received source and disables the tree", async () => {
  const source = '{"partial":"looks complete"}';
  const preview = await openPrivateJson(source, {
    status: 206,
    headers: { "Content-Range": `bytes 0-${source.length - 1}/100000` },
  });

  expect(within(preview).getByRole("status")).toHaveTextContent(
    "Only part of this file is loaded",
  );
  expect(getButtonByName("Tree", preview)).toBeDisabled();
  expect(preview.querySelector("pre")?.textContent).toBe(source);
});
