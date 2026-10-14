import { randomUUID } from "node:crypto";
import type { SandboxStartupPath } from "@okouai/api-contracts/contracts/runner-primitives";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockOptionalEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { publicChatActor } from "./helpers/public-chat-actor";

const context = testContext();
const runs = createRunsApi(context);
const callbacks = createWebhookCallbackApi(context);

async function readStartupPath(actor: ApiTestUser, runId: string) {
  const response = await runs.requestRunRunner(actor, runId, [200]);
  if (response.status !== 200) {
    throw new Error("Expected a successful Runner read");
  }
  return response.body.sandboxStartupPath;
}

function readyOperation(path: SandboxStartupPath) {
  return {
    ts: nowDate().toISOString(),
    action_type: "runner_agent_start_to_ready",
    duration_ms: 100,
    success: true,
    runner_startup_path: path,
  };
}

test.each(["sandbox", "home", "blank", "cold"] as const)(
  "runner read persists settled %s startup while running and after completion",
  async (path) => {
    const owned = await publicChatActor(context);
    await owned.run(async () => {
      const run = await owned.sendChatRun(owned.actor, {
        agentId: owned.agentId,
        prompt: "Persist actual startup resource",
      });
      expect(await readStartupPath(owned.actor, run.runId)).toBeNull();
      const { sandboxHeaders } = await owned.claimChatRun(
        owned.runnerGroup,
        run.runId,
      );
      await callbacks.requestAgentTelemetry(
        { runId: run.runId, sandboxOperations: [readyOperation(path)] },
        sandboxHeaders,
        [200],
      );
      expect(await readStartupPath(owned.actor, run.runId)).toBe(path);

      const sandboxReuseResult = path === "sandbox" ? "reused" : "poolMiss";
      const homeReuseResult =
        path === "sandbox"
          ? "sandboxReused"
          : path === "home"
            ? "reused"
            : "cacheMiss";
      await callbacks.requestAgentComplete(
        {
          runId: run.runId,
          exitCode: 0,
          sandboxReuseResult,
          homeReuseResult,
          completion: {
            cliAgentType: "claude-code",
            cliAgentSessionId: randomUUID(),
            cliAgentSessionHistoryDisposition: "unavailable",
          },
        },
        sandboxHeaders,
        [200],
      );
      expect(
        (await runs.requestRunRunner(owned.actor, run.runId, [200])).body,
      ).toMatchObject({
        sandboxStartupPath: path,
        sandboxReuseResult,
        homeReuseResult,
      });
    });
  },
);

test("missing, failed and boundary observations cannot manufacture a startup fact", async () => {
  const owned = await publicChatActor(context);
  await owned.run(async () => {
    const run = await owned.sendChatRun(owned.actor, {
      agentId: owned.agentId,
      prompt: "Keep unavailable startup truthfully unknown",
    });
    const { sandboxHeaders } = await owned.claimChatRun(
      owned.runnerGroup,
      run.runId,
    );
    const oldReady = {
      ts: nowDate().toISOString(),
      action_type: "runner_agent_start_to_ready",
      duration_ms: 100,
      success: true,
    };
    await callbacks.requestAgentTelemetry(
      {
        runId: run.runId,
        sandboxOperations: [
          { ...readyOperation("cold"), action_type: "api_to_agent_ready" },
          {
            ...readyOperation("blank"),
            action_type: "runner_blank_pool_borrow",
          },
          { ...readyOperation("cold"), success: false },
          { ...readyOperation("home"), runner_startup_path: "workspace" },
          oldReady,
        ],
      },
      sandboxHeaders,
      [200],
    );
    await callbacks.requestAgentTelemetryUnchecked(
      {
        runId: run.runId,
        sandboxOperations: [
          { ...readyOperation("blank"), runner_startup_path: "unsupported" },
        ],
      },
      sandboxHeaders,
      [400],
    );
    await callbacks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 0,
        sandboxReuseResult: "poolMiss",
        homeReuseResult: "cacheMiss",
        completion: {
          cliAgentType: "claude-code",
          cliAgentSessionId: randomUUID(),
          cliAgentSessionHistoryDisposition: "unavailable",
        },
      },
      sandboxHeaders,
      [200],
    );
    expect(
      (await runs.requestRunRunner(owned.actor, run.runId, [200])).body,
    ).toMatchObject({
      sandboxStartupPath: null,
      sandboxReuseResult: "poolMiss",
      homeReuseResult: "cacheMiss",
    });
  });
});

