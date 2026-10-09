import { createHash, randomUUID } from "node:crypto";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { logsListContract } from "@okouai/api-contracts/contracts/logs";
import { runnersJobClaimContract } from "@okouai/api-contracts/contracts/runners";
import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import { expect } from "vitest";

import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { env, mockOptionalEnv } from "../../../../lib/env";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { logsRoutes } from "../../logs";
import { runnersRoutes } from "../../runners";
import { workflowAutomationsRoutes } from "../../workflow-automations";
import { createBddApi, type ApiTestUser } from "./api-bdd";
import { createRunsApi } from "./api-bdd-runs";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";
import { createWorkflowsBddApi } from "./api-bdd-workflows";
import { installDurableUserExportStorage } from "./durable-user-export-storage";
import { createRouteMocks } from "./route-test";
import { useSecretKmsProbe } from "./secret-kms-probe";

interface Owner {
  readonly orgId: string;
  readonly userId: string;
}

interface PublicRemoteAccessRun extends Owner {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly runnerGroup: string;
}

interface OwnedRun {
  readonly actor: ApiTestUser;
  readonly restoreStorage: () => void;
  agentId?: string;
  runId?: string;
  sandboxToken?: string;
  acknowledged: boolean;
}

/** Real terminal and event-source Runs; synthetic historical runtimes stay separate. */
export function createPublicRemoteAccessRunApi(context: TestContext) {
  const owned: OwnedRun[] = [];

  function auth(actor: ApiTestUser) {
    createRouteMocks(context).clerk.session(
      actor.userId,
      actor.orgId,
      actor.orgRole,
    );
    return { authorization: "Bearer clerk-session" };
  }

  async function start(
    owner: Owner,
    source: "web" | "automation-event" = "web",
  ): Promise<PublicRemoteAccessRun> {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const bootstrapActor = bdd.user({ ...owner, orgRole: "org:admin" });
    const actor = bdd.user({ ...owner, orgRole: "org:member" });
    useSecretKmsProbe();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    installDurableUserExportStorage(context, { prefixes: [""] });
    const storage = context.mocks.s3.send.getMockImplementation();
    const signedUrl = context.mocks.s3.getSignedUrl.getMockImplementation();
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const kmsKey = env("SECRETS_KMS_KEY_ID");
    const state: OwnedRun = {
      actor,
      acknowledged: false,
      restoreStorage() {
        mockOptionalEnv("R2_USER_STORAGES_BUCKET_NAME", bucket);
        mockOptionalEnv("SECRETS_KMS_KEY_ID", kmsKey);
        if (storage) {
          context.mocks.s3.send.mockImplementation(storage);
        }
        if (signedUrl) {
          context.mocks.s3.getSignedUrl.mockImplementation(signedUrl);
        }
      },
    };
    owned.push(state);
    await runs.grantProEntitlement(bootstrapActor, {
      tier: source === "automation-event" ? "team" : "pro",
    });
    await runs.ensurePersonalSubscriptionModel(bootstrapActor, {
      model: "claude-fable-5-1",
    });
    await bdd.readOnboardingStatus(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "Remote access lifecycle Agent",
      visibility: "public",
    });
    state.agentId = agent.agentId;
    const runnerGroup = runs.configureRunnerGroup();
    let runId: string;
    let threadId: string;
    if (source === "web") {
      const run = await runs.createThreadRun(actor, {
        agentId: agent.agentId,
        prompt: "Use my configured remote hosts",
        model: "claude-fable-5-1",
      });
      runId = run.runId;
      threadId = run.threadId;
      state.runId = runId;
    } else {
      const workflows = createWorkflowsBddApi(context);
      const workflowId = await workflows.createWorkflow(actor, {
        agentId: agent.agentId,
        name: `remote-access-${randomUUID().slice(0, 8)}`,
        instruction: "Use the owner's currently authorized remote hosts.",
      });
      const automationApi = setupApp({
        context,
        routes: workflowAutomationsRoutes,
      })(workflowAutomationsContract);
      const automation = await accept(
        automationApi.create({
          headers: auth(actor),
          params: { workflowId },
          body: {
            kind: "event",
            eventType: "webhook-received",
            enabled: true,
          },
        }),
        [201],
      );
      const started = await accept(
        automationApi.run({
          headers: auth(actor),
          params: { id: automation.body.id },
        }),
        [201],
      );
      threadId = started.body.chatThreadId;
      await flushWaitUntilForTest();
      const events = await workflows.readThreadEvents(threadId);
      const input = events.find((event) => {
        return event.eventType === "input.prompt" && event.runId;
      });
      if (!input?.runId) {
        throw new Error("Expected the real event Automation Run");
      }
      runId = input.runId;
      state.runId = runId;
      const logs = await accept(
        setupApp({ context, routes: logsRoutes })(logsListContract).list({
          headers: auth(actor),
          query: { limit: 100 },
        }),
        [200],
      );
      expect(logs.body.data).toContainEqual(
        expect.objectContaining({
          id: runId,
          triggerSource: "automation-event",
        }),
      );
    }
    await expect(runs.readRun(actor, runId)).resolves.toMatchObject({
      status: "pending",
    });
    return {
      ...owner,
      actor,
      agentId: agent.agentId,
      runId,
      threadId,
      runnerGroup,
    };
  }

  function ownedRun(runId: string): OwnedRun {
    const state = owned.find((candidate) => {
      return candidate.runId === runId;
    });
    if (!state) {
      throw new Error("Expected an owned remote-access Run");
    }
    return state;
  }

  async function claim(
    run: PublicRemoteAccessRun,
    runnerHeaders: { readonly authorization: string },
  ) {
    const runs = createRunsApi(context);
    const runnerIdentity = {
      runnerId: randomUUID(),
      heartbeatGeneration: 5_000_000_000,
    };
    await runs.requestHeartbeatRunnerAs(runnerHeaders.authorization, [200], {
      group: run.runnerGroup,
      runnerId: runnerIdentity.runnerId,
      snapshotGeneration: runnerIdentity.heartbeatGeneration,
    });
    const response = await accept(
      setupApp({ context, routes: runnersRoutes })(
        runnersJobClaimContract,
      ).claim({
        headers: runnerHeaders,
        params: { id: run.runId },
        body: {
          runnerIdentity,
          capabilities: { piModelConfigGenerations: [1, 2, 3] },
        },
      }),
      [200],
    );
    const sandboxToken = response.body.sandboxToken;
    if (!sandboxToken) {
      throw new Error(
        "Expected the real Runner claim to issue its sandbox token",
      );
    }
    ownedRun(run.runId).sandboxToken = sandboxToken;
    await expect(runs.readRun(run.actor, run.runId)).resolves.toMatchObject({
      status: "running",
    });
    await flushWaitUntilForTest();
    const agentToken = response.body.platformEnvironment.OKOU_TOKEN;
    if (!agentToken) {
      throw new Error("Expected the claim's real Agent credential");
    }
    return { ...run, runnerIdentity, sandboxToken, agentToken };
  }

  async function finish(
    run: Awaited<ReturnType<typeof claim>>,
    status: "completed" | "cancelled" | "failed",
  ) {
    const runs = createRunsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const headers = { authorization: `Bearer ${run.sandboxToken}` };
    if (status === "completed") {
      await webhooks.requestAgentEvents(
        { runId: run.runId, events: [{ type: "system", sequenceNumber: 0 }] },
        headers,
        [200],
      );
      const history = Buffer.from(`remote access session history ${run.runId}`);
      const hash = createHash("sha256").update(history).digest("hex");
      const previousStorage = context.mocks.s3.send.getMockImplementation();
      context.mocks.s3.send.mockImplementation((command: unknown) => {
        if (
          (command instanceof HeadObjectCommand ||
            command instanceof GetObjectCommand) &&
          command.input.Key === `blobs/${hash}.blob`
        ) {
          return Promise.resolve({
            ContentLength: history.byteLength,
            ...(command instanceof GetObjectCommand
              ? {
                  Body: {
                    async *[Symbol.asyncIterator]() {
                      yield history;
                    },
                  },
                }
              : {}),
          });
        }
        if (!previousStorage) {
          throw new Error("Expected the owned external object store");
        }
        return previousStorage(command);
      });
      await webhooks.requestAgentSessionHistoryPrepare(
        {
          runId: run.runId,
          hash,
          rawSize: history.byteLength,
          encodedSize: history.byteLength,
          encoding: "identity",
        },
        headers,
        [200],
      );
      await webhooks.requestAgentComplete(
        {
          runId: run.runId,
          exitCode: 0,
          lastEventSequence: 0,
          completion: {
            cliAgentType: "claude-code",
            cliAgentSessionId: `remote-access-${run.runId}`,
            cliAgentSessionHistoryHash: hash,
          },
        },
        headers,
        [200],
      );
    } else {
      if (status === "cancelled") {
        await runs.requestCancelRun(run.actor, run.runId, [200]);
      }
      await webhooks.requestAgentComplete(
        { runId: run.runId, exitCode: 1, error: `Remote access Run ${status}` },
        headers,
        [200],
      );
    }
    ownedRun(run.runId).acknowledged = true;
    await flushWaitUntilForTest();
    const result = await runs.readRun(run.actor, run.runId);
    expect(result.status).toBe(status);
    if (status === "completed") {
      expect(result.result?.conversationId).toStrictEqual(expect.any(String));
    }
  }

  async function cleanup() {
    for (const state of owned.splice(0)) {
      state.restoreStorage();
      useSecretKmsProbe();
      context.mocks.ably.publish.mockResolvedValue(undefined);
      const runs = createRunsApi(context);
      if (state.runId && !state.acknowledged) {
        const current = await runs.readRun(state.actor, state.runId);
        if (current.status === "pending" || current.status === "running") {
          await runs.requestCancelRun(state.actor, state.runId, [200]);
        }
        if (
          state.sandboxToken &&
          (current.status === "pending" ||
            current.status === "running" ||
            current.status === "cancelled")
        ) {
          await createWebhookCallbackApi(context).requestAgentComplete(
            {
              runId: state.runId,
              exitCode: 1,
              error: "Run cancelled by test cleanup",
            },
            { authorization: `Bearer ${state.sandboxToken}` },
            [200],
          );
        }
      }
      await flushWaitUntilForTest();
      if (state.agentId) {
        await createBddApi(context).deleteAgent(state.actor, state.agentId);
      }
      await flushWaitUntilForTest();
    }
  }

  return { start, claim, finish, cleanup };
}
