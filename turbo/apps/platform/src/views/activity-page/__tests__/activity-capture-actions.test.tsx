import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NetworkLogEntry } from "@okouai/api-contracts/contracts/runs";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const requestUrl = "https://example.com/capture-preview";

function captureFile(capture: Partial<NetworkLogEntry>): File {
  const entry: NetworkLogEntry = {
    timestamp: "2026-09-23T06:00:00Z",
    type: "http",
    action: "ALLOW",
    method: "POST",
    url: requestUrl,
    status: 200,
    ...capture,
  };
  return new File(
    [
      JSON.stringify({
        meta: { displayName: "Captured request", status: "completed" },
        events: [],
        networkLogs: [entry],
      }),
    ],
    "captured-request.json",
    { type: "application/json" },
  );
}

async function openCapture(
  user: ReturnType<typeof userEvent.setup>,
  capture: Partial<NetworkLogEntry>,
) {
  await setupPage({
    context,
    path: "/activities/inspect?tab=network",
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });
  await user.upload(screen.getByLabelText("Upload JSON"), captureFile(capture));
  const request = await screen.findByText(requestUrl);
  click(request);
}

function captureSection(title: string) {
  const summary = screen.getByText(title).closest("summary");
  const details = summary?.closest("details");
  const section = details?.parentElement;
  if (!summary || !details || !section) {
    throw new Error(`Expected capture disclosure: ${title}`);
  }
  return { summary, details, section };
}

test.each([
  {
    title: "Request Headers (1)",
    capture: { request_headers: { "Content-Type": "application/json" } },
    text: "Content-Type: application/json",
    content: "application/json",
  },
  {
    title: "Response Headers (1)",
    capture: { response_headers: { "Content-Type": "text/plain" } },
    text: "Content-Type: text/plain",
    content: "text/plain",
  },
  {
    title: "Request Body",
    capture: { request_body: '{"message":"request capture"}' },
    text: '{"message":"request capture"}',
    content: '{"message":"request capture"}',
  },
  {
    title: "Response Body",
    capture: { response_body: '{"message":"response capture"}' },
    text: '{"message":"response capture"}',
    content: '{"message":"response capture"}',
  },
])("Copy $title without changing its disclosure", async (fixture) => {
  const user = userEvent.setup();
  const clipboard = context.mocks.browser.clipboardWriteText();
  await openCapture(user, fixture.capture);
  const { summary, details, section } = captureSection(fixture.title);
  const copy = queryAllByRoleFast("button", section).find((button) => {
    return button.getAttribute("aria-label") === "Copy to clipboard";
  });
  if (!copy) {
    throw new Error("Expected the capture copy action");
  }
  const content = within(details).getByText(fixture.content);
  expect(content).not.toBeVisible();

  click(copy);
  await waitFor(() => {
    expect(copy).toHaveAttribute("aria-label", "Copied");
  });
  expect(clipboard.writes).toStrictEqual([fixture.text]);
  expect(content).not.toBeVisible();

  click(summary);
  expect(content).toBeVisible();
  copy.focus();
  await user.keyboard("{Enter} ");
  expect(clipboard.writes).toStrictEqual([
    fixture.text,
    fixture.text,
    fixture.text,
  ]);
  expect(copy).toHaveFocus();
  expect(content).toBeVisible();

  click(summary);
  expect(content).not.toBeVisible();
  click(copy);
  await waitFor(() => {
    expect(clipboard.writes).toHaveLength(4);
  });
  expect(clipboard.writes[3]).toBe(fixture.text);
  expect(content).not.toBeVisible();
});

test("Keep binary captures and empty capture metadata without copy actions", async () => {
  const user = userEvent.setup();
  await openCapture(user, {
    request_headers: {},
    request_headers_truncated: true,
    request_body_encoding: "binary",
    request_body_truncated: true,
    response_body: "AAEC",
    response_body_encoding: "base64",
    response_body_truncated: false,
  });

  const requestHeaders = captureSection("Request Headers (0)");
  expect(queryAllByRoleFast("button", requestHeaders.section)).toHaveLength(0);
  expect(
    within(requestHeaders.section).getByText("truncated"),
  ).toBeInTheDocument();
  expect(screen.getByText("Request Body")).toBeInTheDocument();
  expect(screen.getByText("binary")).toBeInTheDocument();
  expect(screen.getAllByText("truncated")).toHaveLength(2);

  const response = captureSection("Response Body");
  expect(queryAllByRoleFast("button", response.section)).toHaveLength(0);
  expect(within(response.section).getByText("complete")).toBeInTheDocument();
  const binary = within(response.section).getByText(/Binary data/);
  expect(binary).not.toBeVisible();
  click(response.summary);
  expect(binary).toBeVisible();
});
