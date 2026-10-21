import { screen, waitFor, within } from "@testing-library/react";
import { logsByIdContract } from "@okouai/api-contracts/contracts/logs";
import {
  runAgentEventsContract,
  runRunnerContract,
  type RunRunnerResponse,
} from "@okouai/api-contracts/contracts/run-routes";
import type { SandboxStartupPath } from "@okouai/api-contracts/contracts/runner-primitives";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { detachedNavigateTo$ } from "../../../signals/route.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type {
  AgentEventsResponse,
  LogDetail,
  LogStatus,
} from "../../../signals/okou-page/log-types.ts";

const context = testContext();

interface ActivityFixture {
  readonly status: LogStatus;
  readonly framework?: string | null;
  readonly runner: RunRunnerResponse;
}

function logDetail(
  runId: string,
  status: LogStatus,
  framework: string | null = "claude-code",
): LogDetail {
  return {
    id: runId,
    sessionId: "session-runner-attribution",
    agentId: "c0000000-0000-4000-a000-000000000001",
    displayName: "Runner Attribution",
    framework,
    modelProvider: null,
    selectedModel: null,
    triggerSource: "web",
    status,
    prompt: "Inspect runner attribution",
    appendSystemPrompt: null,
    error: null,
    createdAt: "2026-08-26T10:00:00Z",
    startedAt: status === "queued" ? null : "2026-08-26T10:00:01Z",
    completedAt: status === "completed" ? "2026-08-26T10:00:10Z" : null,
  };
}

function mockActivities(
  fixtures: Readonly<Record<string, ActivityFixture>>,
): void {
  context.mocks.api(logsByIdContract.getById, ({ params, respond }) => {
    const fixture = fixtures[params.id];
    if (!fixture) {
      throw new Error("Missing activity fixture for " + params.id);
    }
    return respond(
      200,
      logDetail(params.id, fixture.status, fixture.framework),
    );
  });
  context.mocks.api(
    runAgentEventsContract.getAgentEvents,
    ({ params, respond }) => {
      const fixture = fixtures[params.id];
      if (!fixture) {
        throw new Error("Missing activity fixture for " + params.id);
      }
      return respond(200, {
        events: [],
        hasMore: false,
        status: fixture.status,
        lastEventSequence: null,
      } satisfies AgentEventsResponse);
    },
  );
  context.mocks.api(runRunnerContract.getRunner, ({ params, respond }) => {
    const fixture = fixtures[params.id];
    if (!fixture) {
      throw new Error("Missing activity fixture for " + params.id);
    }
    return respond(200, fixture.runner);
  });
}

function setupRunnerPage(runId: string): Promise<void> {
  return setupPage({
    context,
    path: "/activities/" + runId + "?tab=runner",
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });
}

function navigateToRunner(runId: string): void {
  context.store.set(detachedNavigateTo$, "/activities/:activityRunId", {
    pathParams: { activityRunId: runId },
    searchParams: new URLSearchParams({ tab: "runner" }),
  });
}

function expectRunnerAttribute(label: string, value: string): void {
  const term = screen.getByText(label);
  const field = term.closest("div");
  if (!field) {
    throw new Error("Runner attribution field not found: " + label);
  }
  expect(within(field).getByText(value)).toBeInTheDocument();
}

function getStartupCard(): HTMLElement {
  const heading = screen.getByRole("heading", { name: "Startup" });
  const card = heading.closest("article");
  if (!card) {
    throw new Error("Startup card not found");
  }
  return card;
}

test("Runner diagnostics identify the exact environment used for an activity", async () => {
  const firstRunId = "a0000000-0000-4000-a000-000000000301";
  const secondRunId = "a0000000-0000-4000-a000-000000000302";
  const piRunId = "a0000000-0000-4000-a000-000000000303";
  mockActivities({
    [firstRunId]: {
      status: "completed",
      runner: {
        sandboxStartupPath: "sandbox",
        runnerHostname: "prod-1.aws.vm3.ai",
        runnerVersion: "0.168.14",
        runnerId: "b0000000-0000-4000-a000-000000000001",
        runnerHeartbeatGeneration: 7,
      },
    },
    [secondRunId]: {
      status: "completed",
      framework: "codex",
      runner: {
        sandboxStartupPath: "sandbox",
        runnerHostname: "prod-2.aws.vm3.ai",
        runnerVersion: "0.168.14",
        runnerId: "b0000000-0000-4000-a000-000000000002",
        runnerHeartbeatGeneration: 8,
      },
    },
    [piRunId]: {
      status: "completed",
      framework: "pi",
      runner: {
        sandboxStartupPath: "sandbox",
        runnerHostname: "prod-3.aws.vm3.ai",
      },
    },
  });

  await setupRunnerPage(firstRunId);

  await expect(
    screen.findByRole("heading", { name: "Environment" }),
  ).resolves.toBeInTheDocument();
  await expect(
    screen.findByText("prod-1.aws.vm3.ai"),
  ).resolves.toBeInTheDocument();
  expectRunnerAttribute("Framework", "Claude Code");
  expectRunnerAttribute("Version", "0.168.14");
  expectRunnerAttribute("Runner ID", "b0000000-0000-4000-a000-000000000001");
  expectRunnerAttribute("Generation", "7");
  expect(screen.getByText("Sandbox reuse")).toBeInTheDocument();

  navigateToRunner(secondRunId);

  await expect(
    screen.findByText("prod-2.aws.vm3.ai"),
  ).resolves.toBeInTheDocument();
  expectRunnerAttribute("Framework", "Codex");
  expectRunnerAttribute("Version", "0.168.14");
  expectRunnerAttribute("Runner ID", "b0000000-0000-4000-a000-000000000002");
  expectRunnerAttribute("Generation", "8");
  expect(screen.queryByText("prod-1.aws.vm3.ai")).not.toBeInTheDocument();

  navigateToRunner(piRunId);

  await expect(
    screen.findByText("prod-3.aws.vm3.ai"),
  ).resolves.toBeInTheDocument();
  expectRunnerAttribute("Framework", "pi");
  expect(screen.queryByText("prod-2.aws.vm3.ai")).not.toBeInTheDocument();
});

