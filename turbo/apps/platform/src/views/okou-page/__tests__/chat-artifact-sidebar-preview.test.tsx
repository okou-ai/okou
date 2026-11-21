import { test, expect } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { click } from "../../../__tests__/page-helper.ts";
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
const context = testContext();
test("chat-artifact-sidebar-preview-001 reopening a PDF directly restores the sidebar document", async () => {
  const url = "https://cdn.okou.io/artifacts/review/session/estimate.pdf";
  await conversation(
    context,
    { chatEvents: [assistantRow("[Estimate](" + url + ")")] },
    true,
  );
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
  await conversation(
    context,
    { chatEvents: [userRow(fileParts([file]))] },
    true,
  );
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
  await conversation(
    context,
    { chatEvents: [userRow(fileParts([file]))] },
    true,
  );
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
