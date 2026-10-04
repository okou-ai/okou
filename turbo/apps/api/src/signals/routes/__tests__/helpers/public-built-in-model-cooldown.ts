import { randomUUID } from "node:crypto";
import { expect, onTestFinished } from "vitest";
import type { TestContext } from "../../../../__tests__/test-context";
import { env, mockEnv, mockOptionalEnv } from "../../../../lib/env";
import {
  getSecretKmsClient,
  setSecretKmsClientForTests,
} from "../../../../lib/secret-kms-client";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import type { ApiTestUser } from "./api-bdd";
import { createChatFilesBddApi } from "./api-bdd-chat-files";
import { createRunReadsApi } from "./api-bdd-run-reads";
import { createRunsApi } from "./api-bdd-runs";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";
import { deleteBuiltInCandidateCooldownFixture } from "./runtime-state";

/** Each actual Run reports its own route; expected tuples only verify selection. */
export async function coolDownBuiltInRoutesThroughReports(
  context: TestContext,
  args: {
    readonly actor: ApiTestUser;
    readonly agentId: string;
    readonly runnerGroup: string;
    readonly model: string;
    readonly routes: readonly {
      readonly providerType: string;
      readonly upstreamModel: string;
    }[];
    readonly beforeCooldownCleanup?: () => Promise<void>;
  },
): Promise<void> {
  const runs = createRunsApi(context);
  const chat = createChatFilesBddApi(context);
  const reads = createRunReadsApi(context);

  for (const route of args.routes) {
    const thread = await chat.createThread(args.actor, {
      agentId: args.agentId,
      model: args.model,
    });
    const clientEventId = randomUUID();
    let runId: string | undefined;
    const credentials: { sandboxToken?: string } = {};
    let finished = false;
    const storage = context.mocks.s3.send.getMockImplementation();
    const signedUrl = context.mocks.s3.getSignedUrl.getMockImplementation();
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const kmsKey = env("SECRETS_KMS_KEY_ID");
    const kms = getSecretKmsClient();

    async function findRunId(): Promise<string | undefined> {
      const { events } = await createChatFilesBddApi(context).listThreadEvents(
        args.actor,
        thread.id,
      );
      return events.find((event) => {
        return (
          event.eventType === "input.prompt" &&
          event.revokesEventId === clientEventId
        );
      })?.runId;
    }

    async function finishProducer(): Promise<void> {
      if (finished) {
        return;
      }
      // These clients use the current test signal, including afterEach.
      const cleanupRuns = createRunsApi(context);
      const webhooks = createWebhookCallbackApi(context);
      runId ??= await findRunId();
      if (runId) {
        const current = await cleanupRuns.readRun(args.actor, runId);
        if (current.status === "pending" || current.status === "running") {
          await cleanupRuns.requestCancelRun(args.actor, runId, [200]);
        }
        if (
          credentials.sandboxToken &&
          (current.status === "pending" ||
            current.status === "running" ||
            current.status === "cancelled")
        ) {
          await webhooks.requestAgentComplete(
            { runId, exitCode: 1, error: "Cancelled cooldown producer" },
            { authorization: `Bearer ${credentials.sandboxToken}` },
            [200],
          );
        }
      }
      await flushWaitUntilForTest();
      finished = true;
    }

    // Own the accepted input before sending: even an assertion or pick failure
    // can recover its Run from this real thread without a private list reader.
    onTestFinished(async () => {
      if (!finished) {
        mockEnv("R2_USER_STORAGES_BUCKET_NAME", bucket);
        mockOptionalEnv("SECRETS_KMS_KEY_ID", kmsKey);
        setSecretKmsClientForTests(kms);
        if (storage) {
          context.mocks.s3.send.mockImplementation(storage);
        }
        if (signedUrl) {
          context.mocks.s3.getSignedUrl.mockImplementation(signedUrl);
        }
        createRunsApi(context).acceptTelemetryIngest();
        context.mocks.ably.publish.mockResolvedValue(undefined);
        await flushWaitUntilForTest();
        await finishProducer();
      }
      // An already-owned anchor may still be active on an assertion failure.
      // Finish it before this route's state and later key/mirror hooks run.
      await args.beforeCooldownCleanup?.();
      await deleteBuiltInCandidateCooldownFixture(context, args.model, {
        provider_type: route.providerType,
        upstream_model: route.upstreamModel,
      });
    });

    const sent = await chat.requestSendEvent(
      args.actor,
      {
        agentId: args.agentId,
        threadId: thread.id,
        model: args.model,
        clientEventId,
        prompt: `Report the selected ${route.providerType} route unavailable`,
      },
      [201],
    );
    if (sent.status !== 201) {
      throw new Error("Expected the cooldown producer input to be accepted");
    }
    runId = sent.body.runId ?? undefined;
    await flushWaitUntilForTest();
    runId ??= await findRunId();
    if (!runId) {
      throw new Error("Expected the cooldown producer to launch a Run");
    }
    const runnerIdentity = {
      runnerId: randomUUID(),
      heartbeatGeneration: 1,
    };
    await runs.requestHeartbeatRunner(true, [200], {
      group: args.runnerGroup,
      runnerId: runnerIdentity.runnerId,
      snapshotGeneration: runnerIdentity.heartbeatGeneration,
    });
    const claim = await runs.claimRunnerJob(runId, { runnerIdentity });
    credentials.sandboxToken = claim.sandboxToken;
    const log = await reads.requestReadLogById(args.actor, runId, [200]);
    expect(log.body).toMatchObject({
      id: runId,
      status: "running",
      modelProvider: "built-in",
      selectedModel: args.model,
      modelRuntimeProvider: route.providerType,
      modelRuntimeModel: route.upstreamModel,
    });
    await expect(
      runs.reportRunnerModelProviderFailure(runId, { failureKind: "billing" }),
    ).resolves.toStrictEqual({ outcome: "recorded" });
    await finishProducer();
  }
}
