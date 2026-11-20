import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const SECRET_NAME = "STRIPE_SECRET_KEY";

function assistantEvent(sequenceNumber: number, text: string) {
  return {
    sequenceNumber,
    eventType: "assistant",
    createdAt: `2026-11-20T07:00:0${sequenceNumber}.000Z`,
    eventData: {
      type: "assistant",
      message: { content: [{ type: "text", text }] },
    },
  };
}

function runContext() {
  return {
    prompt: "Review the release",
    appendSystemPrompt: null,
    runId: "d0000000-0000-4000-a000-000000000f51",
    sessionId: "session-f51",
    secretNames: [SECRET_NAME],
    vars: { REGION: "eu-west-1" },
    environment: { NODE_ENV: "production" },
    firewalls: [],
    networkPolicies: null,
    storageMounts: [
      {
        name: "release-notes",
        version: "v3",
        mountPath: "/workspace/notes",
        writeback: false,
      },
      {
        name: "release-artifacts",
        version: "v7",
        mountPath: "/workspace/artifacts",
        writeback: true,
      },
    ],
    featureFlags: null,
  };
}

function exportedLog(overrides: Record<string, unknown> = {}): File {
  const log = {
    meta: {
      id: "d0000000-0000-4000-a000-000000000f51",
      displayName: "Release review",
      framework: "claude-code",
      status: "completed",
      triggerSource: "web",
      createdAt: "2026-11-20T07:00:00.000Z",
      startedAt: "2026-11-20T07:00:01.000Z",
      completedAt: "2026-11-20T07:00:31.000Z",
      prompt: "Review the release",
    },
    events: [assistantEvent(1, "Checked the release checklist.")],
    context: runContext(),
    networkLogs: [],
    ...overrides,
  };
  return new File([JSON.stringify(log)], "release-review.json", {
    type: "application/json",
  });
}

async function uploadLog(file: File, debug: boolean): Promise<void> {
  await setupPage({
    context,
    path: "/activities/inspect",
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: debug },
  });
  await expect(
    screen.findByRole("heading", { name: "No log loaded" }),
  ).resolves.toBeInTheDocument();
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) {
    throw new Error("Expected the log upload input");
  }
  await userEvent.upload(input, file);
}

const TOKEN_URL = "https://api.stripe.test/v1/oauth/token";
const INVOICES_URL = "https://api.stripe.test/v1/invoices";

function networkLogs() {
  return [
    {
      timestamp: "2026-11-20T07:00:05.000Z",
      type: "http",
      method: "POST",
      url: TOKEN_URL,
      host: "api.stripe.test",
      status: 200,
      latency_ms: 120,
      firewall_name: "stripe",
      firewall_permission: "oauth:refresh",
      request_headers: {
        authorization: "Bearer redacted",
        "content-type": "application/json",
      },
      request_headers_truncated: true,
      response_headers: { "content-type": "application/json" },
      response_headers_truncated: false,
    },
    {
      timestamp: "2026-11-20T07:00:06.000Z",
      type: "http",
      method: "GET",
      url: INVOICES_URL,
      host: "api.stripe.test",
      status: 404,
      latency_ms: 80,
      firewall_name: "billing",
      firewall_permission: "invoices:read",
    },
  ];
}

function tab(name: string): HTMLElement {
  const found = queryAllByRoleFast("tab").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!found) {
    throw new Error(`Expected the ${name} tab`);
  }
  return found;
}

function disclosure(url: string): HTMLElement {
  const found = queryAllByRoleFast("button").find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === url &&
      candidate.hasAttribute("aria-expanded")
    );
  });
  if (!found) {
    throw new Error(`Expected the request disclosure for ${url}`);
  }
  return found;
}

function requestRow(url: string): HTMLElement {
  const row = disclosure(url).closest("tr");
  if (!row) {
    throw new Error(`Expected the request row for ${url}`);
  }
  return row;
}

async function openNetworkTab(): Promise<void> {
  await userEvent.click(tab("Network"));
  await waitFor(() => {
    expect(disclosure(TOKEN_URL)).toHaveAttribute("aria-expanded", "false");
  });
}

