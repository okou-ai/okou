import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NetworkLogEntry } from "@okouai/api-contracts/contracts/runs";
import type { LogDetail } from "@okouai/api-contracts/contracts/logs";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { AgentEvent } from "../../../signals/okou-page/log-types.ts";

const context = testContext();
const user = userEvent.setup();

function inspectFile(): File {
  const meta: Partial<LogDetail> = {
    id: "b0000000-0000-4000-a000-000000000777",
    sessionId: "session-inspect",
    agentId: "c0000000-0000-4000-a000-000000000001",
    displayName: "Imported Analysis",
    framework: "claude-code",
    modelProvider: null,
    selectedModel: null,
    triggerSource: "test",
    status: "completed",
    prompt: "Inspect the latest OAuth trace",
    appendSystemPrompt: "Prefer concise findings",
    createdAt: "2026-03-10T14:56:00Z",
    startedAt: "2026-03-10T14:56:01Z",
    completedAt: "2026-03-10T14:56:06Z",
  };
  const events: AgentEvent[] = [
    {
      sequenceNumber: 0,
      eventType: "assistant",
      eventData: {
        message: {
          content: [
            {
              type: "text",
              text: "Collected OAuth evidence from network logs.",
            },
          ],
        },
      },
      createdAt: "2026-03-10T14:56:02Z",
    },
    {
      sequenceNumber: 1,
      eventType: "assistant",
      eventData: {
        message: {
          content: [
            {
              type: "text",
              text: "Summarized billing status for the workspace.",
            },
          ],
        },
      },
      createdAt: "2026-03-10T14:56:04Z",
    },
  ];
  const runContext = {
    prompt: "Inspect the latest OAuth trace",
    appendSystemPrompt: "Prefer concise findings",
    runId: "b0000000-0000-4000-a000-000000000777",
    sessionId: "session-inspect",
    secretNames: ["github-token"],
    vars: { ACCOUNT_ID: "acct_123" },
    environment: { NODE_ENV: "test" },
    firewalls: [
      {
        name: "github",
        apis: [
          {
            base: "https://api.github.com",
            permissions: [
              {
                name: "read-repos",
                description: "Read repositories",
                rules: ["GET /repos/*"],
              },
            ],
          },
        ],
      },
    ],
    networkPolicies: null,
    volumes: [
      {
        name: "workspace",
        mountPath: "/workspace",
        vasStorageName: "storage-workspace",
        vasVersionId: "version-1",
      },
    ],
    artifact: {
      mountPath: "/artifact",
      vasStorageName: "artifact-storage",
      vasVersionId: "artifact-version",
    },
    featureFlags: { okouDebug: true },
  };
  const networkLogs: NetworkLogEntry[] = [
    {
      timestamp: "2026-03-10T14:56:03.000Z",
      type: "http",
      action: "ALLOW",
      method: "GET",
      url: "https://api.github.com/repos/okou-ai/okou",
      status: 200,
      latency_ms: 123,
      request_size: 42,
      response_size: 2048,
      firewall_name: "github",
      firewall_permission: "read-repos",
      browser_user_agent: true,
      connector_diagnostic_slug: "github-connector",
      request_headers: { "Content-Type": "application/json" },
      request_headers_truncated: true,
      response_headers: {},
      response_headers_truncated: true,
    },
    {
      timestamp: "2026-03-10T14:56:04.000Z",
      type: "http",
      action: "ALLOW",
      method: "POST",
      url: "https://slack.com/api/auth.test",
      status: 401,
      latency_ms: 87,
      request_size: 24,
      response_size: 512,
      connector_diagnostic_slug: "slack-connector",
    },
  ];

  return new File(
    [
      JSON.stringify({
        meta,
        events,
        context: runContext,
        networkLogs,
      }),
    ],
    "activity-log.json",
    { type: "application/json" },
  );
}

