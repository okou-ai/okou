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

test("Copy each capture section without opening its disclosure", async () => {
  const user = userEvent.setup();
  const clipboard = context.mocks.browser.clipboardWriteText();
  await openCapture(user, {
    request_headers: { "Content-Type": "application/json" },
    response_headers: { "Content-Type": "text/plain" },
    request_body: '{"message":"request capture"}',
    response_body: '{"message":"response capture"}',
  });
  const sections = [
    [
      "Request Headers (1)",
      "application/json",
      "Content-Type: application/json",
    ],
    ["Response Headers (1)", "text/plain", "Content-Type: text/plain"],
    [
      "Request Body",
      '{"message":"request capture"}',
      '{"message":"request capture"}',
    ],
    [
      "Response Body",
      '{"message":"response capture"}',
      '{"message":"response capture"}',
    ],
  ] as const;
  let requestBodyCopy: HTMLElement | undefined;
  for (const [title, contentText, copiedText] of sections) {
    const { details, section } = captureSection(title);
    const copy = queryAllByRoleFast("button", section).find((button) => {
      return button.getAttribute("aria-label") === "Copy to clipboard";
    });
    if (!copy) {
      throw new Error(`Expected the ${title} copy action`);
    }
    if (title === "Request Body") {
      requestBodyCopy = copy;
    }
    const content = within(details).getByText(contentText);
    expect(content).not.toBeVisible();
    click(copy);
    await waitFor(() => {
      expect(clipboard.writes.at(-1)).toBe(copiedText);
    });
    expect(content).not.toBeVisible();
  }

  const { summary, details, section } = captureSection("Request Body");
  const content = within(details).getByText('{"message":"request capture"}');
  if (!requestBodyCopy || !section.contains(requestBodyCopy)) {
    throw new Error("Expected the copied Request Body action");
  }
  click(summary);
  expect(content).toBeVisible();
  requestBodyCopy.focus();
  await user.keyboard("{Enter} ");
  expect(clipboard.writes.slice(-2)).toStrictEqual([
    '{"message":"request capture"}',
    '{"message":"request capture"}',
  ]);
  expect(requestBodyCopy).toHaveFocus();
  click(summary);
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
