import { randomUUID } from "node:crypto";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { buildArtifactKeyV2 } from "../../../lib/file-url";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import {
  createAuthDeviceApiActions,
  mockCodexDeviceAuthProvider,
} from "./helpers/api-bdd-auth-device";
import { createAuthDeviceSupportApi } from "./helpers/api-bdd-auth-device-support";
import {
  createChatEventsFixture,
  executionEnvironment,
  requireOrgId,
} from "./helpers/chat-events-fixture";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { publicChatActor } from "./helpers/public-chat-actor";
import { mockSecretKmsHttp } from "./helpers/secret-kms-http";

const context = testContext();
const { api, configureSubscriptionPiModel, cancelChatRun } =
  createChatEventsFixture(context);
const accounts = createAuthDeviceSupportApi(context);

/** Attachment resolution follows first model-source capture on a normal send. */
function holdAttachment(userId: string) {
  const fileId = randomUUID();
  const filename = "accepted-model.txt";
  const key = buildArtifactKeyV2(fileId, filename);
  const entered = createDeferredPromise<void>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  onTestFinished(() => {
    if (!release.settled()) {
      release.resolve(undefined);
    }
  });
  const original = context.mocks.s3.send.getMockImplementation();
  if (!original) {
    throw new Error("Expected public chat S3 transport");
  }
  context.mocks.s3.send.mockImplementation(async (request: unknown) => {
    if (request instanceof HeadObjectCommand && request.input.Key === key) {
      if (!entered.settled()) {
        entered.resolve(undefined);
      }
      await release.promise;
      return {
        ContentLength: 42,
        ContentType: "text/plain",
        LastModified: new Date("2026-11-18T00:00:00Z"),
        Metadata: {
          "artifact-id": fileId,
          filename: encodeURIComponent(filename),
          "user-id": encodeURIComponent(userId),
        },
      };
    }
    return await original(request);
  });
  return {
    entered: entered.promise,
    release() {
      release.resolve(undefined);
    },
    userMessage: {
      version: 1 as const,
      parts: [
        {
          type: "file" as const,
          fileId,
          filenameSnapshot: filename,
          contentType: "text/plain",
        },
        { type: "text" as const, text: "use my accepted model" },
      ],
    },
  };
}

