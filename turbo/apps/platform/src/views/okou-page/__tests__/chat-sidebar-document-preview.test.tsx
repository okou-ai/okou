import { test, expect } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";
import {
  attachment,
  assistantRow,
  userRow,
  fileParts,
  conversation,
  serveUploaded,
} from "./attachment-preview-boundaries.ts";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import {
  ATTACHMENT_THREAD_ID,
  findNamedButton,
  getNamedButton,
  mockAttachmentChat,
} from "./chat-attachment-test-helpers.ts";

const context = testContext();

test("chat-artifact-sidebar-preview-001 reopening a PDF directly restores the sidebar document", async () => {
  const url = "https://cdn.okou.io/artifacts/review/session/estimate.pdf";
  await conversation(context, {
    chatEvents: [assistantRow("[Estimate](" + url + ")")],
  });
  const open = await findAction("link", "Estimate");
  expect(screen.queryByTestId("artifact-sidebar")).toBeNull();
  click(open);
  const side = await screen.findByTestId("artifact-sidebar");
  const frame = await within(side).findByTitle("estimate.pdf preview");
  expect(frame.getAttribute("src")).toContain(url);
  expect(frame.getAttribute("src")).toContain("navpanes=0");
  click(await findAction("button", "Close artifact", side));
  await waitFor(() => {
    return expect(side).not.toBeInTheDocument();
  });
  click(open);
  const reopened = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(reopened).findByTitle("estimate.pdf preview"),
  ).resolves.toHaveAttribute("src", frame.getAttribute("src"));
  expect(screen.queryByTestId("attachment-lightbox-panel")).toBeNull();
});

test("chat-artifact-sidebar-preview-002 a private uploaded text file opens its content in the sidebar", async () => {
  const file = attachment("upload.txt", "text/plain");
  serveUploaded(context, [file]);
  context.mocks.http.get(file.url.split("?")[0], () => {
    return HttpResponse.text("Only the expedition team has this file.");
  });
  await conversation(context, { chatEvents: [userRow(fileParts([file]))] });
  click(await findAction("button", "Open text preview for upload.txt"));
  const side = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(side).findByText("Only the expedition team has this file."),
  ).resolves.toBeVisible();
  expect(queryAction("button", "Share artifact", side)).toBeNull();
  expect(queryAction("button", "Share", side)).toBeNull();
  expect(screen.queryByTestId("attachment-lightbox-panel")).toBeNull();
});

test("chat-artifact-sidebar-preview-003 the CSV sidebar preserves repeated records and quoted fields", async () => {
  const file = attachment("observations.csv", "text/csv");
  serveUploaded(context, [file]);
  const record = '"East, West","Line one\nLine two","She said ""go""",';
  context.mocks.http.get(file.url.split("?")[0], () => {
    return HttpResponse.text(
      ["Area,Notes,Quote,Spare", record, record].join("\r\n"),
    );
  });
  await conversation(context, { chatEvents: [userRow(fileParts([file]))] });
  click(await findAction("button", "Open csv preview for observations.csv"));
  const side = await screen.findByTestId("artifact-sidebar");
  const table = await within(side).findByRole("table");
  const data = Array.from(table.querySelectorAll("tbody tr"), (row) => {
    return Array.from(row.querySelectorAll("td"), (cell) => {
      return cell.textContent;
    });
  });
  const expected = ["East, West", "Line one\nLine two", 'She said "go"', ""];
  expect(data).toStrictEqual([expected, expected]);
});

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