test("Runner diagnostics display each persisted startup path", async () => {
  const cases = [
    {
      runId: "a0000000-0000-4000-a000-000000000306",
      path: "sandbox",
      label: "Sandbox reuse",
      description: "The sandbox and its workspace were reused.",
    },
    {
      runId: "a0000000-0000-4000-a000-000000000307",
      path: "home",
      label: "Home reuse",
      description: "A fresh sandbox restored a cached home directory.",
    },
    {
      runId: "a0000000-0000-4000-a000-000000000308",
      path: "cold",
      label: "Cold start",
      description: "A fresh sandbox and workspace were prepared.",
    },
    {
      runId: "a0000000-0000-4000-a000-000000000309",
      path: "blank",
      label: "Blank start",
      description: "A prepared sandbox started with a fresh home directory.",
    },
  ] as const satisfies readonly {
    runId: string;
    path: SandboxStartupPath;
    label: string;
    description: string;
  }[];
  mockActivities(
    Object.fromEntries(
      cases.map((entry) => {
        return [
          entry.runId,
          {
            status: "completed",
            runner: {
              sandboxStartupPath: entry.path,
            },
          } satisfies ActivityFixture,
        ];
      }),
    ),
  );

  await setupRunnerPage(cases[0].runId);

  for (const [index, entry] of cases.entries()) {
    if (index > 0) {
      navigateToRunner(entry.runId);
    }
    await expect(screen.findByText(entry.label)).resolves.toBeInTheDocument();
    const startupCard = getStartupCard();
    expect(within(startupCard).getByText(entry.label)).toBeInTheDocument();
    expect(
      within(startupCard).getByText(entry.description),
    ).toBeInTheDocument();
  }
});

test("Runner metadata remains visible when the startup path is unreported", async () => {
  const runId = "a0000000-0000-4000-a000-000000000312";
  mockActivities({
    [runId]: {
      status: "completed",
      runner: {
        sandboxStartupPath: null,
        runnerHostname: "available-runner",
      },
    },
  });
  await setupRunnerPage(runId);
  await expect(
    screen.findByText("available-runner"),
  ).resolves.toBeInTheDocument();
  expect(within(getStartupCard()).getByText("Unknown")).toBeInTheDocument();
});

test("The persisted startup path is visible before completion metadata is saved", async () => {
  const runId = "a0000000-0000-4000-a000-000000000315";
  mockActivities({
    [runId]: {
      status: "running",
      runner: {
        sandboxStartupPath: "home",
        runnerHostname: "running-runner",
      },
    },
  });
  await setupRunnerPage(runId);
  await expect(
    screen.findByText("running-runner"),
  ).resolves.toBeInTheDocument();
  await expect(
    within(getStartupCard()).findByText("Home reuse"),
  ).resolves.toBeInTheDocument();
});

test("Runner diagnostics do not carry over while the next activity's request is pending", async () => {
  const firstRunId = "a0000000-0000-4000-a000-000000000313";
  const nextRunId = "a0000000-0000-4000-a000-000000000314";
  const runnerRequested = context.mocks.deferred<void>();
  const releaseRunner = context.mocks.deferred<void>();
  const firstRunner = {
    sandboxStartupPath: "blank",
    runnerHostname: "blank-runner",
  } as const satisfies RunRunnerResponse;
  const nextRunner = {
    sandboxStartupPath: "cold",
    runnerHostname: "cold-runner",
  } as const satisfies RunRunnerResponse;
  mockActivities({
    [firstRunId]: { status: "completed", runner: firstRunner },
    [nextRunId]: { status: "completed", runner: nextRunner },
  });
  context.mocks.api(
    runRunnerContract.getRunner,
    async ({ params, respond }) => {
      if (params.id === firstRunId) {
        return respond(200, firstRunner);
      }
      runnerRequested.resolve();
      await releaseRunner.promise;
      return respond(200, nextRunner);
    },
  );
  await setupRunnerPage(firstRunId);
  await expect(
    within(getStartupCard()).findByText("Blank start"),
  ).resolves.toBeInTheDocument();

  navigateToRunner(nextRunId);

  await runnerRequested.promise;
  await waitFor(() => {
    expect(screen.queryByText("Blank start")).not.toBeInTheDocument();
    expect(screen.queryByText("blank-runner")).not.toBeInTheDocument();
  });
  releaseRunner.resolve();
  await expect(screen.findByText("cold-runner")).resolves.toBeInTheDocument();
  await expect(
    within(getStartupCard()).findByText("Cold start"),
  ).resolves.toBeInTheDocument();
});