test("duplicate and late unrelated telemetry preserve the accepted startup fact", async () => {
  const owned = await publicChatActor(context);
  await owned.run(async () => {
    const run = await owned.sendChatRun(owned.actor, {
      agentId: owned.agentId,
      prompt: "Replay ready receipt",
    });
    const { sandboxHeaders } = await owned.claimChatRun(
      owned.runnerGroup,
      run.runId,
    );
    const operation = readyOperation("blank");
    for (const sandboxOperations of [[operation], [operation], []]) {
      await callbacks.requestAgentTelemetry(
        { runId: run.runId, sandboxOperations },
        sandboxHeaders,
        [200],
      );
    }
    await callbacks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 0,
        sandboxReuseResult: "poolMiss",
        homeReuseResult: "cacheMiss",
        completion: {
          cliAgentType: "claude-code",
          cliAgentSessionId: randomUUID(),
          cliAgentSessionHistoryDisposition: "unavailable",
        },
      },
      sandboxHeaders,
      [200],
    );
    await callbacks.requestAgentTelemetry(
      {
        runId: run.runId,
        sandboxOperations: [
          { ...readyOperation("cold"), action_type: "api_to_agent_ready" },
        ],
      },
      sandboxHeaders,
      [200],
    );
    expect(await readStartupPath(owned.actor, run.runId)).toBe("blank");
  });
});

test("startup persistence and reads retain token, user and organization boundaries", async () => {
  const owned = await publicChatActor(context);
  await owned.run(async () => {
    const run = await owned.sendChatRun(owned.actor, {
      agentId: owned.agentId,
      prompt: "Authorize startup receipt",
    });
    const { sandboxHeaders } = await owned.claimChatRun(
      owned.runnerGroup,
      run.runId,
    );
    await callbacks.requestAgentTelemetry(
      { runId: randomUUID(), sandboxOperations: [readyOperation("blank")] },
      sandboxHeaders,
      [401],
    );
    await callbacks.requestAgentTelemetry(
      { runId: run.runId, sandboxOperations: [readyOperation("blank")] },
      {},
      [401],
    );
    expect(await readStartupPath(owned.actor, run.runId)).toBeNull();
    await callbacks.requestAgentTelemetry(
      { runId: run.runId, sandboxOperations: [readyOperation("blank")] },
      sandboxHeaders,
      [200],
    );
    const stranger = createBddApi(context).user({
      orgId: owned.actor.orgId,
      orgRole: "org:member",
    });
    await runs.requestRunRunner(stranger, run.runId, [404]);
    await runs.requestRunRunner(
      { ...owned.actor, orgId: `org_${randomUUID()}` },
      run.runId,
      [404],
    );
    await runs.requestRunRunner(null, run.runId, [401]);
    expect(await readStartupPath(owned.actor, run.runId)).toBe("blank");
  });
});

test("provider ingestion failure does not prevent or erase the persisted startup fact", async () => {
  const owned = await publicChatActor(context);
  await owned.run(async () => {
    const run = await owned.sendChatRun(owned.actor, {
      agentId: owned.agentId,
      prompt: "Persist startup before optional transport",
    });
    const { sandboxHeaders } = await owned.claimChatRun(
      owned.runnerGroup,
      run.runId,
    );
    mockOptionalEnv("AXIOM_TOKEN_TELEMETRY", "startup-test-token");
    server.use(
      http.post("https://api.axiom.co/v1/datasets/:dataset/ingest", () => {
        return HttpResponse.json(
          { message: "Temporarily unavailable" },
          { status: 503 },
        );
      }),
    );
    await callbacks.requestAgentTelemetry(
      {
        runId: run.runId,
        systemLog: "Startup transport test",
        sandboxOperations: [readyOperation("blank")],
      },
      sandboxHeaders,
      [500],
    );
    expect(await readStartupPath(owned.actor, run.runId)).toBe("blank");
    await callbacks.requestAgentTelemetry(
      { runId: run.runId, sandboxOperations: [readyOperation("blank")] },
      sandboxHeaders,
      [200],
    );
    expect(await readStartupPath(owned.actor, run.runId)).toBe("blank");
  });
});
