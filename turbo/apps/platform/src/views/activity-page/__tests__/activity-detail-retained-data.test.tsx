import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { logsByIdContract } from "@okouai/api-contracts/contracts/logs";
import type { NetworkLogEntry } from "@okouai/api-contracts/contracts/runs";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  runAgentEventsContract,
  runContextContract,
  runNetworkLogsContract,
  type RunContextResponse,
} from "@okouai/api-contracts/contracts/run-routes";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type {
  AgentEvent,
  LogDetail,
} from "../../../signals/okou-page/log-types.ts";

const context = testContext();

const RUN_ID = "a0000000-0000-4000-a000-000000000399";
const SELECTED_MODEL = "gpt-5.6-luna";
const DIRECT_PROVIDER = "codex-oauth-token";
const RUNTIME_PROVIDER = "openrouter-codex";
const RUNTIME_MODEL = "openai/gpt-5.6-luna";

function logDetail(): LogDetail {
  return {
    id: RUN_ID,
    sessionId: "session-1",
    agentId: "c0000000-0000-4000-a000-000000000001",
    displayName: "Checkout Export",
    framework: "claude-code",
    modelProvider: null,
    selectedModel: null,
    triggerSource: "web",
    status: "completed",
    prompt: "Export checkout diagnostics",
    appendSystemPrompt: null,
    error: null,
    createdAt: "2026-03-10T14:56:00Z",
    startedAt: "2026-03-10T14:56:01Z",
    completedAt: "2026-03-10T14:56:10Z",
    artifact: { name: null, version: null },
  };
}

function managedLogDetail(): LogDetail {
  return {
    ...logDetail(),
    modelProvider: "built-in",
    selectedModel: SELECTED_MODEL,
    modelRuntimeProvider: RUNTIME_PROVIDER,
    modelRuntimeModel: RUNTIME_MODEL,
  };
}

function directProviderLogDetail(): LogDetail {
  return {
    ...logDetail(),
    modelProvider: DIRECT_PROVIDER,
    selectedModel: SELECTED_MODEL,
  };
}

function runContext(): RunContextResponse {
  return {
    prompt: "Export checkout diagnostics",
    appendSystemPrompt: null,
    runId: RUN_ID,
    sessionId: "session-1",
    cliAgentType: "codex",
    secretNames: [],
    vars: null,
    environment: {},
    firewalls: [],
    networkPolicies: null,
    volumes: [],
    artifact: null,
    featureFlags: null,
  };
}

function networkLog(): NetworkLogEntry {
  return {
    timestamp: "2026-03-10T14:56:03Z",
    type: "http",
    action: "ALLOW",
    host: "payments.example.test",
    port: 443,
    method: "POST",
    url: "https://payments.example.test/v1/checkout",
    status: 200,
  };
}

function activityEvent(): AgentEvent {
  return {
    sequenceNumber: 0,
    eventType: "assistant",
    eventData: {
      message: {
        content: [{ type: "text", text: "Checkout diagnostics exported" }],
      },
    },
    createdAt: "2026-03-10T14:56:02Z",
  };
}

test("An unavailable activity shows a clear not-found page", async () => {
  context.mocks.api(logsByIdContract.getById, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Log not found" },
    });
  });

  await setupPage({ context, path: `/activities/${RUN_ID}` });

  await expect(
    screen.findByRole("heading", { name: "Log not found" }),
  ).resolves.toBeInTheDocument();
});

