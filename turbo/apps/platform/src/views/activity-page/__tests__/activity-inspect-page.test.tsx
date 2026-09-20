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
import { createDeferredPromise } from "../../../signals/utils.ts";
import type {
  AgentEvent,
  LogDetail,
} from "../../../signals/okou-page/log-types.ts";

const context = testContext();
const user = userEvent.setup();

function inspectFile(
  triggerSource: NonNullable<LogDetail["triggerSource"]> = "test",
): File {
  const meta: Partial<LogDetail> = {
    id: "b0000000-0000-4000-a000-000000000777",
    sessionId: "session-inspect",
    agentId: "c0000000-0000-4000-a000-000000000001",
    displayName: "Imported Analysis",
    framework: "claude-code",
    modelProvider: null,
    selectedModel: null,
    triggerSource,
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
      url: "https://api.github.com/repos/vm0-ai/vm0",
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

function inspectPayload(displayName: string, text: string) {
  return {
    meta: {
      displayName,
      status: "completed",
      triggerSource: "test",
      createdAt: "2026-03-10T14:56:00Z",
      startedAt: "2026-03-10T14:56:01Z",
      completedAt: "2026-03-10T14:56:02Z",
    },
    events: [
      {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              {
                type: "text",
                text,
              },
            ],
          },
        },
        createdAt: "2026-03-10T14:56:02Z",
      },
    ],
  };
}

