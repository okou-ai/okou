import {
  logsByIdContract,
  type LogDetail,
} from "@okouai/api-contracts/contracts/logs";
import {
  runTelemetryEventsContract,
  runContextContract,
  runNetworkLogsContract,
  runRunnerContract,
} from "@okouai/api-contracts/contracts/run-routes";
import { screen, waitFor, fireEvent, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { type SandboxStartupPath } from "@okouai/api-contracts/contracts/runner-primitives";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import userEvent from "@testing-library/user-event";

const context = testContext();

const RUN_ID = "d0000000-0000-4000-a000-000000000f61";

/** The activity lookup; an unknown run answers with the API's not-found error. */
function serveActivity(
  activity: (Partial<LogDetail> & Pick<LogDetail, "id">) | null,
): void {
  context.mocks.api(logsByIdContract.getById, ({ params, respond }) => {
    if (activity?.id !== params.id) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: `Run ${params.id} not found` },
      });
    }
    return respond(200, {
      sessionId: null,
      framework: "claude-code",
      modelProvider: null,
      selectedModel: null,
      triggerSource: "web",
      status: "completed",
      prompt: "",
      appendSystemPrompt: null,
      createdAt: "2025-12-02T09:00:00.000Z",
      startedAt: null,
      completedAt: null,
      ...activity,
    });
  });
}

test("An unavailable activity shows a clear not-found page", async () => {
  serveActivity(null);

  await setupPage({ context, path: `/activities/${RUN_ID}` });

  await expect(
    screen.findByRole("heading", { name: "Log not found" }),
  ).resolves.toBeInTheDocument();
});

test("A user can download all retained diagnostics for an older activity", async () => {
  const event = {
    sequenceNumber: 1,
    eventType: "assistant",
    eventData: {
      type: "assistant",
      message: { content: [{ type: "text", text: "Archived the invoices." }] },
    },
    createdAt: "2025-12-02T09:00:05.000Z",
  };
  const runContext = {
    prompt: "Archive last year's invoices",
    appendSystemPrompt: null,
    runId: RUN_ID,
    sessionId: "session-f61",
    secretNames: ["ARCHIVE_TOKEN"],
    vars: { ARCHIVE_YEAR: "2025" },
    environment: { TZ: "UTC" },
    firewalls: [],
    networkPolicies: null,
    storageMounts: [
      {
        name: "invoice-archive",
        version: "v12",
        mountPath: "/workspace/archive",
        writeback: true,
      },
    ],
    featureFlags: null,
  };
  const networkLog = {
    timestamp: "2025-12-02T09:00:03.000Z",
    type: "http",
    method: "GET",
    url: "https://billing.example.test/v1/invoices?year=2025",
    host: "billing.example.test",
    status: 200,
    latency_ms: 210,
  };
  serveActivity({
    id: RUN_ID,
    sessionId: "session-f61",
    triggerSource: "automation-schedule",
    prompt: "Archive last year's invoices",
    startedAt: "2025-12-02T09:00:01.000Z",
    completedAt: "2025-12-02T09:00:30.000Z",
  });
  context.mocks.api(
    runTelemetryEventsContract.getTelemetryEvents,
    ({ respond }) => {
      return respond(200, {
        events: [event],
        hasMore: false,
        status: "completed",
        lastEventSequence: 1,
      });
    },
  );
  context.mocks.api(runContextContract.getContext, ({ respond }) => {
    return respond(200, runContext);
  });
  context.mocks.api(runNetworkLogsContract.getNetworkLogs, ({ respond }) => {
    return respond(200, { networkLogs: [networkLog], hasMore: false });
  });
  const browser = context.mocks.browser.blobDownload();
  await setupPage({ context, path: `/activities/${RUN_ID}` });
  await expect(
    screen.findByText("Archived the invoices."),
  ).resolves.toBeInTheDocument();
  const download = queryAllByRoleFast("button").find((button) => {
    return button.getAttribute("aria-label") === "Download raw data";
  });

  click(download as HTMLElement);

  await waitFor(() => {
    expect(
      browser.downloads.map((file) => {
        return file.filename;
      }),
    ).toStrictEqual([`${RUN_ID}-logs.json`]);
  });
  const blob = browser.downloads[0]?.blob;
  expect(blob?.type).toContain("application/json");
  const exported: unknown = JSON.parse((await blob?.text()) ?? "");
  expect(exported).toMatchObject({
    meta: {
      id: RUN_ID,
      status: "completed",
      triggerSource: "automation-schedule",
      framework: "claude-code",
      prompt: "Archive last year's invoices",
      createdAt: "2025-12-02T09:00:00.000Z",
    },
    events: [event],
    context: runContext,
    networkLogs: [networkLog],
  });
});

