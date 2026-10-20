import { randomUUID } from "node:crypto";
import { runnersRunStartupContract } from "@okouai/api-contracts/contracts/runner-startup";
import type { SandboxStartupPath } from "@okouai/api-contracts/contracts/runner-primitives";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { nowDate } from "../../../lib/time";
import { runnersStartupRoutes } from "../runners-startup";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
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

function writeStartupPath(
  runId: string,
  sandboxStartupPath: SandboxStartupPath,
  headers: { readonly authorization?: string },
  statuses: readonly (204 | 400 | 401 | 404 | 409 | 500)[] = [204],
) {
  return accept(
    setupApp({ context, routes: runnersStartupRoutes })(
      runnersRunStartupContract,
    ).setStartup({ params: { runId }, headers, body: { sandboxStartupPath } }),
    statuses,
  );
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

function completionBody(
  run: { readonly runId: string; readonly threadId: string },
  cliAgentType: string | undefined,
) {
  if (
    cliAgentType !== "claude-code" &&
    cliAgentType !== "codex" &&
    cliAgentType !== "pi"
  ) {
    throw new Error("Expected the claimed Framework identity");
  }
  return {
    runId: run.runId,
    exitCode: 0,
    completion: {
      cliAgentType,
      cliAgentSessionId: cliAgentType === "pi" ? run.threadId : randomUUID(),
      cliAgentSessionHistoryDisposition: "native_only" as const,
    },
  };
}

test.each(["sandbox", "home", "blank", "cold"] as const)(
  "dedicated startup API persists %s through a pre-cleanup completion",
  async (path) => {
    const owned = await publicChatActor(context);
    await owned.run(async () => {
      const run = await owned.sendChatRun(owned.actor, {
        agentId: owned.agentId,
        prompt: "Persist actual startup resource",
      });
      await expect(readStartupPath(owned.actor, run.runId)).resolves.toBeNull();
      const { sandboxHeaders, claim } = await owned.claimChatRun(
        owned.runnerGroup,
        run.runId,
      );
      await writeStartupPath(run.runId, path, sandboxHeaders);
      await expect(readStartupPath(owned.actor, run.runId)).resolves.toBe(path);

      const sandboxReuseResult = path === "sandbox" ? "reused" : "poolMiss";
      const homeReuseResult =
        path === "sandbox"
          ? "sandboxReused"
          : path === "home"
            ? "reused"
            : "cacheMiss";
      const request = setupRawAppRequest({
        context,
        routes: webhooksAgentCompleteRoutes,
      });
      const response = await request("/api/webhooks/agent/complete", {
        method: "POST",
        headers: { ...sandboxHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          ...completionBody(run, claim.cliAgentType),
          sandboxReuseResult,
          homeReuseResult,
        }),
      });
      expect(response.status).toBe(200);
      expect(response.body).toStrictEqual({
        success: true,
        status: "completed",
      });
      expect(
        (await runs.requestRunRunner(owned.actor, run.runId, [200])).body,
      ).toMatchObject({
        sandboxStartupPath: path,
      });
    });
  },
);

test("telemetry and completion leave startup unknown until an authenticated report", async () => {
  const owned = await publicChatActor(context);
  await owned.run(async () => {
    const run = await owned.sendChatRun(owned.actor, {
      agentId: owned.agentId,
      prompt: "Keep unreported startup unknown",
    });
    const { sandboxHeaders, claim } = await owned.claimChatRun(
      owned.runnerGroup,
      run.runId,
    );
    await callbacks.requestAgentTelemetry(
      {
        runId: run.runId,
        sandboxOperations: [
          readyOperation("blank"),
          { ...readyOperation("cold"), success: false },
          { ...readyOperation("home"), action_type: "api_to_agent_ready" },
        ],
      },
      sandboxHeaders,
      [200],
    );
    await expect(readStartupPath(owned.actor, run.runId)).resolves.toBeNull();
    await callbacks.requestAgentComplete(
      {
        ...completionBody(run, claim.cliAgentType),
      },
      sandboxHeaders,
      [200],
    );
    expect(
      (await runs.requestRunRunner(owned.actor, run.runId, [200])).body,
    ).toMatchObject({
      sandboxStartupPath: null,
    });
    // A delayed authenticated report can still provide the actual fact after
    // completion; only the dedicated startup report supplies this fact.
    await writeStartupPath(run.runId, "cold", sandboxHeaders);
    await expect(readStartupPath(owned.actor, run.runId)).resolves.toBe("cold");
  });
});

