import { randomUUID } from "node:crypto";

import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  runRunnerContract,
  runsCancelContract,
} from "@okouai/api-contracts/contracts/run-routes";
import { runnersHeartbeatContract } from "@okouai/api-contracts/contracts/runners";
import { runnersRunStartupContract } from "@okouai/api-contracts/contracts/runner-startup";
import type {
  HomeReuseResult,
  SandboxReuseResult,
  SandboxStartupPath,
} from "@okouai/api-contracts/contracts/runner-primitives";
import {
  webhookCompleteContract,
  webhookTelemetryContract,
} from "@okouai/api-contracts/contracts/webhooks";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { now, nowDate, withMockNowForTest } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { chatEventsRoutes } from "../chat-events";
import { runnersRoutes } from "../runners";
import { runnersStartupRoutes } from "../runners-startup";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksAgentHealthUsageTelemetryRoutes } from "../webhooks-agent-health-usage-telemetry";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { deliverOrganizationCreated } from "./helpers/api-bdd-webhooks";
import { captureConnectorExternalState } from "./helpers/public-connector-actor";
import { createRouteMocks } from "./helpers/route-test";

const STARTUP_OPTIONAL_ENVS = Object.freeze(["OPENROUTER_API_KEY"] as const);

const SESSION_HEADERS = Object.freeze({
  authorization: "Bearer clerk-session",
});

interface DispatchedStartupRun {
  readonly actor: ApiTestUser;
  readonly runId: string;
  readonly threadId: string;
  readonly sandboxToken: string;
  readonly cliAgentType: string;
  readonly markCompleted: () => void;
}