interface RunnerFixture {
  readonly framework: string;
  readonly sandboxStartupPath: SandboxStartupPath | null;
  readonly runnerHostname: string;
  readonly runnerVersion?: string;
  readonly runnerId?: string;
  readonly runnerHeartbeatGeneration?: number;
}

/** Serves completed activities whose runner details the API persisted. */
function mockActivities(runs: Readonly<Record<string, RunnerFixture>>): void {
  context.mocks.api(logsByIdContract.getById, ({ params, respond }) => {
    const run = runs[params.id];
    if (!run) {
      return respond(404, {
        error: { message: "Log not found", code: "NOT_FOUND" },
      });
    }
    return respond(200, {
      id: params.id,
      sessionId: null,
      framework: run.framework,
      modelProvider: null,
      selectedModel: null,
      triggerSource: "web",
      status: "completed",
      prompt: "Check the runner",
      appendSystemPrompt: null,
      createdAt: "2026-11-20T10:00:00.000Z",
      startedAt: "2026-11-20T10:00:01.000Z",
      completedAt: "2026-11-20T10:00:40.000Z",
    });
  });
  context.mocks.api(runRunnerContract.getRunner, ({ params, respond }) => {
    const run = runs[params.id];
    if (!run) {
      return respond(404, {
        error: { message: "Run not found", code: "NOT_FOUND" },
      });
    }
    return respond(200, {
      sandboxStartupPath: run.sandboxStartupPath,
      runnerHostname: run.runnerHostname,
      runnerVersion: run.runnerVersion ?? null,
      runnerId: run.runnerId ?? null,
      runnerHeartbeatGeneration: run.runnerHeartbeatGeneration ?? null,
    });
  });
}

function runnerPath(runId: string): string {
  return `/activities/${runId}?tab=runner`;
}

async function openRunner(runId: string): Promise<void> {
  await setupPage({
    context,
    path: runnerPath(runId),
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });
}

