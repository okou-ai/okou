import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NetworkLogEntry } from "@okouai/api-contracts/contracts/runs";
import type { RunContextResponse } from "@okouai/api-contracts/contracts/run-routes";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type {
  AgentEvent,
  LogDetail,
} from "../../../signals/okou-page/log-types.ts";

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
    error: null,
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
  const runContext: RunContextResponse = {
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
    error: "Inspect adapter failed",
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
  const runContext: RunContextResponse = {
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

function codexThreadItemsInspectFile(): File {
  const meta: Partial<LogDetail> = {
    id: "b0000000-0000-4000-a000-000000000779",
    sessionId: "codex-thread-items-session",
    agentId: "c0000000-0000-4000-a000-000000000003",
    displayName: "Imported Codex Thread Items",
    framework: "codex",
    modelProvider: null,
    selectedModel: null,
    triggerSource: "test",
    status: "completed",
    prompt: "Inspect Codex thread items",
    appendSystemPrompt: null,
    error: null,
    createdAt: "2026-03-10T18:00:00Z",
    startedAt: "2026-03-10T18:00:01Z",
    completedAt: "2026-03-10T18:00:12Z",
  };
  const events: AgentEvent[] = [
    {
      sequenceNumber: 0,
      eventType: "item.started",
      eventData: {
        type: "item.started",
        item: {
          id: "collab-new-shape",
          type: "collab_agent_tool_call",
          tool: "spawn_agent",
          status: "in_progress",
          receiver_thread_ids: ["subagent-new"],
          prompt: "inspect the new guest shape",
          model: "gpt-5",
          reasoning_effort: "high",
          agents_states: {
            "subagent-new": { status: "running", message: null },
          },
        },
      },
      createdAt: "2026-03-10T18:00:02Z",
    },
    {
      sequenceNumber: 1,
      eventType: "item.completed",
      eventData: {
        type: "item.completed",
        item: {
          id: "collab-new-shape",
          type: "collab_agent_tool_call",
          tool: "spawn_agent",
          status: "completed",
          receiver_thread_ids: ["subagent-new"],
          prompt: "inspect the new guest shape",
          model: "gpt-5",
          reasoning_effort: "high",
          agents_states: {
            "subagent-new": {
              status: "completed",
              message: "new shape inspected",
            },
          },
        },
      },
      createdAt: "2026-03-10T18:00:03Z",
    },
    {
      sequenceNumber: 2,
      eventType: "item.completed",
      eventData: {
        type: "item.completed",
        item: {
          id: "collab-old-shape",
          type: "collab_agent_tool_call",
          tool: "spawn_agent",
          status: "completed",
          receiver_thread_ids: ["subagent-old"],
          prompt: "inspect the old guest shape",
          model: "gpt-5",
          reasoning_effort: "medium",
          agents_states: {},
        },
      },
      createdAt: "2026-03-10T18:00:04Z",
    },
    ...["started", "interacted", "interrupted", "completed"].map(
      (kind, index): AgentEvent => {
        return {
          sequenceNumber: index + 3,
          eventType: "item.completed",
          eventData: {
            type: "item.completed",
            item: {
              id: `subagent-activity-${kind}`,
              type: "sub_agent_activity",
              kind,
              agent_thread_id: "subagent-new",
              agent_path: "/root/researcher",
            },
          },
          createdAt: `2026-03-10T18:00:0${index + 5}Z`,
        };
      },
    ),
    {
      sequenceNumber: 7,
      eventType: "item.started",
      eventData: {
        type: "item.started",
        item: { id: "context-compaction", type: "context_compaction" },
      },
      createdAt: "2026-03-10T18:00:09Z",
    },
    {
      sequenceNumber: 8,
      eventType: "item.completed",
      eventData: {
        type: "item.completed",
        item: { id: "context-compaction", type: "context_compaction" },
      },
      createdAt: "2026-03-10T18:00:10Z",
    },
    {
      sequenceNumber: 9,
      eventType: "item.completed",
      eventData: {
        type: "item.completed",
        item: {
          id: "future-item",
          type: "future_operation",
          status: "completed",
          label: "future item remains generic",
        },
      },
      createdAt: "2026-03-10T18:00:11Z",
    },
  ];

  return new File(
    [JSON.stringify({ meta, events, networkLogs: [] })],
    "codex-thread-items-log.json",
    { type: "application/json" },
  );
}

function oversizedInspectFile(): File {
  const file = new File(["{}"], "oversized-activity-log.json", {
    type: "application/json",
  });
  Object.defineProperty(file, "size", {
    value: 26 * 1024 * 1024,
  });
  Object.defineProperty(file, "text", {
    value: () => {
      return Promise.reject(new Error("oversized file should not be read"));
    },
  });
  return file;
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
  click(networkRow);
  await waitFor(() => {
    expect(screen.getByText("github-connector")).toBeInTheDocument();
  });
  expect(screen.getAllByText("Connector Diagnostic")).toHaveLength(1);
  expect(screen.getByText("Request Headers (1)")).toBeInTheDocument();
  expect(screen.getByText("Response Headers (0)")).toBeInTheDocument();
  expect(screen.getAllByText("truncated")).toHaveLength(2);
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

test("Imported activities preserve their trigger source", async () => {
  await setupPage({ context, path: "/activities/inspect" });
  await screen.findByText("No log loaded");
  await user.upload(getFileInput(), inspectFile());
  await screen.findByRole("heading", { name: "Imported Analysis" });
  expect(screen.getByText("Source")).toBeInTheDocument();
  expect(screen.getByText("Test")).toBeInTheDocument();
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

test("The activity inspector explains Codex collaboration events", async () => {
  await setupPage({
    context,
    path: "/activities/inspect",
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });

  await waitFor(() => {
    expect(screen.getByText("No log loaded")).toBeInTheDocument();
  });

  await user.upload(getFileInput(), codexThreadItemsInspectFile());

  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Imported Codex Thread Items" }),
    ).toBeInTheDocument();
  });

  expect(screen.getAllByTestId("tool-summary")).toHaveLength(2);
  expect(screen.getAllByText("SpawnAgent")).toHaveLength(2);
  expect(screen.getByText("Started subagent")).toBeInTheDocument();
  expect(screen.getByText("Interacted with subagent")).toBeInTheDocument();
  expect(screen.getByText("Interrupted subagent")).toBeInTheDocument();
  expect(screen.getByText("Completed subagent")).toBeInTheDocument();
  expect(screen.getAllByText("/root/researcher")).toHaveLength(4);
  expect(screen.getAllByText("Compacted context")).toHaveLength(1);
  expect(screen.getByText(/Codex future_operation/u)).toBeInTheDocument();
  expect(screen.queryByText("Unknown")).not.toBeInTheDocument();
  expect(
    screen.queryByText(/Codex collab_agent_tool_call/u),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText(/Codex sub_agent_activity/u),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText(/Codex context_compaction/u),
  ).not.toBeInTheDocument();
});

test("The inspector rejects activity logs larger than 25 MB", async () => {
  await setupPage({
    context,
    path: "/activities/inspect",
  });

  await waitFor(() => {
    expect(screen.getByText("No log loaded")).toBeInTheDocument();
  });

  await user.upload(getFileInput(), oversizedInspectFile());

  await waitFor(() => {
    expect(
      screen.getByText(
        "JSON file is too large. Upload an exported activity log JSON file under 25 MB.",
      ),
    ).toBeInTheDocument();
  });
  expect(
    screen.queryByRole("heading", { name: "Imported Log" }),
  ).not.toBeInTheDocument();
});