function inspectFileWithDeferredText(
  fileName: string,
  textPromise: Promise<string>,
): File {
  const file = new File([], fileName, { type: "application/json" });
  Object.defineProperty(file, "text", {
    value: () => {
      return textPromise;
    },
  });
  return file;
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

function malformedInspectFile(): File {
  return new File(
    [
      JSON.stringify({
        meta: {
          displayName: { nested: true },
          status: "not-a-status",
          triggerSource: "not-a-source",
          prompt: { nested: true },
          appendSystemPrompt: { nested: true },
          source: {
            providerType: null,
            runtimeProviderType: null,
            model: null,
            credentialScope: null,
            account: { status: "unknown" },
          },
          createdAt: "bad-log-created-at",
          startedAt: "bad-started-at",
          completedAt: "bad-completed-at",
        },
        events: [
          null,
          {
            sequenceNumber: "bad-sequence",
            eventType: "assistant",
            eventData: {
              message: {
                content: [{ type: "text", text: "Invalid event is dropped." }],
              },
            },
            createdAt: "2026-03-10T17:00:01Z",
          },
          {
            sequenceNumber: 0,
            eventType: "assistant",
            eventData: {
              message: {
                content: [
                  {
                    type: "text",
                    text: "Valid imported event survives.",
                  },
                ],
              },
            },
            createdAt: "bad-created-at",
          },
          {
            sequenceNumber: 1,
            eventType: "result",
            eventData: {
              type: "result",
              is_error: false,
              result: "Negative duration result survives.",
              duration_ms: -100,
              num_turns: 1,
            },
            createdAt: "2026-03-10T17:00:03Z",
          },
        ],
        context: { bad: true },
        networkLogs: [
          null,
          {
            timestamp: "not-a-date",
            type: "http",
            method: "GET",
            url: "https://example.com/imported-valid-network-log",
            latency_ms: -5,
          },
          {
            timestamp: { nested: true },
            url: "https://example.com/invalid-network-log",
          },
        ],
      }),
    ],
    "malformed-activity-log.json",
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
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) {
    throw new Error("Could not find inspect log file input");
  }
  return input;
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

  await user.upload(getFileInput(), inspectFile());

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
      screen.getByText("https://api.github.com/repos/vm0-ai/vm0"),
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

  click(networkRow);
  await waitFor(() => {
    expect(screen.queryByText("github-connector")).not.toBeInTheDocument();
  });

  const secondNetworkRow = networkRows[2];
  if (!secondNetworkRow) {
    throw new Error("Expected a second network log row");
  }
  click(secondNetworkRow);
  await waitFor(() => {
    expect(screen.getByText("slack-connector")).toBeInTheDocument();
  });
  expect(screen.getAllByText("Connector Diagnostic")).toHaveLength(1);
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

test.each([
  { source: "automation-schedule", label: "Automation schedule" },
  { source: "feishu", label: "Feishu" },
  { source: "lark", label: "Lark" },
] as const)(
  "Imported activities preserve their $source trigger source",
  async ({ source, label }) => {
    await setupPage({
      context,
      path: "/activities/inspect",
    });

    await expect(
      screen.findByText("No log loaded"),
    ).resolves.toBeInTheDocument();

    await user.upload(getFileInput(), inspectFile(source));

    await expect(
      screen.findByRole("heading", { name: "Imported Analysis" }),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText("Source")).toBeInTheDocument();
    expect(screen.getByText(label)).toBeInTheDocument();
  },
);

test("The most recently selected activity log remains authoritative", async () => {
  await setupPage({
    context,
    path: "/activities/inspect",
  });

  await waitFor(() => {
    expect(screen.getByText("No log loaded")).toBeInTheDocument();
  });

  const staleRead = createDeferredPromise<string>(AbortSignal.any([]));
  const latestRead = createDeferredPromise<string>(AbortSignal.any([]));

  await user.upload(
    getFileInput(),
    inspectFileWithDeferredText("stale-log.json", staleRead.promise),
  );
  await user.upload(
    getFileInput(),
    inspectFileWithDeferredText("latest-log.json", latestRead.promise),
  );

  latestRead.resolve(
    JSON.stringify(inspectPayload("Latest Imported Log", "latest log text")),
  );

  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Latest Imported Log" }),
    ).toBeInTheDocument();
  });
  expect(screen.getByText("latest log text")).toBeInTheDocument();

  staleRead.resolve(
    JSON.stringify(inspectPayload("Stale Imported Log", "stale log text")),
  );
  await staleRead.promise;

  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Latest Imported Log" }),
    ).toBeInTheDocument();
  });
  expect(
    screen.queryByRole("heading", { name: "Stale Imported Log" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("stale log text")).not.toBeInTheDocument();
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

test("The inspector salvages valid diagnostics from a partially malformed log", async () => {
  await setupPage({
    context,
    path: "/activities/inspect",
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });

  await waitFor(() => {
    expect(screen.getByText("No log loaded")).toBeInTheDocument();
  });

  await user.upload(getFileInput(), malformedInspectFile());

  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Imported Log" }),
    ).toBeInTheDocument();
  });
  expect(screen.getByText("Done")).toBeInTheDocument();
  expect(
    screen.getByText("Valid imported event survives."),
  ).toBeInTheDocument();
  expect(
    screen.getByText("Negative duration result survives."),
  ).toBeInTheDocument();
  expect(
    screen.queryByText("Invalid event is dropped."),
  ).not.toBeInTheDocument();
  expect(screen.queryByText(/\[object Object\]/u)).not.toBeInTheDocument();
  expect(screen.getByText("bad-log-created-at")).toBeInTheDocument();
  expect(screen.getAllByText("bad-created-at").length).toBeGreaterThan(0);
  expect(screen.queryByText("Invalid Date")).not.toBeInTheDocument();
  expect(screen.queryByText(/NaN/u)).not.toBeInTheDocument();
  expect(screen.queryByText("-100ms")).not.toBeInTheDocument();

  click(getTabByText("Context"));

  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Context not available" }),
    ).toBeInTheDocument();
  });

  click(getTabByText("Network"));

  await waitFor(() => {
    expect(
      screen.getByText("https://example.com/imported-valid-network-log"),
    ).toBeInTheDocument();
  });
  expect(screen.getByText("not-a-date")).toBeInTheDocument();
  expect(screen.queryByText("-5ms")).not.toBeInTheDocument();
  expect(screen.queryByText(/NaN/u)).not.toBeInTheDocument();
  expect(
    screen.queryByText("https://example.com/invalid-network-log"),
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

test("The inspector recovers after an invalid JSON upload", async () => {
  await setupPage({
    context,
    path: "/activities/inspect",
  });

  await waitFor(() => {
    expect(screen.getByText("No log loaded")).toBeInTheDocument();
  });

  await user.upload(
    getFileInput(),
    new File(["{ invalid json"], "invalid-log.json", {
      type: "application/json",
    }),
  );

  await waitFor(() => {
    expect(
      screen.getByText(
        "Invalid JSON file. Upload an exported activity log JSON file.",
      ),
    ).toBeInTheDocument();
  });
  expect(
    screen.queryByRole("heading", { name: "Imported Analysis" }),
  ).not.toBeInTheDocument();

  await user.upload(getFileInput(), inspectFile());

  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Imported Analysis" }),
    ).toBeInTheDocument();
  });
  expect(
    screen.queryByText(
      "Invalid JSON file. Upload an exported activity log JSON file.",
    ),
  ).not.toBeInTheDocument();
});