function codexInspectFile(): File {
  const meta: Partial<LogDetail> = {
    id: "b0000000-0000-4000-a000-000000000778",
    sessionId: "codex-inspect-session",
    agentId: "c0000000-0000-4000-a000-000000000002",
    displayName: "Imported Codex Adapter Log",
    framework: "codex",
    modelProvider: null,
    selectedModel: null,
    triggerSource: "test",
    status: "failed",
    prompt: "Inspect Codex adapter events",
    appendSystemPrompt: "Prefer normalized Codex rows",
    failureReason: "unknown",
    createdAt: "2026-03-10T16:56:00Z",
    startedAt: "2026-03-10T16:56:01Z",
    completedAt: "2026-03-10T16:56:06Z",
  };
  const events: AgentEvent[] = [
    {
      sequenceNumber: 0,
      eventType: "item.completed",
      eventData: {
        type: "item.completed",
        turn_id: "inspect-turn-1",
        item: {
          id: "inspect-message",
          type: "agent_message",
          status: "completed",
          text: "Codex inspect assistant output remains visible.",
        },
      },
      createdAt: "2026-03-10T16:56:02Z",
    },
    {
      sequenceNumber: 1,
      eventType: "warning",
      eventData: {
        type: "warning",
        thread_id: "codex-inspect-session",
        message: "Inspect adapter warning",
      },
      createdAt: "2026-03-10T16:56:03Z",
    },
    {
      sequenceNumber: 2,
      eventType: "turn.plan.updated",
      eventData: {
        type: "turn.plan.updated",
        turn_id: "inspect-turn-1",
        explanation: "Inspect normalized plan",
        plan: [{ step: "Review imported Codex event", status: "completed" }],
      },
      createdAt: "2026-03-10T16:56:04Z",
    },
    {
      sequenceNumber: 3,
      eventType: "error",
      eventData: {
        type: "error",
        turn_id: "inspect-turn-1",
        message: "Inspect transport failed",
        error: {
          message: "Inspect transport failed",
          additional_details: "inspect socket closed",
        },
      },
      createdAt: "2026-03-10T16:56:05Z",
    },
    {
      sequenceNumber: 4,
      eventType: "turn.completed",
      eventData: {
        type: "turn.completed",
        turn: {
          id: "inspect-turn-1",
          status: "failed",
          error: {
            message: "Inspect turn failed",
            codex_error_info: "inspect model stopped",
          },
        },
      },
      createdAt: "2026-03-10T16:56:06Z",
    },
  ];
  const runContext = {
    prompt: "Inspect Codex adapter events",
    appendSystemPrompt: "Prefer normalized Codex rows",
    runId: "b0000000-0000-4000-a000-000000000778",
    sessionId: "codex-inspect-session",
    secretNames: [],
    vars: {},
    environment: {},
    firewalls: [],
    networkPolicies: null,
    volumes: [],
    artifact: null,
    featureFlags: { okouDebug: true },
  };

  return new File(
    [
      JSON.stringify({
        meta,
        events,
        context: runContext,
        networkLogs: [],
      }),
    ],
    "codex-activity-log.json",
    { type: "application/json" },
  );
}

function getFileInput(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>("Upload JSON");
}

function getTabByText(text: string): HTMLElement {
  const tab = queryAllByRoleFast("tab").find((el) => {
    return el.textContent?.trim() === text;
  });
  if (!tab) {
    throw new Error(`Could not find tab: ${text}`);
  }
  return tab;
}