describe("accepted model source snapshots", () => {
  beforeEach(mockSecretKmsHttp);

  it("keeps the accepted Claude source through disconnection and uses a new source on the next Run", async () => {
    const owned = await publicChatActor(context);
    const { actor, providerId, model } = owned;
    const attachment = holdAttachment(actor.userId);
    const sending = settleIncludingAbort(
      owned.sendChatRun(actor, {
        model,
        prompt: "use my accepted model",
        userMessage: attachment.userMessage,
      }),
    );
    await attachment.entered;
    await owned.run(() => {
      return accounts.deletePersonalModelProvider(
        actor,
        "claude-code-oauth-token",
        [204],
      );
    });
    const replacement = await owned.run(() => {
      return api.ensurePersonalSubscriptionModel(actor, { model });
    });
    expect(replacement.providerId).not.toBe(providerId);
    attachment.release();
    const sent = await sending;
    if (!sent.ok) {
      throw sent.error;
    }
    const first = sent.value;
    const firstExecution = await owned.runExecution(first.runId);
    expect(firstExecution.execution.cliAgentType).toBe("claude-code");
    expect(
      firstExecution.execution.secretConnectorMetadataMap
        ?.CLAUDE_CODE_OAUTH_TOKEN,
    ).toMatchObject({ sourceId: providerId });
    expect(executionEnvironment(firstExecution.execution)).toMatchObject({
      ANTHROPIC_MODEL: model,
    });
    await owned.run(() => {
      return cancelChatRun(actor, first.runId, firstExecution.sandboxHeaders);
    });
    const next = await owned.sendChatRun(actor, {
      model,
      prompt: "use the newly connected source",
    });
    const nextExecution = await owned.runExecution(next.runId);
    expect(
      nextExecution.execution.secretConnectorMetadataMap
        ?.CLAUDE_CODE_OAUTH_TOKEN,
    ).toMatchObject({ sourceId: replacement.providerId });
  });

  it.each([true, false])(
    "keeps coherent Codex routing and recovery identity across reconnect (native=%s)",
    async (native) => {
      const owned = await publicChatActor(context, {
        beforeWorkspaceCleanup: async (actor) => {
          await accounts.deletePersonalModelProvider(
            actor,
            "codex-oauth-token",
            [204, 404],
          );
        },
      });
      owned.ownsFeatureSwitches();
      const { actor } = owned;
      const firstIdentity = `accepted-${randomUUID()}`;
      const laterIdentity = `reconnected-${randomUUID()}`;
      const connected = await owned.run(() => {
        return configureSubscriptionPiModel(actor, {
          accountId: firstIdentity,
        });
      });
      await owned.run(() => {
        return updateFeatureSwitchesForUser(
          context,
          { ...actor, orgId: requireOrgId(actor) },
          { [FeatureSwitchKey.CodexExecution]: native },
        );
      });
      const attachment = holdAttachment(actor.userId);
      const sending = settleIncludingAbort(
        owned.sendChatRun(actor, {
          model: "gpt-6-luna",
          prompt: "use my accepted model",
          userMessage: attachment.userMessage,
        }),
      );
      await attachment.entered;
      const laterAccountId = await owned.run(async () => {
        const auth = createAuthDeviceApiActions(context);
        mockCodexDeviceAuthProvider({ accountId: laterIdentity });
        const started = await auth.requestCodexStart(actor, "personal", [200], {
          mode: "reconnect",
          modelProviderId: connected.accountSourceId,
        });
        if (started.status !== 200) {
          throw new Error("Expected reconnect to start");
        }
        const reconnected = await auth.requestCodexComplete(
          actor,
          started.body.sessionToken,
          [200],
        );
        if (
          !("status" in reconnected.body) ||
          reconnected.body.status !== "complete"
        ) {
          throw new Error("Expected reconnect to complete");
        }
        return reconnected.body.provider.id;
      });
      expect(laterAccountId).not.toBe(connected.accountSourceId);
      attachment.release();
      const sent = await sending;
      if (!sent.ok) {
        throw sent.error;
      }
      const first = sent.value;
      const firstExecution = await owned.runExecution(first.runId);
      expect(firstExecution.execution.cliAgentType).toBe(
        native ? "codex" : "pi",
      );
      expect(
        firstExecution.execution.secretConnectorMetadataMap
          ?.CHATGPT_ACCESS_TOKEN,
      ).toMatchObject({ sourceId: connected.accountSourceId });
      if (native) {
        expect(executionEnvironment(firstExecution.execution)).toMatchObject({
          CODEX_OAUTH_ACCOUNT_ID: firstIdentity,
        });
      } else {
        expect(firstExecution.execution.piModelConfig).toMatchObject({
          dialect: "openai-codex-responses",
          provider: "openai-codex",
          model: "gpt-6-luna",
          credentialBindings: [
            {
              kind: "access-token",
              environment: "CHATGPT_ACCESS_TOKEN",
              secretName: "CHATGPT_ACCESS_TOKEN",
            },
            {
              kind: "account-id",
              environment: "CHATGPT_ACCOUNT_ID",
              secretName: "CHATGPT_ACCOUNT_ID",
            },
          ],
        });
      }
      // Reconnecting to another upstream identity replaces the old account.
      // The admitted Run keeps its original source instead of adopting it.
      expect(
        (await api.readRun(actor, first.runId)).source?.account,
      ).toStrictEqual({
        status: "unavailable",
      });
      await owned.run(() => {
        return cancelChatRun(actor, first.runId, firstExecution.sandboxHeaders);
      });
      const next = await owned.sendChatRun(actor, {
        model: "gpt-6-luna",
        prompt: "use the reconnected identity",
      });
      const nextExecution = await owned.runExecution(next.runId);
      expect(
        (await api.readRun(actor, next.runId)).source?.account,
      ).toStrictEqual({
        status: "connected",
        id: laterAccountId,
      });
      expect(
        nextExecution.execution.secretConnectorMetadataMap
          ?.CHATGPT_ACCESS_TOKEN,
      ).toMatchObject({ sourceId: laterAccountId });
      if (native) {
        expect(executionEnvironment(nextExecution.execution)).toMatchObject({
          CODEX_OAUTH_ACCOUNT_ID: laterIdentity,
        });
      }
    },
  );
});
