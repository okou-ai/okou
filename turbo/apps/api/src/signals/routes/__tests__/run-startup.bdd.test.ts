import { randomUUID } from "node:crypto";
import { runStartupContract } from "@okouai/api-contracts/contracts/run-routes";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";
import { z } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { withMockNowForTest } from "../../../lib/time";
import { runStartupRoutes } from "../run-startup";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { publicChatActor } from "./helpers/public-chat-actor";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const runs = createRunsApi(context);
const callbacks = createWebhookCallbackApi(context);
const reads = createRunReadsApi(context);
const queryRequestSchema = z.object({
  apl: z.string(),
  startTime: z.iso.datetime(),
  endTime: z.iso.datetime(),
});

function requestStartup(actor: ApiTestUser | null, runId: string) {
  if (actor === null) {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
  } else {
    createRouteMocks(context).clerk.session(
      actor.userId,
      actor.orgId,
      actor.orgRole,
    );
  }
  return setupApp({ context, routes: runStartupRoutes })(
    runStartupContract,
  ).getStartup({
    headers: actor === null ? {} : { authorization: "Bearer clerk-session" },
    params: { id: runId },
  });
}

function startupTable(paths: readonly string[], partial = false) {
  return HttpResponse.json({
    status: { isPartial: partial },
    tables: [
      {
        fields: [{ name: "runner_startup_path", type: "string" }],
        columns: [paths],
      },
    ],
  });
}