test("A user can inspect steps, context, and network details from an exported log", async () => {
  await setupPage({
    context,
    path: "/activities/inspect",
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });

  await waitFor(() => {
    expect(screen.getByText("No log loaded")).toBeInTheDocument();
  });
  expect(
    screen.getByText("Upload an activity log JSON file to inspect it."),
  ).toBeInTheDocument();

  const fileInput = getFileInput();
  const uploadLabel = screen.getByText("Upload JSON");
  expect(uploadLabel).not.toHaveAttribute("role", "button");
  // Upload through the visible label, so the test exercises its input association.
  await user.upload(uploadLabel, inspectFile());
  expect(fileInput).toHaveValue("");

  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Imported Analysis" }),
    ).toBeInTheDocument();
  });
  expect(screen.getByText("Done")).toBeInTheDocument();
  expect(screen.getByText("5.0s")).toBeInTheDocument();
  expect(screen.getByText(/^\d{2}:\d{2}:\d{2}\.000$/)).toBeInTheDocument();
  expect(
    screen.getAllByText(/^\d{2}:\d{2}:\d{2}\.000 \(\+00:01\.000\)$/),
  ).toHaveLength(2);
  expect(
    screen.getAllByText(/^\d{2}:\d{2}:\d{2}\.000 \(\+00:03\.000\)$/),
  ).toHaveLength(2);
  expect(
    screen.getByText("Collected OAuth evidence from network logs."),
  ).toBeInTheDocument();
  expect(
    screen.getByText("Summarized billing status for the workspace."),
  ).toBeInTheDocument();

  await fill(screen.getByPlaceholderText("Search steps"), "OAuth");

  await waitFor(() => {
    expect(screen.getByText("(1/2 matched)")).toBeInTheDocument();
  });
  expect(
    screen.getByText("Collected OAuth evidence from network logs."),
  ).toBeInTheDocument();
  expect(
    screen.queryByText("Summarized billing status for the workspace."),
  ).not.toBeInTheDocument();

  click(getTabByText("Context"));

  await waitFor(() => {
    expect(screen.getByText("github-token")).toBeInTheDocument();
  });
  expect(screen.getByText("ACCOUNT_ID")).toBeInTheDocument();
  expect(screen.getByText("acct_123")).toBeInTheDocument();
  expect(screen.getByText("storage-workspace")).toBeInTheDocument();
  expect(screen.getByText("artifact-storage")).toBeInTheDocument();
  expect(screen.getByText("Read only")).toBeInTheDocument();
  expect(screen.getByText("Read/write")).toBeInTheDocument();

  click(getTabByText("Network"));

  await waitFor(() => {
    expect(
      screen.getByText("https://api.github.com/repos/okou-ai/okou"),
    ).toBeInTheDocument();
  });
  const networkTable = screen.getByRole("table");
  expect(within(networkTable).getByText("GET")).toBeInTheDocument();
  expect(within(networkTable).getByText("200")).toBeInTheDocument();
  expect(within(networkTable).getByText("123ms")).toBeInTheDocument();
  expect(within(networkTable).getByText("github")).toBeInTheDocument();

  const networkRows = within(networkTable).getAllByRole("row");
  const networkRow = networkRows[1];
  if (!networkRow) {
    throw new Error("Expected a network log row");
  }
  const disclosure = queryAllByRoleFast("button", networkRow)[0];
  if (!disclosure) {
    throw new Error("Expected a network detail disclosure button");
  }
  expect(disclosure).toHaveAccessibleName(
    "https://api.github.com/repos/okou-ai/okou",
  );
  expect(disclosure).toHaveAttribute("aria-expanded", "false");
  const detailsId = disclosure.getAttribute("aria-controls");
  if (!detailsId) {
    throw new Error("Expected a controlled network detail row");
  }
  const details = document.getElementById(detailsId);
  expect(details).not.toBeVisible();

  const targetText = within(networkRow).getByText(
    "https://api.github.com/repos/okou-ai/okou",
  );
  expect(targetText.closest("button, a")).toBeNull();

  click(within(networkRow).getByText("200"));
  expect(disclosure).toHaveAttribute("aria-expanded", "true");
  expect(details).toBeVisible();

  click(networkRow);
  expect(disclosure).toHaveAttribute("aria-expanded", "false");
  expect(details).not.toBeVisible();

  await user.click(disclosure);
  await waitFor(() => {
    expect(screen.getByText("github-connector")).toBeInTheDocument();
  });
  expect(disclosure).toHaveAttribute("aria-expanded", "true");
  expect(disclosure).toHaveFocus();
  expect(details).toBeVisible();
  expect(details).toHaveRole("row");
  expect(screen.getAllByText("Connector Diagnostic")).toHaveLength(1);
  expect(screen.getByText("Request Headers (1)")).toBeInTheDocument();
  expect(screen.getByText("Response Headers (0)")).toBeInTheDocument();
  expect(screen.getAllByText("truncated")).toHaveLength(2);

  await user.keyboard("{Enter}");
  expect(disclosure).toHaveAttribute("aria-expanded", "false");
  expect(disclosure).toHaveFocus();
  expect(details).not.toBeVisible();

  await user.keyboard(" ");
  expect(disclosure).toHaveAttribute("aria-expanded", "true");
  expect(disclosure).toHaveFocus();
  expect(details).toBeVisible();

  const requestHeaders = screen.getByText("Request Headers (1)");
  await user.click(requestHeaders);
  expect(screen.getByText("Content-Type")).toBeVisible();
  expect(disclosure).toHaveAttribute("aria-expanded", "true");

  await user.click(disclosure);
  expect(disclosure).toHaveAttribute("aria-expanded", "false");
  expect(details).not.toBeVisible();
  const nextDisclosure = queryAllByRoleFast("button", networkTable).find(
    (button) => {
      return (
        button.getAttribute("aria-label") === "https://slack.com/api/auth.test"
      );
    },
  );
  if (!nextDisclosure) {
    throw new Error("Expected the next network detail disclosure button");
  }
  expect(nextDisclosure).not.toHaveAttribute("aria-controls", detailsId);
  await user.click(nextDisclosure);
  expect(nextDisclosure).toHaveFocus();
  expect(screen.getByText("slack-connector")).toBeInTheDocument();
  expect(disclosure).toHaveAttribute("aria-expanded", "false");
});

