import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_THREAD_ID,
  findNamedButton,
  getNamedButton,
  mockAttachmentChat,
} from "./chat-attachment-test-helpers.ts";

const context = testContext();
async function preview(filename: string, body: string, totalBytes?: number) {
  const id = "export-" + filename;
  const url = "https://files.example.org/private/" + filename;
  context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
    if (query.file_id !== id) {
      return respond(404, {
        error: { code: "FILE_NOT_FOUND", message: "Unknown export" },
      });
    }
    return respond(200, {
      url,
      downloadUrl: url + "?download=1",
      expiresAt: "2099-01-01T00:00:00Z",
      publicUrl: null,
    });
  });
  context.mocks.http.get(url, () => {
    return new HttpResponse(body, {
      status: totalBytes === undefined ? 200 : 206,
      headers: {
        "Content-Type": "application/json",
        ...(totalBytes === undefined
          ? {}
          : { "Content-Range": `bytes 0-${body.length - 1}/${totalBytes}` }),
      },
    });
  });
  mockAttachmentChat(context, {
    chatEvents: [
      {
        role: "user",
        content: null,
        createdAt: "2026-10-09T11:00:00Z",
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: "Inspect export" },
            {
              type: "file",
              fileId: id,
              filenameSnapshot: filename,
              contentType: "application/json",
            },
          ],
        },
      },
    ],
  });
  await setupPage({
    context,
    path: "/chats/" + ATTACHMENT_THREAD_ID,
    featureSwitches: { [FeatureSwitchKey.ArtifactSidebarPreview]: true },
  });
  const turn = (await screen.findByText("Inspect export")).closest<HTMLElement>(
    "[data-role=user]",
  )!;
  click(within(turn).getByText(filename));
  const panel = await screen.findByTestId("artifact-sidebar");
  return await within(panel).findByTestId("json-preview");
}

test("chat-json-preview-001 reads the nested ledger number and empty object, then the original private file", async () => {
  const body =
    '{\n  "items": [{"ledger":9223372036854775807,"overrides":{}}]\n}';
  const viewer = await preview("balances.json", body);
  click(await findNamedButton('Expand "items"', viewer));
  click(await findNamedButton("Expand [0]", viewer));
  const ledger = await within(viewer).findByText('"ledger"');
  expect(ledger.parentElement).toHaveTextContent(
    '"ledger": 9223372036854775807',
  );
  expect(
    within(viewer).getByText('"overrides"').parentElement,
  ).toHaveTextContent('"overrides": {}');
  click(getNamedButton("Source", viewer));
  const source = await within(viewer).findByText((_, element) => {
    return element?.tagName === "PRE" && element.textContent === body;
  });
  expect(source).toBeInTheDocument();
});

test("chat-json-preview-003 discloses a partial response even when the received export parses", async () => {
  const prefix = '{"account":"reserve","closed":true}';
  const viewer = await preview("reserve.json", prefix, 8400);
  const notice = await within(viewer).findByRole("status");
  expect(notice).toHaveTextContent("Only part of this file is loaded");
  expect(getNamedButton("Tree", viewer)).toBeDisabled();
  expect(
    within(viewer).getByText(prefix, { selector: "pre" }),
  ).toBeInTheDocument();
});