test("A user can download all retained diagnostics for an older activity", async () => {
  const downloads = context.mocks.browser.blobDownload();
  context.mocks.api(logsByIdContract.getById, ({ respond }) => {
    return respond(200, logDetail());
  });
  context.mocks.api(runAgentEventsContract.getAgentEvents, ({ respond }) => {
    return respond(200, {
      events: [activityEvent()],
      hasMore: false,
      status: "completed",
      lastEventSequence: 0,
    });
  });
  context.mocks.api(runContextContract.getContext, ({ respond }) => {
    return respond(200, runContext());
  });
  context.mocks.api(runNetworkLogsContract.getNetworkLogs, ({ respond }) => {
    return respond(200, {
      networkLogs: [networkLog()],
      hasMore: false,
    });
  });

  await setupPage({ context, path: `/activities/${RUN_ID}` });
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Checkout Export" }),
    ).toBeInTheDocument();
  });
  await expect(
    screen.findByText("Checkout diagnostics exported"),
  ).resolves.toBeInTheDocument();

  click(screen.getByLabelText("Download raw data"));
  await waitFor(() => {
    expect(downloads.downloads).toHaveLength(1);
  });

  const download = downloads.downloads[0];
  if (!download?.blob) {
    throw new Error("Downloaded activity blob was not captured");
  }
  const downloaded = JSON.parse(await download.blob.text()) as Record<
    string,
    unknown
  >;

  expect(download.filename).toBe(`${RUN_ID}-logs.json`);
  expect(downloaded.events).toStrictEqual([activityEvent()]);
  expect(downloaded.meta).toMatchObject({
    id: RUN_ID,
    displayName: "Checkout Export",
    framework: "codex",
  });
  expect(downloaded.context).toMatchObject({ runId: RUN_ID });
  expect(downloaded.networkLogs).toStrictEqual([networkLog()]);
});

test("Activity context lists model route fields without runtime metadata", async () => {
  context.mocks.api(logsByIdContract.getById, ({ respond }) => {
    return respond(200, directProviderLogDetail());
  });
  context.mocks.api(runContextContract.getContext, ({ respond }) => {
    return respond(200, runContext());
  });

  await setupPage({
    context,
    path: `/activities/${RUN_ID}?tab=context`,
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });

  const modelRouteHeading = await screen.findByRole("heading", {
    name: "Model Route",
  });
  const modelRouteSection = modelRouteHeading.closest("section");
  if (!modelRouteSection) {
    throw new Error("Model route section was not rendered");
  }
  const modelRoute = within(modelRouteSection);
  const expectedRows = [
    ["Selected Model", SELECTED_MODEL],
    ["Model Provider", DIRECT_PROVIDER],
    ["Runtime Provider", "null"],
    ["Runtime Model", "null"],
  ] as const;
  for (const [label, value] of expectedRows) {
    const row = modelRoute.getByText(label).closest("tr");
    if (!row) {
      throw new Error(`Model route row was not rendered: ${label}`);
    }
    expect(within(row).getByText(value)).toBeInTheDocument();
  }
});

test("Diagnostic export remains available when run context was not retained", async () => {
  const downloads = context.mocks.browser.blobDownload();
  context.mocks.api(logsByIdContract.getById, ({ respond }) => {
    return respond(200, managedLogDetail());
  });
  context.mocks.api(runContextContract.getContext, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Run context not available" },
    });
  });
  context.mocks.api(runNetworkLogsContract.getNetworkLogs, ({ respond }) => {
    return respond(200, { networkLogs: [], hasMore: false });
  });

  await setupPage({
    context,
    path: `/activities/${RUN_ID}?tab=context`,
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Checkout Export" }),
    ).toBeInTheDocument();
  });
  await expect(
    screen.findByRole("heading", { name: "Model Route" }),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText(RUNTIME_PROVIDER)).toBeInTheDocument();
  expect(screen.getByText(RUNTIME_MODEL)).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Context not available" }),
  ).toBeInTheDocument();

  click(screen.getByLabelText("Download raw data"));
  await waitFor(() => {
    expect(downloads.downloads).toHaveLength(1);
  });

  const download = downloads.downloads[0];
  if (!download?.blob) {
    throw new Error("Downloaded activity blob was not captured");
  }
  const downloaded = JSON.parse(await download.blob.text()) as Record<
    string,
    unknown
  >;

  expect(download.filename).toBe(`${RUN_ID}-logs.json`);
  expect(downloaded.meta).toMatchObject({
    modelProvider: "built-in",
    selectedModel: SELECTED_MODEL,
    modelRuntimeProvider: RUNTIME_PROVIDER,
    modelRuntimeModel: RUNTIME_MODEL,
  });
  expect(downloaded.events).toStrictEqual([]);
  expect(downloaded).not.toHaveProperty("context");
  expect(downloaded.networkLogs).toStrictEqual([]);
});