test("Selecting and copying a network URL preserves its request details", async () => {
  await setupPage({
    context,
    path: "/activities/inspect?tab=network",
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });
  await screen.findByText("No log loaded");
  await user.upload(getFileInput(), inspectFile());
  const target = "https://api.github.com/repos/okou-ai/okou";
  const url = await screen.findByText(target);
  const row = url.closest("tr");
  if (!row) {
    throw new Error("Expected the network URL in a request row");
  }
  const disclosure = queryAllByRoleFast("button", row)[0];
  if (!disclosure) {
    throw new Error("Expected a network detail disclosure button");
  }

  await user.pointer([
    { target: url, offset: 0, keys: "[MouseLeft>]" },
    { offset: target.length },
    { keys: "[/MouseLeft]" },
  ]);
  expect(window.getSelection()?.toString()).toBe(target);
  expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await user.copy();
  await expect(navigator.clipboard.readText()).resolves.toBe(target);

  // Explicit arrow activation still works while a URL selection exists.
  click(disclosure);
  expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await user.pointer([
    { target: url, offset: 0, keys: "[MouseLeft>]" },
    { offset: target.length },
    { keys: "[/MouseLeft]" },
  ]);
  expect(window.getSelection()?.toString()).toBe(target);
  expect(disclosure).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("github-connector")).toBeInTheDocument();

  window.getSelection()?.removeAllRanges();
  click(within(row).getByText("GET"));
  expect(disclosure).toHaveAttribute("aria-expanded", "false");
});

test("An imported log does not expose debug diagnostics when debug access is disabled", async () => {
  await setupPage({
    context,
    path: "/activities/inspect?tab=context",
  });

  await waitFor(() => {
    expect(screen.getByText("No log loaded")).toBeInTheDocument();
  });

  await user.upload(getFileInput(), inspectFile());

  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Imported Analysis" }),
    ).toBeInTheDocument();
  });

  expect(
    screen.getByText("Collected OAuth evidence from network logs."),
  ).toBeInTheDocument();
  expect(
    queryAllByRoleFast("tab").some((element) => {
      return element.textContent === "Context";
    }),
  ).toBeFalsy();
  expect(screen.queryByText("github-token")).not.toBeInTheDocument();
});

test("The inspector presents exported Codex events as readable activity steps", async () => {
  await setupPage({
    context,
    path: "/activities/inspect",
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });

  await waitFor(() => {
    expect(screen.getByText("No log loaded")).toBeInTheDocument();
  });

  await user.upload(getFileInput(), codexInspectFile());

  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Imported Codex Adapter Log" }),
    ).toBeInTheDocument();
  });

  expect(screen.getByText("Failed")).toBeInTheDocument();
  expect(
    screen.getByText("Codex inspect assistant output remains visible."),
  ).toBeInTheDocument();
  await expect(
    screen.findByText("[warning] Inspect adapter warning"),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText((_, element) => {
      return (
        element?.tagName === "P" &&
        element.textContent?.includes("Inspect normalized plan") === true
      );
    }),
  ).toBeInTheDocument();
  expect(
    screen.getAllByText(/Inspect transport failed \(inspect socket closed\)/u),
  ).toHaveLength(1);
  expect(
    screen.getByText(/Inspect turn failed \(inspect model stopped\)/u),
  ).toBeInTheDocument();
  expect(screen.queryByText(/\[object Object\]/u)).not.toBeInTheDocument();

  await fill(
    screen.getByPlaceholderText("Search steps"),
    "Inspect adapter warning",
  );

  await waitFor(() => {
    expect(screen.getByText("(1/4 matched)")).toBeInTheDocument();
  });
  expect(
    screen.getByText("[warning] Inspect adapter warning"),
  ).toBeInTheDocument();
  expect(
    screen.queryByText((_, element) => {
      return (
        element?.tagName === "P" &&
        element.textContent?.includes("Inspect normalized plan") === true
      );
    }),
  ).not.toBeInTheDocument();
});
