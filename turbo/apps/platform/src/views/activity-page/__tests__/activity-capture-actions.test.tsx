import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const URL = "https://api.reports.test/v1/exports";

function capturedLog(): File {
  const log = {
    meta: {
      id: "d0000000-0000-4000-a000-000000000f61",
      displayName: "Export reports",
      framework: "claude-code",
      status: "completed",
      createdAt: "2026-11-20T07:00:00.000Z",
      startedAt: "2026-11-20T07:00:01.000Z",
      completedAt: "2026-11-20T07:00:11.000Z",
    },
    events: [],
    networkLogs: [
      {
        timestamp: "2026-11-20T07:00:05.000Z",
        type: "http",
        method: "POST",
        url: URL,
        host: "api.reports.test",
        status: 201,
        latency_ms: 95,
        request_headers: { "x-request-id": "req-61" },
        request_headers_truncated: false,
        request_body: '{"format":"csv"}',
        response_headers: { "x-export-id": "exp-61" },
        response_headers_truncated: false,
        response_body: '{"id":"exp-61"}',
      },
    ],
  };
  return new File([JSON.stringify(log)], "export-reports.json", {
    type: "application/json",
  });
}

/** The capture section a heading starts, and the copy action beside it. */
function captureSection(title: string): {
  readonly details: HTMLDetailsElement;
  readonly copy: HTMLElement;
} {
  const summary = [...document.querySelectorAll("summary")].find((item) => {
    return item.textContent?.startsWith(title);
  });
  const details = summary?.closest("details");
  // The copy action sits beside the disclosure, outside its content.
  const copy = details?.parentElement?.querySelector<HTMLElement>(
    ':scope > button[aria-label="Copy to clipboard"]',
  );
  if (!details || !copy) {
    throw new Error(`Expected the ${title} capture section`);
  }
  return { details, copy };
}

test("Copy each capture section without opening its disclosure", async () => {
  await setupPage({
    context,
    path: "/activities/inspect",
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });
  await expect(
    screen.findByRole("heading", { name: "No log loaded" }),
  ).resolves.toBeInTheDocument();
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  await userEvent.upload(input as HTMLInputElement, capturedLog());
  const network = await waitFor(() => {
    const found = queryAllByRoleFast("tab").find((tab) => {
      return tab.textContent?.trim() === "Network";
    });
    if (!found) {
      throw new Error("Expected the Network tab");
    }
    return found;
  });
  await userEvent.click(network);
  const request = await waitFor(() => {
    const found = queryAllByRoleFast("button").find((button) => {
      return button.getAttribute("aria-label") === URL;
    });
    if (!found) {
      throw new Error("Expected the captured request");
    }
    return found;
  });
  click(request);
  await waitFor(() => {
    expect(request).toHaveAttribute("aria-expanded", "true");
  });
  const clipboard = context.mocks.browser.clipboardWriteText();

  for (const [title, copied] of [
    ["Request Headers", "x-request-id: req-61"],
    ["Response Headers", "x-export-id: exp-61"],
    ["Request Body", '{"format":"csv"}'],
    ["Response Body", '{"id":"exp-61"}'],
  ] as const) {
    const section = captureSection(title);
    expect(section.details.open).toBeFalsy();

    click(section.copy);

    await waitFor(() => {
      expect(clipboard.writes.at(-1)).toBe(copied);
    });
    expect(section.details.open).toBeFalsy();
  }
});
