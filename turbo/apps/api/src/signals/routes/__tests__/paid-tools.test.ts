import { randomUUID } from "node:crypto";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  paidToolsContract,
  type PaidToolId,
} from "@okouai/api-contracts/contracts/paid-tools";
import {
  runsByIdContract,
  runsCancelContract,
} from "@okouai/api-contracts/contracts/run-routes";
import { runnersHeartbeatContract } from "@okouai/api-contracts/contracts/runners";
import {
  webhookClerkContract,
  webhookCompleteContract,
} from "@okouai/api-contracts/contracts/webhooks";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { env, mockEnv, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { chatEventsRoutes } from "../chat-events";
import { paidToolsRoutes } from "../paid-tools";
import { runsRoutes } from "../runs";
import { runnersRoutes } from "../runners";
import { runsCancelRoutes } from "../runs-cancel";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { deliverOrganizationCreated } from "./helpers/api-bdd-webhooks";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const paidTools = setupApp({ context, routes: paidToolsRoutes })(
  paidToolsContract,
);
const chatEventsClient = setupApp({ context, routes: chatEventsRoutes })(
  chatEventsContract,
);
const webhooksClerkClient = setupApp({ context, routes: webhooksClerkRoutes })(
  webhookClerkContract,
);
const webhooksAgentCompleteClient = setupApp({
  context,
  routes: webhooksAgentCompleteRoutes,
})(webhookCompleteContract);
const runnersHeartbeatClient = setupApp({ context, routes: runnersRoutes })(
  runnersHeartbeatContract,
);
const runDetailClient = setupApp({ context, routes: runsRoutes })(
  runsByIdContract,
);
const runsCancelClient = setupApp({ context, routes: runsCancelRoutes })(
  runsCancelContract,
);

interface Identity {
  readonly userId: string;
  readonly orgId: string;
}

function member(orgId = `org_${randomUUID()}`): Identity {
  return { userId: `user_${randomUUID()}`, orgId };
}

function signIn(identity: Identity) {
  createRouteMocks(context).clerk.session(
    identity.userId,
    identity.orgId,
    "org:member",
  );
}

async function list(identity: Identity) {
  signIn(identity);
  return (await accept(paidTools.get({ headers }), [200])).body.disabledTools;
}

async function setDisabled(
  identity: Identity,
  toolId: PaidToolId,
  disabled: boolean,
) {
  signIn(identity);
  return (
    await accept(
      paidTools.update({ headers, params: { toolId }, body: { disabled } }),
      [200],
    )
  ).body;
}

describe("paid tool preferences", () => {
  beforeAll(async () => {
    const previousClerkSecret = optionalEnv("CLERK_WEBHOOK_SIGNING_SECRET");
    const result = await settleIncludingAbort(async () => {
      mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_warmup_clerk");
      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });
      context.mocks.clerk.verifyWebhook.mockRejectedValueOnce(
        new Error("warmup"),
      );
      const warmupId = randomUUID();
      await Promise.all([
        accept(paidTools.get({ headers: {} }), [401]),
        accept(
          paidTools.update({
            headers: {},
            params: { toolId: "web-search" },
            body: { disabled: true },
          }),
          [401],
        ),
        accept(
          webhooksClerkClient.post({ body: "{}", extraHeaders: {} }),
          [401],
        ),
        accept(
          chatEventsClient.send({
            headers: {},
            body: chatEventsContract.send.body.parse({
              prompt: "warmup",
              model: null,
              userMessage: {
                version: 1,
                parts: [{ type: "text", text: "warmup" }],
              },
              hasTextContent: true,
            }),
          }),
          [401],
        ),
        accept(
          runDetailClient.getById({ headers: {}, params: { id: warmupId } }),
          [401],
        ),
        accept(
          runsCancelClient.cancel({ headers: {}, params: { id: warmupId } }),
          [401],
        ),
        accept(
          webhooksAgentCompleteClient.complete({
            headers: {},
            body: { runId: warmupId, exitCode: 0 },
          }),
          [401],
        ),
        accept(
          runnersHeartbeatClient.heartbeat({
            headers: {},
            body: {
              runnerId: warmupId,
              group: "vm0/warmup",
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
      ]);
    });
    mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", previousClerkSecret);
    if (!result.ok) {
      throw result.error;
    }
  });

  it(
    "paid-tools-011 requires a workspace session and rejects run credentials",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const identity = member();
      mockOptionalEnv("OPENROUTER_API_KEY", "bdd-paid-tools-run-key");
      bdd.acceptStorageWrites();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      context.mocks.ably.publish.mockResolvedValue(undefined);

      const runCleanupState: {
        runId?: string;
        sandboxToken?: string;
        runnerGroup?: string;
      } = {};
      const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
      const kmsKey = env("SECRETS_KMS_KEY_ID");

      onTestFinished(async () => {
        const runId = runCleanupState.runId;
        if (!runId) {
          return;
        }
        const previousRunnerGroup = optionalEnv("RUNNER_DEFAULT_GROUP");
        const cleanupResult = await settleIncludingAbort(async () => {
          mockEnv("R2_USER_STORAGES_BUCKET_NAME", bucket);
          mockEnv("SECRETS_KMS_KEY_ID", kmsKey);
          if (runCleanupState.runnerGroup) {
            mockOptionalEnv(
              "RUNNER_DEFAULT_GROUP",
              runCleanupState.runnerGroup,
            );
          }
          bdd.acceptStorageWrites();
          runs.acceptStorageDownloads();
          runs.acceptTelemetryIngest();
          context.mocks.ably.publish.mockResolvedValue(undefined);
          signIn(identity);
          const current = await accept(
            runDetailClient.getById({
              headers,
              params: { id: runId },
            }),
            [200],
          );
          if (["queued", "pending", "running"].includes(current.body.status)) {
            await accept(
              runsCancelClient.cancel({
                headers,
                params: { id: runId },
              }),
              [200],
            );
          }
          if (
            runCleanupState.sandboxToken &&
            !["completed", "failed", "timeout"].includes(current.body.status)
          ) {
            await accept(
              webhooksAgentCompleteClient.complete({
                headers: {
                  authorization: `Bearer ${runCleanupState.sandboxToken}`,
                },
                body: {
                  runId,
                  exitCode: 1,
                  error: "Run cancelled by test cleanup",
                },
              }),
              [200],
            );
          }
          await flushWaitUntilForTest();
        });
        mockOptionalEnv("RUNNER_DEFAULT_GROUP", previousRunnerGroup);
        if (!cleanupResult.ok) {
          throw cleanupResult.error;
        }
      });

      const [runnerGroup] = await Promise.all([
        runs.configureRunnerGroup(),
        deliverOrganizationCreated(context, identity),
        setDisabled(identity, "web-search", true),
      ]);
      runCleanupState.runnerGroup = runnerGroup;

      signIn(identity);
      await accept(
        chatEventsClient.send({
          headers,
          body: chatEventsContract.send.body.parse({
            prompt: "Exercise paid tool route credentials",
            model: null,
            userMessage: {
              version: 1,
              parts: [
                { type: "text", text: "Exercise paid tool route credentials" },
              ],
            },
            hasTextContent: true,
          }),
        }),
        [201],
      );
      const execution = await runs.nextReceivedExecution(runnerGroup);
      runCleanupState.runId = execution.runId;
      runCleanupState.sandboxToken = execution.sandboxToken;

      const okouToken = execution.platformEnvironment.OKOU_TOKEN;
      if (!okouToken) {
        throw new Error("Expected the dispatched Run's Okou token");
      }
      const sandboxToken = execution.sandboxToken;

      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });
      const anonymousRead = await accept(paidTools.get({ headers: {} }), [401]);

      createRouteMocks(context).clerk.session(identity.userId, null);
      const noOrgRead = await accept(paidTools.get({ headers }), [401]);

      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });
      const [okouRead, okouPatch, sandboxRead, sandboxPatch] =
        await Promise.all([
          accept(
            paidTools.get({
              headers: { authorization: `Bearer ${okouToken}` },
            }),
            [403],
          ),
          accept(
            paidTools.update({
              headers: { authorization: `Bearer ${okouToken}` },
              params: { toolId: "web-search" },
              body: { disabled: false },
            }),
            [403],
          ),
          accept(
            paidTools.get({
              headers: { authorization: `Bearer ${sandboxToken}` },
            }),
            [403],
          ),
          accept(
            paidTools.update({
              headers: { authorization: `Bearer ${sandboxToken}` },
              params: { toolId: "web-search" },
              body: { disabled: false },
            }),
            [403],
          ),
        ]);

      const finalTools = await list(identity);

      expect(anonymousRead.status).toBe(401);
      expect(noOrgRead.status).toBe(401);
      expect([
        okouRead.status,
        okouPatch.status,
        sandboxRead.status,
        sandboxPatch.status,
      ]).toStrictEqual([403, 403, 403, 403]);
      expect(finalTools).toStrictEqual(["web-search"]);
    },
  );

  it("paid-tools-001 lets an ordinary member disable and re-enable a tool idempotently", async () => {
    const identity = member();

    const initial = await list(identity);
    const updates = [
      await setDisabled(identity, "web-search", false),
      await setDisabled(identity, "web-search", true),
      await setDisabled(identity, "web-search", true),
    ];
    await setDisabled(identity, "social", true);
    const afterSocial = await list(identity);
    const reEnables = [
      await setDisabled(identity, "web-search", false),
      await setDisabled(identity, "web-search", false),
    ];
    const final = await list(identity);

    expect(initial).toStrictEqual([]);
    expect(updates).toStrictEqual([
      { toolId: "web-search", disabled: false },
      { toolId: "web-search", disabled: true },
      { toolId: "web-search", disabled: true },
    ]);
    expect(afterSocial).toStrictEqual(["social", "web-search"]);
    expect(reEnables).toStrictEqual([
      { toolId: "web-search", disabled: false },
      { toolId: "web-search", disabled: false },
    ]);
    expect(final).toStrictEqual(["social"]);
  });

  it("paid-tools-002 saves and re-enables the data-search preference", async () => {
    const identity = member();
    await setDisabled(identity, "web-search", true);

    const disabled = await setDisabled(identity, "data-search", true);
    const afterDisable = await list(identity);
    const enabled = await setDisabled(identity, "data-search", false);
    const afterEnable = await list(identity);

    expect(disabled).toStrictEqual({ toolId: "data-search", disabled: true });
    expect(afterDisable).toStrictEqual(["data-search", "web-search"]);
    expect(enabled).toStrictEqual({ toolId: "data-search", disabled: false });
    expect(afterEnable).toStrictEqual(["web-search"]);
  });

  it("paid-tools-008 isolates preferences across members and workspaces", async () => {
    const owner = member();
    const peer = member(owner.orgId);
    const elsewhere: Identity = {
      userId: owner.userId,
      orgId: `org_${randomUUID()}`,
    };
    await setDisabled(owner, "web-search", true);

    const peerInitial = await list(peer);
    await setDisabled(peer, "finance", true);
    const elsewhereInitial = await list(elsewhere);
    await setDisabled(elsewhere, "scrape", true);

    expect(peerInitial).toStrictEqual([]);
    expect(elsewhereInitial).toStrictEqual([]);
    await expect(list(owner)).resolves.toStrictEqual(["web-search"]);
    await expect(list(peer)).resolves.toStrictEqual(["finance"]);
    await expect(list(elsewhere)).resolves.toStrictEqual(["scrape"]);
  });

  it("paid-tools-010 rejects caller-selected owners", async () => {
    const identity = member();
    signIn(identity);
    const request = setupRawAppRequest({ context, routes: paidToolsRoutes });

    const statuses: number[] = [];
    for (const owner of [
      { userId: "another-user" },
      { orgId: "another-org" },
    ]) {
      const response = await request("/api/paid-tools/web-search", {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ disabled: true, ...owner }),
      });
      statuses.push(response.status);
    }

    expect(statuses).toStrictEqual([400, 400]);
    await expect(list(identity)).resolves.toStrictEqual([]);
  });

  it("paid-tools-012 membership deletion clears exactly its paid tool preferences", async () => {
    const departed = member();
    const peer = member(departed.orgId);
    const elsewhere: Identity = {
      userId: departed.userId,
      orgId: `org_${randomUUID()}`,
    };
    for (const identity of [departed, peer, elsewhere]) {
      await setDisabled(identity, "web-search", true);
    }
    const data = {
      organization: { id: departed.orgId },
      public_user_data: { user_id: departed.userId },
    };
    context.mocks.clerk.verifyWebhook.mockResolvedValue({
      type: "organizationMembership.deleted",
      data,
    });

    await accept(
      setupApp({ context, routes: webhooksClerkRoutes })(
        webhookClerkContract,
      ).post({
        body: JSON.stringify({ type: "organizationMembership.deleted", data }),
        extraHeaders: {
          "svix-id": `msg_${randomUUID()}`,
          "svix-timestamp": String(Math.floor(now() / 1000)),
          "svix-signature": "v1,signed-by-clerk",
        },
      }),
      [200],
    );
    await flushWaitUntilForTest();

    await expect(list(departed)).resolves.toStrictEqual([]);
    await expect(list(peer)).resolves.toStrictEqual(["web-search"]);
    await expect(list(elsewhere)).resolves.toStrictEqual(["web-search"]);
  });
});