describe("run runner startup", () => {
  const context = testContext();
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const chatCallbacks = createChatCallbacksApi(context);
  const routeMocks = createRouteMocks(context);

  const startupApi = setupApp({
    context,
    routes: runnersStartupRoutes,
  })(runnersRunStartupContract);
  const runnersHeartbeatApi = setupApp({
    context,
    routes: runnersRoutes,
  })(runnersHeartbeatContract);
  const runRunnerApi = setupApp({
    context,
    routes: runsRoutes,
  })(runRunnerContract);
  const webhookCompleteApi = setupApp({
    context,
    routes: webhooksAgentCompleteRoutes,
  })(webhookCompleteContract);
  const rawCompleteRequest = setupRawAppRequest({
    context,
    routes: webhooksAgentCompleteRoutes,
  });
  const webhookTelemetryApi = setupApp({
    context,
    routes: webhooksAgentHealthUsageTelemetryRoutes,
  })(webhookTelemetryContract);
  const runsCancelApi = setupApp({
    context,
    routes: runsCancelRoutes,
  })(runsCancelContract);
  const chatEventsApi = setupApp({
    context,
    routes: chatEventsRoutes,
  })(chatEventsContract);

  function sessionHeadersFor(actor: ApiTestUser | null): {
    readonly authorization?: string;
  } {
    if (!actor) {
      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });
      return {};
    }
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    return SESSION_HEADERS;
  }

  async function reportStartup<TStatus extends 204 | 400 | 401 | 404 | 409>(
    runId: string,
    sandboxStartupPath: SandboxStartupPath,
    headers: { readonly authorization?: string },
    statuses: readonly TStatus[],
  ) {
    return await accept(
      startupApi.setStartup({
        headers,
        params: { runId },
        body: { sandboxStartupPath },
      }),
      statuses,
    );
  }

  async function readRunner<TStatus extends 200 | 400 | 401 | 403 | 404>(
    actor: ApiTestUser | null,
    runId: string,
    statuses: readonly TStatus[],
  ) {
    return await accept(
      runRunnerApi.getRunner({
        headers: sessionHeadersFor(actor),
        params: { id: runId },
      }),
      statuses,
    );
  }

  async function completeRunWithLegacyReuseFields(
    run: DispatchedStartupRun,
    legacyFields: {
      readonly sandboxReuseResult: SandboxReuseResult;
      readonly homeReuseResult: HomeReuseResult;
    },
  ) {
    const response = await rawCompleteRequest("/api/webhooks/run/complete", {
      method: "POST",
      headers: {
        authorization: `Bearer ${run.sandboxToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        runId: run.runId,
        exitCode: 0,
        sandboxReuseResult: legacyFields.sandboxReuseResult,
        homeReuseResult: legacyFields.homeReuseResult,
        completion: {
          cliAgentType: run.cliAgentType,
          cliAgentSessionId: run.threadId,
          cliAgentSessionHistoryDisposition: "native_only",
        },
      }),
    });
    if (response.status === 200) {
      run.markCompleted();
    }
    return response;
  }

  async function completeRun(run: DispatchedStartupRun) {
    const response = await accept(
      webhookCompleteApi.complete({
        headers: { authorization: `Bearer ${run.sandboxToken}` },
        body: {
          runId: run.runId,
          exitCode: 0,
          completion: {
            cliAgentType: run.cliAgentType,
            cliAgentSessionId: run.threadId,
            cliAgentSessionHistoryDisposition: "native_only",
          },
        },
      }),
      [200],
    );
    run.markCompleted();
    return response;
  }

  async function startDispatchedChatRun(): Promise<DispatchedStartupRun> {
    const actor = bdd.user();
    const clockTime = now();
    let activeRun:
      { readonly runId: string; readonly sandboxToken: string } | undefined;
    let completed = false;

    const restoreBefore = captureConnectorExternalState(
      context,
      STARTUP_OPTIONAL_ENVS,
    );
    let restoreAccepted = restoreBefore;

    onTestFinished(async () => {
      restoreAccepted();
      context.mocks.ably.publish.mockResolvedValue(undefined);
      const result = await settleIncludingAbort(() => {
        return withMockNowForTest(clockTime, async () => {
          await flushWaitUntilForTest();
          if (activeRun && !completed) {
            const target = activeRun;
            await accept(
              runsCancelApi.cancel({
                headers: sessionHeadersFor(actor),
                params: { id: target.runId },
              }),
              [200],
            );
            await accept(
              webhookCompleteApi.complete({
                headers: { authorization: `Bearer ${target.sandboxToken}` },
                body: {
                  runId: target.runId,
                  exitCode: 1,
                  error: "Run cancelled",
                },
              }),
              [200],
            );
            await flushWaitUntilForTest();
          }
        });
      });
      restoreBefore();
      if (!result.ok) {
        throw result.error;
      }
    });

    chatCallbacks.acceptChatObjectStorage();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    chatCallbacks.disableVapid();
    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-startup-openrouter-key");
    restoreAccepted = captureConnectorExternalState(
      context,
      STARTUP_OPTIONAL_ENVS,
    );

    const launched = await withMockNowForTest(clockTime, async () => {
      const [runnerGroup] = await Promise.all([
        runs.configureRunnerGroup(),
        deliverOrganizationCreated(context, actor),
      ]);
      const sent = await accept(
        chatEventsApi.send({
          headers: sessionHeadersFor(actor),
          body: {
            prompt: "Check runner startup persistence.",
            hasTextContent: true,
            clientEventId: randomUUID(),
            model: null,
            userMessage: {
              version: 1,
              parts: [
                { type: "text", text: "Check runner startup persistence." },
              ],
            },
          },
        }),
        [201],
      );
      const dispatched = await runs.nextReceivedExecution(runnerGroup);
      activeRun = {
        runId: dispatched.runId,
        sandboxToken: dispatched.sandboxToken,
      };
      return {
        threadId: sent.body.threadId,
        runId: dispatched.runId,
        sandboxToken: dispatched.sandboxToken,
        cliAgentType: dispatched.cliAgentType,
      };
    });

    return {
      actor,
      ...launched,
      markCompleted: () => {
        completed = true;
      },
    };
  }

  beforeAll(async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const warmupId = randomUUID();
    await Promise.all([
      accept(
        startupApi.setStartup({
          headers: {},
          params: { runId: warmupId },
          body: { sandboxStartupPath: "blank" },
        }),
        [401],
      ),
      accept(
        runRunnerApi.getRunner({
          headers: {},
          params: { id: warmupId },
        }),
        [401],
      ),
      accept(
        webhookCompleteApi.complete({
          headers: {},
          body: { runId: warmupId, exitCode: 0 },
        }),
        [401],
      ),
      accept(
        webhookTelemetryApi.send({
          headers: {},
          body: {
            sandboxOperations: [
              {
                ts: nowDate().toISOString(),
                action_type: "sandbox_ready",
                duration_ms: 1,
                success: true,
              },
            ],
          },
        }),
        [401],
      ),
      accept(
        runsCancelApi.cancel({
          headers: {},
          params: { id: warmupId },
        }),
        [401],
      ),
      accept(
        runnersHeartbeatApi.heartbeat({
          headers: {},
          body: {
            runnerId: warmupId,
            group: "vm0/test",
            snapshotGeneration: 1,
            snapshotSequence: 1,
            totalVcpu: 8,
            totalMemoryMb: 16_384,
            maxConcurrent: 2,
            allocatedVcpu: 0,
            allocatedMemoryMb: 0,
            runningCount: 0,
            admittableProfiles: ["vm0/default"],
            heldSandboxStates: [],
            heldHomeStates: [],
            activeReuseProducers: [],
            mode: "running",
          },
        }),
        [401],
      ),
      accept(
        rawCompleteRequest("/api/webhooks/run/complete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ runId: warmupId, exitCode: 0 }),
        }),
        [401],
      ),
      accept(
        chatEventsApi.send({
          headers: {},
          body: {
            prompt: "warmup",
            hasTextContent: true,
            clientEventId: randomUUID(),
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: "warmup" }],
            },
          },
        }),
        [401],
      ),
    ]);
  });

  it(
    "run-runner-startup.bdd-001 dedicated startup API persists sandbox through a pre-cleanup completion",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const run = await startDispatchedChatRun();
      const sandboxHeaders = { authorization: `Bearer ${run.sandboxToken}` };

      const beforeReport = await readRunner(run.actor, run.runId, [200]);
      expect(beforeReport.body.sandboxStartupPath).toBeNull();

      const reported = await reportStartup(
        run.runId,
        "sandbox",
        sandboxHeaders,
        [204],
      );
      expect(reported.status).toBe(204);

      const afterReport = await readRunner(run.actor, run.runId, [200]);
      expect(afterReport.body.sandboxStartupPath).toBe("sandbox");

      const completed = await completeRunWithLegacyReuseFields(run, {
        sandboxReuseResult: "reused",
        homeReuseResult: "sandboxReused",
      });
      expect(completed.status).toBe(200);
      expect(completed.body).toStrictEqual({
        success: true,
        status: "completed",
      });

      const afterCompletion = await readRunner(run.actor, run.runId, [200]);
      expect(afterCompletion.body.sandboxStartupPath).toBe("sandbox");
    },
  );

  it(
    "run-runner-startup.bdd-002 dedicated startup API persists home through a pre-cleanup completion",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const run = await startDispatchedChatRun();
      const sandboxHeaders = { authorization: `Bearer ${run.sandboxToken}` };

      const beforeReport = await readRunner(run.actor, run.runId, [200]);
      expect(beforeReport.body.sandboxStartupPath).toBeNull();

      const reported = await reportStartup(
        run.runId,
        "home",
        sandboxHeaders,
        [204],
      );
      expect(reported.status).toBe(204);

      const afterReport = await readRunner(run.actor, run.runId, [200]);
      expect(afterReport.body.sandboxStartupPath).toBe("home");

      const completed = await completeRunWithLegacyReuseFields(run, {
        sandboxReuseResult: "poolMiss",
        homeReuseResult: "reused",
      });
      expect(completed.status).toBe(200);
      expect(completed.body).toStrictEqual({
        success: true,
        status: "completed",
      });

      const afterCompletion = await readRunner(run.actor, run.runId, [200]);
      expect(afterCompletion.body.sandboxStartupPath).toBe("home");
    },
  );

  it(
    "run-runner-startup.bdd-006 same-value retries succeed and conflicting or telemetry reports cannot overwrite startup",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const run = await startDispatchedChatRun();
      const sandboxHeaders = { authorization: `Bearer ${run.sandboxToken}` };

      const firstBlank = await reportStartup(
        run.runId,
        "blank",
        sandboxHeaders,
        [204],
      );
      expect(firstBlank.status).toBe(204);

      const secondBlank = await reportStartup(
        run.runId,
        "blank",
        sandboxHeaders,
        [204],
      );
      expect(secondBlank.status).toBe(204);

      const conflictingCold = await reportStartup(
        run.runId,
        "cold",
        sandboxHeaders,
        [409],
      );
      expect(conflictingCold.status).toBe(409);

      const completed = await completeRun(run);
      expect(completed.body).toStrictEqual({
        success: true,
        status: "completed",
      });

      const postCompletionBlank = await reportStartup(
        run.runId,
        "blank",
        sandboxHeaders,
        [204],
      );
      expect(postCompletionBlank.status).toBe(204);

      const postCompletionHome = await reportStartup(
        run.runId,
        "home",
        sandboxHeaders,
        [409],
      );
      expect(postCompletionHome.status).toBe(409);

      const telemetry = await accept(
        webhookTelemetryApi.send({
          headers: sandboxHeaders,
          body: {
            runId: run.runId,
            sandboxOperations: [
              {
                ts: nowDate().toISOString(),
                action_type: "sandbox_ready",
                duration_ms: 42,
                success: true,
                runner_startup_path: "cold",
              },
            ],
          },
        }),
        [200],
      );
      expect(telemetry.status).toBe(200);

      const finalRunner = await readRunner(run.actor, run.runId, [200]);
      expect(finalRunner.body.sandboxStartupPath).toBe("blank");
    },
  );

  it(
    "run-runner-startup.bdd-008 startup writes and reads preserve Run token, user and organization boundaries",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const run = await startDispatchedChatRun();
      const sandboxHeaders = { authorization: `Bearer ${run.sandboxToken}` };
      const sameOrgMember = bdd.user({
        orgId: run.actor.orgId,
        orgRole: "org:member",
      });
      const sameUserOtherOrg = bdd.user({ userId: run.actor.userId });

      const ownerSessionHeaders = sessionHeadersFor(run.actor);
      const [wrongRunReport, missingAuthReport, clerkSessionReport] =
        await Promise.all([
          reportStartup(randomUUID(), "blank", sandboxHeaders, [401]),
          reportStartup(run.runId, "blank", {}, [401]),
          reportStartup(run.runId, "blank", ownerSessionHeaders, [401]),
        ]);
      expect(wrongRunReport.status).toBe(401);
      expect(missingAuthReport.status).toBe(401);
      expect(clerkSessionReport.status).toBe(401);

      const stillNull = await readRunner(run.actor, run.runId, [200]);
      expect(stillNull.body.sandboxStartupPath).toBeNull();

      const validReport = await reportStartup(
        run.runId,
        "blank",
        sandboxHeaders,
        [204],
      );
      expect(validReport.status).toBe(204);

      const otherMemberRead = await readRunner(sameOrgMember, run.runId, [404]);
      expect(otherMemberRead.status).toBe(404);

      const otherOrgRead = await readRunner(sameUserOtherOrg, run.runId, [404]);
      expect(otherOrgRead.status).toBe(404);

      const unauthRead = await readRunner(null, run.runId, [401]);
      expect(unauthRead.status).toBe(401);

      const ownerRead = await readRunner(run.actor, run.runId, [200]);
      expect(ownerRead.body.sandboxStartupPath).toBe("blank");
    },
  );
});