test("A user can inspect steps, context, and network details from an exported log", async () => {
  await uploadLog(
    exportedLog({
      events: [
        assistantEvent(1, "Refreshed the OAuth token for Stripe."),
        assistantEvent(2, "Listed the latest invoices."),
      ],
      networkLogs: networkLogs(),
    }),
    true,
  );

  await expect(
    screen.findByText("Listed the latest invoices."),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText("Refreshed the OAuth token for Stripe."),
  ).toBeInTheDocument();
  expect(screen.getByText("Done")).toBeInTheDocument();
  expect(screen.getByText("30.0s")).toBeInTheDocument();
  // Each step carries its time relative to the run start.
  expect(screen.getAllByText(/\(\+00:00\.000\)/u).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/\(\+00:01\.000\)/u).length).toBeGreaterThan(0);

  const user = userEvent.setup({ delay: null });
  await user.type(screen.getByPlaceholderText("Search steps"), "OAuth");
  await waitFor(() => {
    expect(
      screen.queryByText("Listed the latest invoices."),
    ).not.toBeInTheDocument();
  });
  expect(
    screen.getByText("Refreshed the OAuth token for Stripe."),
  ).toBeInTheDocument();

  await user.click(tab("Context"));
  const root = document.body;
  await waitFor(() => {
    expect(root).toHaveTextContent(SECRET_NAME);
  });
  expect(root).toHaveTextContent("REGIONeu-west-1");
  expect(root).toHaveTextContent("NODE_ENVproduction");
  expect(root).toHaveTextContent("release-notes/workspace/notesv3Read only");
  expect(root).toHaveTextContent(
    "release-artifacts/workspace/artifactsv7Read/write",
  );

  await openNetworkTab();
  const tokenRow = requestRow(TOKEN_URL);
  expect(tokenRow).toHaveTextContent("POST");
  expect(tokenRow).toHaveTextContent("200");
  expect(tokenRow).toHaveTextContent("120ms");
  expect(tokenRow).toHaveTextContent("stripe");

  // Pointer opens and closes the request details.
  click(disclosure(TOKEN_URL));
  await waitFor(() => {
    expect(disclosure(TOKEN_URL)).toHaveAttribute("aria-expanded", "true");
  });
  const details = document.getElementById(
    disclosure(TOKEN_URL).getAttribute("aria-controls") ?? "",
  );
  expect(details).toHaveTextContent("Permissionoauth:refresh");
  expect(details).toHaveTextContent("Request Headers (2)truncated");
  expect(details).toHaveTextContent("Response Headers (1)complete");
  click(disclosure(TOKEN_URL));
  await waitFor(() => {
    expect(disclosure(TOKEN_URL)).toHaveAttribute("aria-expanded", "false");
  });

  // Keyboard does the same from the focused disclosure.
  disclosure(TOKEN_URL).focus();
  await user.keyboard("{Enter}");
  await waitFor(() => {
    expect(disclosure(TOKEN_URL)).toHaveAttribute("aria-expanded", "true");
  });
  await user.keyboard(" ");
  await waitFor(() => {
    expect(disclosure(TOKEN_URL)).toHaveAttribute("aria-expanded", "false");
  });

  click(disclosure(INVOICES_URL));
  await waitFor(() => {
    expect(disclosure(INVOICES_URL)).toHaveAttribute("aria-expanded", "true");
  });
  const invoiceDetails = document.getElementById(
    disclosure(INVOICES_URL).getAttribute("aria-controls") ?? "",
  );
  expect(invoiceDetails).toHaveTextContent("Firewallbilling");
  expect(invoiceDetails).toHaveTextContent("Permissioninvoices:read");
  expect(invoiceDetails).not.toHaveTextContent("oauth:refresh");
});

