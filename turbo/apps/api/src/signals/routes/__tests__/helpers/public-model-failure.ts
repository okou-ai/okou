import { randomUUID } from "node:crypto";
import { expect, onTestFinished } from "vitest";
import type { TestContext } from "../../../../__tests__/test-context";
import { env, mockEnv, mockOptionalEnv } from "../../../../lib/env";
import {
  getSecretKmsClient,
  setSecretKmsClientForTests,
} from "../../../../lib/secret-kms-client";
import { now, withMockNowForTest } from "../../../../lib/time";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./api-bdd";
import { createRunsApi } from "./api-bdd-runs";
import { createChatFilesBddApi } from "./api-bdd-chat-files";
import { createRunReadsApi } from "./api-bdd-run-reads";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";
import { deleteBuiltInCandidateCooldownFixture } from "./runtime-state";

/** Real admissions, claims and public Logs for ordinary model failure cases. */
export async function createPublicModelFailureFixture(
  context: TestContext,
  selectedModels: readonly string[],
  actor: ApiTestUser = createBddApi(context).user(),
) {
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const storage = context.mocks.s3.send.getMockImplementation();
  const signedUrl = context.mocks.s3.getSignedUrl.getMockImplementation();
  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
  const kmsKey = env("SECRETS_KMS_KEY_ID");
  const kms = getSecretKmsClient();
  function restoreExternalSetup(): void {
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", bucket);
    mockOptionalEnv("SECRETS_KMS_KEY_ID", kmsKey);
    setSecretKmsClientForTests(kms);
    if (storage) {
      context.mocks.s3.send.mockImplementation(storage);
    }
    if (signedUrl) {
      context.mocks.s3.getSignedUrl.mockImplementation(signedUrl);
    }
  }
  const runnerGroup = runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  const { providerId } = await runs.ensurePersonalSubscriptionModel(actor);
  await runs.updateOrgModelPolicies(actor, [
    {
      model: "claude-sonnet-5",
      preferred: true,
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      modelProviderId: providerId,
    },
    ...selectedModels.map((model) => {
      return {
        model,
        defaultProviderType: "built-in" as const,
        credentialScope: "org" as const,
        modelProviderId: null,
      };
    }),
  ]);
  const agent = await bdd.createAgent(actor, {
    displayName: "Public model failure observation",
  });
  const owned = new Map<
    string,
    { sandboxToken?: string; finished: boolean; admittedAt: number }
  >();
  const rejectionInputs = new Map<
    string,
    { clientEventId: string; admittedAt: number }
  >();
  const observedRoutes = new Map<
    string,
    { selectedModel: string; provider_type: string; upstream_model: string }
  >();

  async function finish(runId: string): Promise<void> {
    const entry = owned.get(runId);
    if (!entry || entry.finished) {
      return;
    }
    // Preserve the actual claim-issued token when teardown has left a
    // historical app-clock scope. No replacement token or real-time wait.
    await withMockNowForTest(entry.admittedAt, async () => {
      const currentRuns = createRunsApi(context);
      currentRuns.acceptTelemetryIngest();
      context.mocks.ably.publish.mockResolvedValue(undefined);
      const current = await currentRuns.readRun(actor, runId);
      if (current.status === "pending" || current.status === "running") {
        await currentRuns.requestCancelRun(actor, runId, [200]);
      }
      if (
        entry.sandboxToken &&
        (current.status === "pending" ||
          current.status === "running" ||
          current.status === "cancelled")
      ) {
        await createWebhookCallbackApi(context).requestAgentComplete(
          { runId, exitCode: 1, error: "Cancelled by model failure test" },
          { authorization: `Bearer ${entry.sandboxToken}` },
          [200],
        );
      }
      await flushWaitUntilForTest();
    });
    entry.finished = true;
  }

  onTestFinished(async () => {
    restoreExternalSetup();
    // Own even an unexpectedly admitted rejection probe before asserting its
    // public result, so a regression cannot leak a pending Run into teardown.
    for (const [threadId, input] of rejectionInputs) {
      const { events } = await createChatFilesBddApi(context).listThreadEvents(
        actor,
        threadId,
      );
      const launched = events.find((event) => {
        return (
          event.eventType === "input.prompt" &&
          event.revokesEventId === input.clientEventId
        );
      });
      if (launched?.runId) {
        owned.set(launched.runId, {
          finished: false,
          admittedAt: input.admittedAt,
        });
      }
    }
    for (const runId of owned.keys()) {
      await finish(runId);
    }
    for (const route of observedRoutes.values()) {
      await deleteBuiltInCandidateCooldownFixture(
        context,
        route.selectedModel,
        route,
      );
    }
    await createBddApi(context).deleteAgent(actor, agent.agentId);
    await flushWaitUntilForTest();
  });

  async function admit(selectedModel: string) {
    const run = await createRunsApi(context).createThreadRun(actor, {
      agentId: agent.agentId,
      prompt: `Observe selected route ${randomUUID()}`,
      model: selectedModel,
    });
    owned.set(run.runId, { finished: false, admittedAt: now() });
    const response = await createRunReadsApi(context).requestReadLogById(
      actor,
      run.runId,
      [200],
    );
    if (response.status !== 200) {
      throw new Error("Expected the admitted Run's public Log");
    }
    const log = response.body;
    expect(log).toMatchObject({ modelProvider: "built-in", selectedModel });
    if (!log.modelRuntimeProvider || !log.modelRuntimeModel) {
      throw new Error("Expected the actual admitted runtime tuple");
    }
    return { run, log };
  }

  return {
    actor,
    agentId: agent.agentId,
    runnerGroup,
    finish,
    async claim(selectedModel: string) {
      const { run, log } = await admit(selectedModel);
      if (!log.modelRuntimeProvider || !log.modelRuntimeModel) {
        throw new Error("Expected the claimed runtime tuple");
      }
      observedRoutes.set(
        `${selectedModel}/${log.modelRuntimeProvider}/${log.modelRuntimeModel}`,
        {
          selectedModel,
          provider_type: log.modelRuntimeProvider,
          upstream_model: log.modelRuntimeModel,
        },
      );
      const currentRuns = createRunsApi(context);
      const runnerIdentity = { runnerId: randomUUID(), heartbeatGeneration: 7 };
      await currentRuns.requestHeartbeatRunner(true, [200], {
        group: runnerGroup,
        runnerId: runnerIdentity.runnerId,
        snapshotGeneration: runnerIdentity.heartbeatGeneration,
      });
      const claim = await currentRuns.claimRunnerJob(run.runId, {
        runnerIdentity,
      });
      const entry = owned.get(run.runId);
      if (!entry) {
        throw new Error("Expected owned claimed Run");
      }
      entry.sandboxToken = claim.sandboxToken;
      await expect(
        currentRuns.readRun(actor, run.runId),
      ).resolves.toMatchObject({
        status: "running",
      });
      return {
        actor,
        agentId: agent.agentId,
        selectedModel,
        runId: run.runId,
        log,
      };
    },
    async readAdmissionRejection(selectedModel: string) {
      const chat = createChatFilesBddApi(context);
      const thread = await chat.createThread(actor, {
        agentId: agent.agentId,
        model: selectedModel,
      });
      const clientEventId = randomUUID();
      rejectionInputs.set(thread.id, { clientEventId, admittedAt: now() });
      await chat.requestSendEvent(
        actor,
        {
          agentId: agent.agentId,
          threadId: thread.id,
          model: selectedModel,
          clientEventId,
          prompt: `Observe unavailable route ${randomUUID()}`,
        },
        [201],
      );
      await flushWaitUntilForTest();
      const { events } = await chat.listThreadEvents(actor, thread.id);
      return events.find((event) => {
        return (
          event.eventType === "input.rejected" &&
          event.revokesEventId === clientEventId
        );
      });
    },
    async readAdmission(selectedModel: string) {
      const { run, log } = await admit(selectedModel);
      await finish(run.runId);
      return log;
    },
  };
}
