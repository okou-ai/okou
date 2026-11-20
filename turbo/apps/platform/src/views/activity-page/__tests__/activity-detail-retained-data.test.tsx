import {
  logsByIdContract,
  type LogDetail,
} from "@okouai/api-contracts/contracts/logs";
import {
  runAgentEventsContract,
  runContextContract,
  runNetworkLogsContract,
} from "@okouai/api-contracts/contracts/run-routes";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

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
      agentId: null,
      displayName: null,
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

  const heading = await screen.findByRole("heading", {
    name: "Log not found",
  });
  expect(heading.nextElementSibling).toHaveTextContent(
    "This log doesn't exist or you don't have permission to view it in the current workspace.",
  );
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
    agentId: "c0000000-0000-4000-a000-000000000061",
    displayName: "Invoice archive",
    triggerSource: "automation-schedule",
    prompt: "Archive last year's invoices",
    startedAt: "2025-12-02T09:00:01.000Z",
    completedAt: "2025-12-02T09:00:30.000Z",
  });
  context.mocks.api(runAgentEventsContract.getAgentEvents, ({ respond }) => {
    return respond(200, {
      events: [event],
      hasMore: false,
      status: "completed",
      lastEventSequence: 1,
    });
  });
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
      displayName: "Invoice archive",
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
