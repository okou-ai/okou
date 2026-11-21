import { logsByIdContract } from "@okouai/api-contracts/contracts/logs";
import { runRunnerContract } from "@okouai/api-contracts/contracts/run-routes";
import type { SandboxStartupPath } from "@okouai/api-contracts/contracts/runner-primitives";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

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