/** The browser moves to another activity's runner diagnostics. */
function visitRunner(runId: string): void {
  window.history.pushState({}, "", runnerPath(runId));
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** The value listed under a runner attribution label. */
function runnerField(label: string): string | undefined {
  const term = [...document.querySelectorAll("dt")].find((candidate) => {
    return candidate.textContent?.trim() === label;
  });
  return term?.nextElementSibling?.textContent?.trim();
}

async function findHostname(hostname: string): Promise<void> {
  await waitFor(() => {
    expect(runnerField("Hostname")).toBe(hostname);
  });
}

function startupCard(): { label: string; description: string } {
  const heading = [...document.querySelectorAll("h4")].find((candidate) => {
    return candidate.textContent?.trim() === "Startup";
  });
  const card = heading?.closest("article");
  if (!heading || !card) {
    throw new Error("Expected the Startup card");
  }
  return {
    label: heading.nextElementSibling?.textContent?.trim() ?? "",
    description: card.querySelector("p")?.textContent?.trim() ?? "",
  };
}

const CLAUDE_RUN = "d0000000-0000-4000-a000-000000000f71";
const CODEX_RUN = "d0000000-0000-4000-a000-000000000f72";
const PI_RUN = "d0000000-0000-4000-a000-000000000f73";

test("Runner diagnostics identify the exact environment used for an activity", async () => {
  mockActivities({
    [CLAUDE_RUN]: {
      framework: "claude-code",
      sandboxStartupPath: null,
      runnerHostname: "prod-1.aws.vm3.ai",
      runnerVersion: "0.168.14",
      runnerId: "b0000000-0000-4000-a000-000000000001",
      runnerHeartbeatGeneration: 7,
    },
    [CODEX_RUN]: {
      framework: "codex",
      sandboxStartupPath: null,
      runnerHostname: "prod-2.aws.vm3.ai",
      runnerVersion: "0.168.14",
      runnerId: "b0000000-0000-4000-a000-000000000002",
      runnerHeartbeatGeneration: 8,
    },
    [PI_RUN]: {
      framework: "pi",
      sandboxStartupPath: null,
      runnerHostname: "prod-3.aws.vm3.ai",
    },
  });
  await openRunner(CLAUDE_RUN);
  await findHostname("prod-1.aws.vm3.ai");
  expect(runnerField("Framework")).toBe("Claude Code");
  expect(runnerField("Version")).toBe("0.168.14");
  expect(runnerField("Runner ID")).toBe("b0000000-0000-4000-a000-000000000001");
  expect(runnerField("Generation")).toBe("7");

  visitRunner(CODEX_RUN);

  await findHostname("prod-2.aws.vm3.ai");
  expect(runnerField("Framework")).toBe("Codex");
  expect(runnerField("Version")).toBe("0.168.14");
  expect(runnerField("Runner ID")).toBe("b0000000-0000-4000-a000-000000000002");
  expect(runnerField("Generation")).toBe("8");
  expect(screen.queryByText("prod-1.aws.vm3.ai")).not.toBeInTheDocument();

  visitRunner(PI_RUN);

  await findHostname("prod-3.aws.vm3.ai");
  expect(runnerField("Framework")).toBe("pi");
  expect(screen.queryByText("prod-2.aws.vm3.ai")).not.toBeInTheDocument();
});

test("Runner diagnostics display each persisted startup path", async () => {
  const runs = [
    {
      runId: "d0000000-0000-4000-a000-000000000f81",
      path: "sandbox",
      label: "Sandbox reuse",
      description: "The sandbox and its workspace were reused.",
    },
    {
      runId: "d0000000-0000-4000-a000-000000000f82",
      path: "home",
      label: "Home reuse",
      description: "A fresh sandbox restored a cached home directory.",
    },
    {
      runId: "d0000000-0000-4000-a000-000000000f83",
      path: "cold",
      label: "Cold start",
      description: "A fresh sandbox and workspace were prepared.",
    },
    {
      runId: "d0000000-0000-4000-a000-000000000f84",
      path: "blank",
      label: "Blank start",
      description: "A prepared sandbox started with a fresh home directory.",
    },
  ] as const;
  mockActivities(
    Object.fromEntries(
      runs.map(({ runId, path }) => {
        return [
          runId,
          {
            framework: "claude-code",
            sandboxStartupPath: path,
            runnerHostname: `${path}-runner`,
          },
        ];
      }),
    ),
  );
  await openRunner(runs[0].runId);

  for (const [index, run] of runs.entries()) {
    if (index > 0) {
      visitRunner(run.runId);
    }
    await findHostname(`${run.path}-runner`);
    expect(startupCard()).toStrictEqual({
      label: run.label,
      description: run.description,
    });
  }
});

test("Runner metadata remains visible when the startup path is unreported", async () => {
  const runId = "d0000000-0000-4000-a000-000000000f91";
  mockActivities({
    [runId]: {
      framework: "claude-code",
      sandboxStartupPath: null,
      runnerHostname: "available-runner",
    },
  });

  await openRunner(runId);

  await findHostname("available-runner");
  expect(startupCard().label).toBe("Unknown");
});

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
