import { cronAuditRunSettlementContract } from "@okouai/api-contracts/contracts/run-settlement";
import { beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { cronAuditRunSettlementRoutes } from "../cron-audit-run-settlement";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { publicChatActor } from "./helpers/public-chat-actor";
import { createPublicTeamsDispatchFixture } from "./helpers/public-teams-dispatch-fixture";
import {
  mockGoogleText,
  VERTEX_TEXT_URL,
  vertexTextResponse,
} from "./helpers/google-text";

const context = testContext();
const headers = Object.freeze({
  authorization: "Bearer settlement-test-secret",
});

beforeEach(() => {
  mockEnv("CRON_SECRET", "settlement-test-secret");
});

describe("Run settlement", () => {
  it("restricts the aggregate operator report and bounds each page", async () => {
    const client = setupApp({
      context,
      routes: cronAuditRunSettlementRoutes,
    })(cronAuditRunSettlementContract);
    const unauthorized = await accept(
      client.audit({ headers: {}, query: { limit: 100 } }),
      [401],
    );
    expect(unauthorized.status).toBe(401);
    const outOfBounds = await accept(
      client.audit({ headers, query: { limit: 101 } }),
      [400],
    );
    expect(outOfBounds.status).toBe(400);
  });

  it("reports execution blockers and completed handoffs without changing either Run", async () => {
    const client = (
      await setupApp({
        context,
        routes: cronAuditRunSettlementRoutes,
        isolatePg: true,
      })
    )(cronAuditRunSettlementContract);
    const owner = await publicChatActor(context);
    const runs = createRunsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    mockGoogleText();
    server.use(
      http.post(VERTEX_TEXT_URL, () => {
        return vertexTextResponse("A completed task");
      }),
    );
    await owner.run(async () => {
      await runs.ensurePersonalSubscriptionModel(owner.actor, {
        model: "claude-fable-5-1",
      });
      const completed = await owner.sendChatRun(owner.actor, {
        agentId: owner.agentId,
        prompt: "complete this task",
        model: "claude-fable-5-1",
      });
      const waiting = await owner.sendChatRun(owner.actor, {
        agentId: owner.agentId,
        prompt: "leave this task waiting",
        model: "claude-fable-5-1",
      });
      const { sandboxHeaders } = await owner.claimChatRun(
        owner.runnerGroup,
        completed.runId,
      );
      await webhooks.requestAgentComplete(
        {
          runId: completed.runId,
          exitCode: 0,
          completion: {
            cliAgentType: "claude-code",
            cliAgentSessionId: `settlement-${completed.runId}`,
            cliAgentSessionHistoryDisposition: "native_only",
          },
        },
        sandboxHeaders,
        [200],
      );
      await flushWaitUntilForTest();
      const report = await accept(
        client.audit({ headers, query: { limit: 100 } }),
        [200],
      );
      expect(report.body).toMatchObject({
        scannedRuns: 2,
        observedCompleteRuns: 1,
        blockedRuns: 1,
        callbacks: {
          delivered: 1,
          policyFinished: 0,
          pending: 1,
          recoverableFailure: 0,
          unknown: 0,
        },
      });
      expect(report.body.blockers).toStrictEqual(
        expect.arrayContaining([
          { reason: "execution_not_terminal", runs: 1 },
          { reason: "active_run_present", runs: 1 },
          { reason: "runner_job_present", runs: 1 },
          { reason: "callback_pending", runs: 1 },
        ]),
      );
      const repeated = await accept(
        client.audit({
          headers,
          query: { limit: 100, createdBefore: report.body.createdBefore },
        }),
        [200],
      );
      expect(repeated.body).toStrictEqual(report.body);
      expect((await runs.readRun(owner.actor, completed.runId)).status).toBe(
        "completed",
      );
      expect((await runs.readRun(owner.actor, waiting.runId)).status).toBe(
        "pending",
      );
    });
  });

  it("does not retry a failed Teams delivery when completion is replayed", async () => {
    const fixtures = createPublicTeamsDispatchFixture(context);
    const runs = createRunsApi(context);
    const reads = createRunReadsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    await fixtures.run(async () => {
      const teams = await fixtures.create({
        withDefaultAgent: true,
        paidNative: true,
      });
      await fixtures.dispatch(teams, "complete while Teams is unavailable");
      const listed = await reads.requestListLogs(
        teams.actor,
        { limit: 10 },
        [200],
      );
      const run = listed.body.data.find((row) => {
        return row.prompt === "complete while Teams is unavailable";
      });
      if (!run) {
        throw new Error("Expected the dispatched Teams Run");
      }
      await runs.heartbeatRunner("vm0/test");
      const claim = await runs.claimRunnerJob(run.id);
      let deliveryAttempts = 0;
      server.use(
        http.post(
          `${teams.installation.serviceUrl}v3/conversations/:conversationId/activities/:activityId`,
          () => {
            deliveryAttempts++;
            return new HttpResponse("Teams unavailable", { status: 500 });
          },
        ),
      );
      const complete = {
        runId: run.id,
        exitCode: 0,
        completion: {
          cliAgentType: "claude-code",
          cliAgentSessionId: `settlement-${run.id}`,
          cliAgentSessionHistoryDisposition: "native_only" as const,
        },
      };
      const sandboxHeaders = { authorization: `Bearer ${claim.sandboxToken}` };
      await webhooks.requestAgentComplete(complete, sandboxHeaders, [200]);
      await flushWaitUntilForTest();
      expect((await runs.readRun(teams.actor, run.id)).status).toBe(
        "completed",
      );
      expect(deliveryAttempts).toBe(1);
      await webhooks.requestAgentComplete(complete, sandboxHeaders, [200]);
      await flushWaitUntilForTest();
      expect(deliveryAttempts).toBe(1);
    });
  });
});