test("malformed startup reports leave the path unset", async () => {
  const owned = await publicChatActor(context);
  await owned.run(async () => {
    const run = await owned.sendChatRun(owned.actor, {
      agentId: owned.agentId,
      prompt: "Validate dedicated startup reports",
    });
    const { sandboxHeaders } = await owned.claimChatRun(
      owned.runnerGroup,
      run.runId,
    );
    const request = setupRawAppRequest({
      context,
      routes: runnersStartupRoutes,
    });
    for (const body of [
      {},
      { sandboxStartupPath: "workspace" },
      { sandboxStartupPath: "blank", extra: true },
    ]) {
      const response = await request(`/api/runners/runs/${run.runId}/startup`, {
        method: "PUT",
        headers: { ...sandboxHeaders, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    await expect(readStartupPath(owned.actor, run.runId)).resolves.toBeNull();
    await writeStartupPath(run.runId, "blank", sandboxHeaders);
    await expect(readStartupPath(owned.actor, run.runId)).resolves.toBe(
      "blank",
    );
  });
});

test("same-value retries succeed and conflicting or telemetry reports cannot overwrite startup", async () => {
  const owned = await publicChatActor(context);
  await owned.run(async () => {
    const run = await owned.sendChatRun(owned.actor, {
      agentId: owned.agentId,
      prompt: "Replay startup receipt",
    });
    const { sandboxHeaders, claim } = await owned.claimChatRun(
      owned.runnerGroup,
      run.runId,
    );
    await writeStartupPath(run.runId, "blank", sandboxHeaders);
    await writeStartupPath(run.runId, "blank", sandboxHeaders);
    await writeStartupPath(run.runId, "cold", sandboxHeaders, [409]);
    await callbacks.requestAgentComplete(
      completionBody(run, claim.cliAgentType),
      sandboxHeaders,
      [200],
    );
    await writeStartupPath(run.runId, "blank", sandboxHeaders);
    await writeStartupPath(run.runId, "home", sandboxHeaders, [409]);
    await callbacks.requestAgentTelemetry(
      { runId: run.runId, sandboxOperations: [readyOperation("cold")] },
      sandboxHeaders,
      [200],
    );
    await expect(readStartupPath(owned.actor, run.runId)).resolves.toBe(
      "blank",
    );
  });
});

test("concurrent conflicting startup reports accept exactly one immutable fact", async () => {
  const owned = await publicChatActor(context);
  await owned.run(async () => {
    const run = await owned.sendChatRun(owned.actor, {
      agentId: owned.agentId,
      prompt: "Arbitrate startup receipts",
    });
    const { sandboxHeaders } = await owned.claimChatRun(
      owned.runnerGroup,
      run.runId,
    );
    const paths = ["blank", "cold"] as const;
    const responses = await Promise.all(
      paths.map((path) => {
        return writeStartupPath(run.runId, path, sandboxHeaders, [204, 409]);
      }),
    );
    expect(
      responses
        .map((response) => {
          return response.status;
        })
        .sort(),
    ).toStrictEqual([204, 409]);
    const acceptedIndex = responses.findIndex((response) => {
      return response.status === 204;
    });
    const accepted = paths[acceptedIndex];
    if (!accepted) {
      throw new Error("Expected one accepted startup report");
    }
    await expect(readStartupPath(owned.actor, run.runId)).resolves.toBe(
      accepted,
    );
    await writeStartupPath(run.runId, accepted, sandboxHeaders);
  });
});

test("startup writes and reads preserve Run token, user and organization boundaries", async () => {
  const owned = await publicChatActor(context);
  await owned.run(async () => {
    const run = await owned.sendChatRun(owned.actor, {
      agentId: owned.agentId,
      prompt: "Authorize startup setting",
    });
    const { sandboxHeaders } = await owned.claimChatRun(
      owned.runnerGroup,
      run.runId,
    );
    await writeStartupPath(randomUUID(), "blank", sandboxHeaders, [401]);
    await writeStartupPath(run.runId, "blank", {}, [401]);
    await writeStartupPath(
      run.runId,
      "blank",
      { authorization: "Bearer clerk-session" },
      [401],
    );
    await expect(readStartupPath(owned.actor, run.runId)).resolves.toBeNull();
    await writeStartupPath(run.runId, "blank", sandboxHeaders);
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
    await expect(readStartupPath(owned.actor, run.runId)).resolves.toBe(
      "blank",
    );
  });
});