test("startup diagnostics read all four settled paths in the completed Run window", async () => {
  const owned = await publicChatActor(context);
  await owned.run(async () => {
    const run = await owned.sendChatRun(owned.actor, {
      agentId: owned.agentId,
      prompt: "Inspect startup diagnostics",
    });
    const { sandboxHeaders } = await owned.claimChatRun(
      owned.runnerGroup,
      run.runId,
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
    const detail = await reads.requestReadLogById(
      owned.actor,
      run.runId,
      [200],
    );
    const startedAt = z.iso.datetime().parse(detail.body.startedAt);
    const completedAt = z.iso.datetime().parse(detail.body.completedAt);
    expect(detail.body.status).toBe("completed");
    context.mocks.axiom.useRealQuery.mockReturnValue(true);
    for (const path of ["sandbox", "home", "blank", "cold"] as const) {
      server.use(
        http.post(
          "https://api.axiom.co/v1/datasets/_apl",
          async ({ request }) => {
            const url = new URL(request.url);
            expect(url.searchParams.get("format")).toBe("tabular");
            expect(url.searchParams.get("nocache")).toBe("true");
            const query = queryRequestSchema.parse(await request.json());
            expect(query.startTime).toBe(
              new Date(Date.parse(startedAt) - 60_000).toISOString(),
            );
            expect(query.endTime).toBe(
              new Date(Date.parse(completedAt) + 60_000).toISOString(),
            );
            expect(query.apl).toContain("['vm0-sandbox-op-log-dev']");
            expect(query.apl).toContain(`run_id == "${run.runId}"`);
            expect(query.apl).toContain(
              'source == "sandbox" and sandbox_type == "runner"',
            );
            expect(query.apl).toContain(
              'op_type == "runner_agent_start_to_ready" and success == true',
            );
            expect(query.apl).toContain(
              '| where runner_startup_path in ("sandbox", "home", "blank", "cold")',
            );
            expect(query.apl).toContain(
              `_time >= datetime("${query.startTime}") and _time < datetime("${query.endTime}")`,
            );
            expect(query.apl).toContain("| order by _time desc");
            expect(query.apl).toContain("| limit 1");
            return startupTable([path]);
          },
        ),
      );
      const observed = await accept(
        requestStartup(owned.actor, run.runId),
        [200],
      );
      expect(observed.body).toStrictEqual({ sandboxStartupPath: path });
    }
    const metadata = await runs.requestRunRunner(owned.actor, run.runId, [200]);
    expect(metadata.body).toMatchObject({
      sandboxReuseResult: "poolMiss",
      homeReuseResult: "cacheMiss",
    });
  });
});

test("a running Run can have no ingested startup observation yet", async () => {
  const owned = await publicChatActor(context);
  await owned.run(async () => {
    const run = await owned.sendChatRun(owned.actor, {
      agentId: owned.agentId,
      prompt: "Await startup telemetry",
    });
    await owned.claimChatRun(owned.runnerGroup, run.runId);
    const detail = await reads.requestReadLogById(
      owned.actor,
      run.runId,
      [200],
    );
    const startedAt = z.iso.datetime().parse(detail.body.startedAt);
    const requestTime = Date.parse(startedAt) + 10_000;
    context.mocks.axiom.useRealQuery.mockReturnValue(true);
    server.use(
      http.post(
        "https://api.axiom.co/v1/datasets/_apl",
        async ({ request }) => {
          const query = queryRequestSchema.parse(await request.json());
          expect(query.endTime).toBe(
            new Date(requestTime + 60_000).toISOString(),
          );
          return startupTable([]);
        },
      ),
    );
    const observed = await withMockNowForTest(requestTime, () => {
      return accept(requestStartup(owned.actor, run.runId), [200]);
    });
    expect(observed.body).toStrictEqual({ sandboxStartupPath: null });
  });
});

test("unstarted Runs and unauthorized callers never need telemetry access", async () => {
  const owned = await publicChatActor(context);
  await owned.run(async () => {
    const run = await owned.sendChatRun(owned.actor, {
      agentId: owned.agentId,
      prompt: "Pending startup",
    });
    context.mocks.axiom.useRealQuery.mockReturnValue(true);
    server.use(
      http.post("https://api.axiom.co/v1/datasets/_apl", () => {
        throw new Error("No authorized started Run should reach telemetry");
      }),
    );
    expect(
      (await accept(requestStartup(owned.actor, run.runId), [200])).body,
    ).toStrictEqual({ sandboxStartupPath: null });
    await owned.claimChatRun(owned.runnerGroup, run.runId);
    const stranger = createBddApi(context).user({
      orgId: owned.actor.orgId,
      orgRole: "org:member",
    });
    expect((await requestStartup(stranger, run.runId)).status).toBe(404);
    expect(
      (
        await requestStartup(
          { ...owned.actor, orgId: `org_${randomUUID()}` },
          run.runId,
        )
      ).status,
    ).toBe(404);
    expect((await requestStartup(owned.actor, randomUUID())).status).toBe(404);
    expect(
      (
        await requestStartup(
          { ...owned.actor, orgId: null, orgRole: undefined },
          run.runId,
        )
      ).status,
    ).toBe(401);
    expect((await requestStartup(null, run.runId)).status).toBe(401);
    expect((await requestStartup(owned.actor, "invalid-run-id")).status).toBe(
      400,
    );
  });
});

test.each([
  { name: "partial result", paths: ["blank"], partial: true },
  { name: "invalid path", paths: ["invalid"], partial: false },
])(
  "incomplete startup evidence fails explicitly: $name",
  async ({ paths, partial }) => {
    const owned = await publicChatActor(context);
    await owned.run(async () => {
      const run = await owned.sendChatRun(owned.actor, {
        agentId: owned.agentId,
        prompt: "Read unavailable evidence",
      });
      await owned.claimChatRun(owned.runnerGroup, run.runId);
      context.mocks.axiom.useRealQuery.mockReturnValue(true);
      server.use(
        http.post("https://api.axiom.co/v1/datasets/_apl", () => {
          return startupTable(paths, partial);
        }),
      );
      await expect(requestStartup(owned.actor, run.runId)).rejects.toThrow(
        "Unknown response status 500",
      );
      const metadata = await runs.requestRunRunner(
        owned.actor,
        run.runId,
        [200],
      );
      expect(metadata.status).toBe(200);
    });
  },
);
