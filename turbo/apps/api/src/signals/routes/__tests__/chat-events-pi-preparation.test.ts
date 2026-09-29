import { randomUUID } from "node:crypto";
import { PI_SANDBOX_INSTALLED_CLI_MIN_VERSION } from "@okouai/api-contracts/contracts/runners";
import {
  PI_AGENT_RUNTIME_VERSION,
  PI_SESSION_CONSTRUCTION_DIGEST,
} from "@okouai/pi-agent-runtime";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { holdPiContextPreparationStagesFixture } from "../../../test-fixtures/pi-context-preparation";
import { withStableAgentPromptBuildCountFixture } from "../../../test-fixtures/pi-stable-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  createChatEventsFixture,
  requireOrgId,
  createGptUsagePricingResolution,
} from "./helpers/chat-events-fixture";

const context = testContext({ connectorCatalog: true });
const {
  api,
  chat,
  entitledChatActor,
  configureBuiltInPiModel,
  sendChatRun,
  sendWaitingChatInput,
  claimChatRun,
  cancelChatRun,
  mockPiCheckpointObjectStore,
} = createChatEventsFixture(context);

function jsonHttpException(status: 409 | 422, message: string) {
  return new HTTPException(status, {
    res: new Response(JSON.stringify({ error: { message } }), {
      status,
      headers: { "content-type": "application/json" },
    }),
  });
}

describe("CHAT-02: model-first provider policies", () => {
  it("overlaps provider and catalog preparation and skips deferred cache identity", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = requireOrgId(actor);
    await api.heartbeatRunner(runnerGroup);
    await configureBuiltInPiModel(actor, "gpt-5.6-terra");

    const usagePricingResolution = await createGptUsagePricingResolution();
    mockPiCheckpointObjectStore();
    const thread = await chat.createThread(actor, { agentId });
    const preparation = holdPiContextPreparationStagesFixture({
      userId: actor.userId,
      orgId,
      signal: context.signal,
    });
    preparation.release("user-timezone");
    preparation.release("image-model");
    preparation.release("official-workflow");
    const countedRun = withStableAgentPromptBuildCountFixture(async () => {
      return await sendChatRun(
        actor,
        {
          agentId,
          threadId: thread.id,
          prompt: "exercise overlapped legacy context preparation",
          model: "gpt-5.6-terra",
        },
        usagePricingResolution,
      );
    });

    await Promise.all([
      preparation.arrival("post-authorization-context"),
      preparation.arrival("thread-session"),
      preparation.arrival("model-provider"),
    ]);
    expect(preparation.hasArrived("subscription-account")).toBeFalsy();
    preparation.release("post-authorization-context");
    preparation.release("thread-session");

    // Connector preparation reaches its boundary while the provider is held.
    await preparation.arrival("connector-contexts");
    preparation.releaseAll();

    const {
      buildCount,
      cacheIdentityBuildCount,
      result: run,
    } = await countedRun;
    expect(buildCount).toBe(1);
    expect(cacheIdentityBuildCount).toBe(0);
    const claimed = await claimChatRun(runnerGroup, run.runId);
    expect(claimed.claim.appendSystemPrompt).toContain("# Current User Info");
    await cancelChatRun(actor, run.runId, claimed.sandboxHeaders);
  }, 30_000);

  it("preserves the input after the first preparation failure without waiting for another branch", async () => {
    const { actor, agentId } = await entitledChatActor();
    const orgId = requireOrgId(actor);
    await configureBuiltInPiModel(actor, "gpt-5.6-terra");

    const usagePricingResolution = await createGptUsagePricingResolution();
    const thread = await chat.createThread(actor, { agentId });
    const preparation = holdPiContextPreparationStagesFixture({
      userId: actor.userId,
      orgId,
      signal: context.signal,
    });
    const clientEventId = randomUUID();
    const prompt =
      "fail fast on session preparation while authorization is pending";
    // The send only enqueues; preparation runs in the background pick.
    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: thread.id,
        prompt,
        clientEventId,
        model: "gpt-5.6-terra",
      },
      [201],
      { usagePricingResolution },
    );
    expect(sent.body).toStrictEqual({
      runId: null,
      threadId: thread.id,
      createdAt: expect.any(String),
    });

    await Promise.all([
      preparation.arrival("post-authorization-context"),
      preparation.arrival("thread-session"),
    ]);
    const sessionError = jsonHttpException(422, "session preparation failed");
    const failedPick = flushWaitUntilForTest();
    preparation.reject("thread-session", sessionError);
    await expect(failedPick).rejects.toBe(sessionError);
    const authorizationError = jsonHttpException(
      409,
      "authorization preparation failed",
    );
    preparation.reject("post-authorization-context", authorizationError);
    await preparation.departure("post-authorization-context");
    preparation.releaseAll();
    const events = await chat.listThreadEvents(actor, thread.id);
    // An infrastructure failure keeps the original input pending.
    expect(events.events).toStrictEqual([
      expect.objectContaining({
        eventType: "input.prompt",
        id: clientEventId,
      }),
    ]);
    expect(
      events.events.filter((event) => {
        return event.runId !== undefined;
      }),
    ).toStrictEqual([]);
  });

  it("launches an at-capacity Pi send on a fresh session once a slot frees", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    await api.heartbeatRunner(runnerGroup);
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-fable-5-1",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);
    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "hold admission capacity",
      model: "claude-fable-5-1",
    });
    await configureBuiltInPiModel(actor, "gpt-5.6-terra");

    const usagePricingResolution = await createGptUsagePricingResolution();
    mockPiCheckpointObjectStore();
    const prompt = "keep the complete admission independent";
    const waiting = await sendWaitingChatInput(
      actor,
      { agentId, prompt, model: "gpt-5.6-terra" },
      usagePricingResolution,
    );

    await cancelChatRun(actor, anchor.runId);
    const run = await waiting.launchedRun();
    const claimed = await claimChatRun(runnerGroup, run.runId);
    expect(claimed.claim.prompt).toBe(prompt);
    expect(claimed.claim.resumeSession).toBeNull();
    expect(claimed.claim.piSessionId).toBe(run.threadId);
    expect(claimed.claim.piLaunchConfig).toMatchObject({ schemaVersion: 2 });
    expect(claimed.claim.piInstalledCliRequirement).toStrictEqual({
      requiredPiAgentRuntimeVersion: PI_AGENT_RUNTIME_VERSION,
      minCliVersion: PI_SANDBOX_INSTALLED_CLI_MIN_VERSION,
      requiredPiSessionConstructionDigest: PI_SESSION_CONSTRUCTION_DIGEST,
    });
    await cancelChatRun(actor, run.runId, claimed.sandboxHeaders);
  }, 30_000);
});
