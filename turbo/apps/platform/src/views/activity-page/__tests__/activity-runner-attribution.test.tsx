import { screen, within } from "@testing-library/react";
import { logsByIdContract } from "@okouai/api-contracts/contracts/logs";
import {
  runAgentEventsContract,
  runRunnerContract,
  runStartupContract,
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
  readonly startupPath?: SandboxStartupPath | null;
  readonly startupUnavailable?: boolean;
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
    artifact: { name: null, version: null },
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
  context.mocks.api(runStartupContract.getStartup, ({ params, respond }) => {
    const fixture = fixtures[params.id];
    if (!fixture) {
      throw new Error("Missing activity fixture for " + params.id);
    }
    if (fixture.startupUnavailable) {
      return respond(403, {
        error: {
          code: "FORBIDDEN",
          message: "Startup diagnostics unavailable",
        },
      });
    }
    return respond(200, { sandboxStartupPath: fixture.startupPath ?? null });
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
        sandboxReuseResult: "reused",
        homeReuseResult: "sandboxReused",
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
        sandboxReuseResult: "reused",
        homeReuseResult: "sandboxReused",
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
        sandboxReuseResult: "reused",
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
  expect(screen.getAllByText("Reused")).toHaveLength(2);

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

test("Runner diagnostics explain how the activity environment started", async () => {
  const cases = [
    {
      runId: "a0000000-0000-4000-a000-000000000306",
      sandboxReuseResult: "reused",
      homeReuseResult: "sandboxReused",
      startupPath: "sandbox",
      label: "Sandbox reuse",
      description: "The sandbox and its workspace were reused.",
    },
    {
      runId: "a0000000-0000-4000-a000-000000000307",
      sandboxReuseResult: "poolMiss",
      homeReuseResult: "reused",
      startupPath: "home",
      label: "Home reuse",
      description: "A fresh sandbox restored a cached home directory.",
    },
    {
      runId: "a0000000-0000-4000-a000-000000000308",
      sandboxReuseResult: "poolMiss",
      homeReuseResult: "cacheMiss",
      startupPath: "cold",
      label: "Cold start",
      description: "A fresh sandbox and workspace were prepared.",
    },
    {
      runId: "a0000000-0000-4000-a000-000000000309",
      sandboxReuseResult: "poolMiss",
      homeReuseResult: "cacheMiss",
      startupPath: "blank",
      label: "Blank start",
      description: "A prepared sandbox started with a fresh home directory.",
    },
    {
      runId: "a0000000-0000-4000-a000-000000000310",
      sandboxReuseResult: "poolMiss",
      homeReuseResult: "sandboxPrepareFallback",
      startupPath: "cold",
      label: "Cold start",
      description: "A fresh sandbox and workspace were prepared.",
    },
  ] as const satisfies readonly {
    runId: string;
    sandboxReuseResult: RunRunnerResponse["sandboxReuseResult"];
    homeReuseResult: RunRunnerResponse["homeReuseResult"];
    startupPath: SandboxStartupPath;
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
            startupPath: entry.startupPath,
            runner: {
              sandboxReuseResult: entry.sandboxReuseResult,
              homeReuseResult: entry.homeReuseResult,
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

test.each([
  {
    runner: { sandboxReuseResult: "reused", homeReuseResult: "sandboxReused" },
    label: "Sandbox reuse",
  },
  {
    runner: { sandboxReuseResult: "poolMiss", homeReuseResult: "reused" },
    label: "Home reuse",
  },
  {
    runner: { sandboxReuseResult: "poolMiss", homeReuseResult: "cacheMiss" },
    label: "Unknown",
  },
  {
    runner: {
      sandboxReuseResult: "poolMiss",
      homeReuseResult: "sandboxPrepareFallback",
    },
    label: "Unknown",
  },
  {
    runner: { sandboxReuseResult: null, homeReuseResult: null },
    label: "Unknown",
  },
] as const)(
  "Missing startup evidence preserves only proven $label attribution",
  async ({ runner, label }) => {
    const runId = "a0000000-0000-4000-a000-000000000311";
    mockActivities({ [runId]: { status: "completed", runner } });
    await setupRunnerPage(runId);
    await expect(
      within(getStartupCard()).findByText(label),
    ).resolves.toBeInTheDocument();
  },
);

test("Runner metadata remains visible when startup diagnostics fail", async () => {
  const runId = "a0000000-0000-4000-a000-000000000312";
  mockActivities({
    [runId]: {
      status: "completed",
      startupUnavailable: true,
      runner: {
        sandboxReuseResult: "poolMiss",
        homeReuseResult: "cacheMiss",
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

test("Settled startup evidence is visible before completion metadata is saved", async () => {
  const runId = "a0000000-0000-4000-a000-000000000315";
  mockActivities({
    [runId]: {
      status: "running",
      startupPath: "home",
      runner: { sandboxReuseResult: null, runnerHostname: "running-runner" },
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

test("Startup evidence loads independently and does not carry over between activities", async () => {
  const firstRunId = "a0000000-0000-4000-a000-000000000313";
  const nextRunId = "a0000000-0000-4000-a000-000000000314";
  const startupRequested = context.mocks.deferred<void>();
  const releaseStartup = context.mocks.deferred<void>();
  mockActivities({
    [firstRunId]: {
      status: "completed",
      startupPath: "blank",
      runner: {
        sandboxReuseResult: "poolMiss",
        homeReuseResult: "cacheMiss",
        runnerHostname: "blank-runner",
      },
    },
    [nextRunId]: {
      status: "completed",
      runner: {
        sandboxReuseResult: "poolMiss",
        homeReuseResult: "cacheMiss",
        runnerHostname: "cold-runner",
      },
    },
  });
  context.mocks.api(
    runStartupContract.getStartup,
    async ({ params, respond }) => {
      if (params.id === firstRunId) {
        return respond(200, { sandboxStartupPath: "blank" });
      }
      startupRequested.resolve();
      await releaseStartup.promise;
      return respond(200, { sandboxStartupPath: "cold" });
    },
  );
  await setupRunnerPage(firstRunId);
  await expect(
    within(getStartupCard()).findByText("Blank start"),
  ).resolves.toBeInTheDocument();
  navigateToRunner(nextRunId);
  await startupRequested.promise;
  await expect(screen.findByText("cold-runner")).resolves.toBeInTheDocument();
  expect(within(getStartupCard()).getByText("Unknown")).toBeInTheDocument();
  expect(screen.queryByText("Blank start")).not.toBeInTheDocument();
  releaseStartup.resolve();
  await expect(
    within(getStartupCard()).findByText("Cold start"),
  ).resolves.toBeInTheDocument();
});