test("Selecting and copying a network URL preserves its request details", async () => {
  await uploadLog(exportedLog({ networkLogs: networkLogs() }), true);
  await screen.findByText("Checked the release checklist.");
  const user = userEvent.setup({ delay: null });
  await openNetworkTab();
  const urlCell = within(requestRow(TOKEN_URL)).getByText(TOKEN_URL);
  const selectUrl = () => {
    const selection = window.getSelection();
    selection?.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(urlCell);
    selection?.addRange(range);
  };

  selectUrl();
  fireEvent.click(urlCell);
  await user.copy();

  await expect(navigator.clipboard.readText()).resolves.toBe(TOKEN_URL);
  expect(disclosure(TOKEN_URL)).toHaveAttribute("aria-expanded", "false");

  click(disclosure(TOKEN_URL));
  await waitFor(() => {
    expect(disclosure(TOKEN_URL)).toHaveAttribute("aria-expanded", "true");
  });
  selectUrl();
  fireEvent.click(urlCell);
  expect(disclosure(TOKEN_URL)).toHaveAttribute("aria-expanded", "true");

  window.getSelection()?.removeAllRanges();
  fireEvent.click(within(requestRow(TOKEN_URL)).getByText("POST"));
  await waitFor(() => {
    expect(disclosure(TOKEN_URL)).toHaveAttribute("aria-expanded", "false");
  });
});

test("An imported log does not expose debug diagnostics when debug access is disabled", async () => {
  await uploadLog(exportedLog(), false);

  await expect(
    screen.findByText("Checked the release checklist."),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Release review" }),
  ).toBeInTheDocument();
  expect(queryAllByRoleFast("tab")).toStrictEqual([]);
  expect(document.body).not.toHaveTextContent(SECRET_NAME);
});

function codexEvent(
  sequenceNumber: number,
  eventType: string,
  eventData: Record<string, unknown>,
) {
  return {
    sequenceNumber,
    eventType,
    createdAt: `2026-11-20T07:00:0${sequenceNumber + 1}.000Z`,
    eventData: { type: eventType, ...eventData },
  };
}

test("The inspector presents exported Codex events as readable activity steps", async () => {
  await uploadLog(
    exportedLog({
      meta: {
        id: "d0000000-0000-4000-a000-000000000f55",
        displayName: "Migrate billing",
        framework: "codex",
        status: "failed",
        createdAt: "2026-11-20T07:00:00.000Z",
        startedAt: "2026-11-20T07:00:01.000Z",
        completedAt: "2026-11-20T07:00:21.000Z",
      },
      events: [
        codexEvent(1, "item.completed", {
          item: {
            id: "msg-1",
            type: "agent_message",
            text: "Started the billing migration.",
          },
        }),
        codexEvent(2, "warning", { message: "Rate limit is close." }),
        codexEvent(3, "turn.plan.updated", {
          plan: [{ step: "Run billing migrations", status: "in_progress" }],
        }),
        codexEvent(4, "error", {
          message: "Sandbox denied the write to /etc/billing.",
        }),
        // Codex reports the failed turn's error as an object.
        codexEvent(5, "turn.failed", {
          error: {
            message: "Turn stopped after the sandbox denial.",
            code: "sandbox_denied",
          },
        }),
      ],
    }),
    true,
  );

  await expect(
    screen.findByText("Started the billing migration."),
  ).resolves.toBeInTheDocument();
  const root = document.body;
  expect(screen.getByText("Failed")).toBeInTheDocument();
  expect(root).toHaveTextContent("[warning] Rate limit is close.");
  expect(root).toHaveTextContent("[plan] in progress: Run billing migrations");
  expect(root).toHaveTextContent("Sandbox denied the write to /etc/billing.");
  expect(root).toHaveTextContent("Turn stopped after the sandbox denial.");
  expect(root).not.toHaveTextContent("[object Object]");

  const user = userEvent.setup({ delay: null });
  await user.type(screen.getByPlaceholderText("Search steps"), "Rate limit");

  await waitFor(() => {
    expect(root).toHaveTextContent("(1/4 matched)");
  });
  expect(root).not.toHaveTextContent("Run billing migrations");
  expect(root).toHaveTextContent("[warning] Rate limit is close.");
});
