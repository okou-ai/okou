import { assertPiLangfuseRelayContract } from "./helpers/pi-langfuse-relay";
import { randomUUID } from "node:crypto";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";

import { upsertOrgPlanEntitlementFixture } from "../../../test-fixtures/org-plan-entitlement";

import { flushWaitUntilForTest } from "../../context/wait-until";
import { expectApiError, type ApiTestUser } from "./helpers/api-bdd";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

import { seedBuiltInModelCandidateKeys } from "./helpers/runtime-state";
import {
  createChatEventsFixture,
  configureNativeCliArtifact,
  CODEX_WEB_IMAGE_UPLOAD_PROMPT_SNIPPET,
  type ChatRunSendBody,
  type PromptMessage,
  requireOrgId,
  createGptUsagePricingResolution,
  claimEnvironment,
  userMessages,
} from "./helpers/chat-events-fixture";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { coolDownBuiltInRoutesThroughReports } from "./helpers/public-built-in-model-cooldown";
import { SEEDED_SYSTEM_DEFAULT_MODEL } from "./helpers/seeded-system-default";

const context = testContext();
const {
  api,
  chat,
  chatCallbacks,
  misc,
  authDeviceSupport,
  entitledChatActor,

  seedBuiltInModelKey,
  configureBuiltInPiModel,
  configureBuiltInPiModelOnOpenRouter,
  configureSubscriptionPiModel,
  sendChatRun,
  claimChatRun,
  waitForThreadMessages,
  completeChatRunOk,
  cancelChatRun,

  readThreadProjection,
  mockPiCheckpointObjectStore,
  publishPendingPiInstructions,
  mockPiResourceArchiveDownloads,
  completeSandboxFirstPiRun,
} = createChatEventsFixture(context);

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function unsignedJwt(payload: Record<string, unknown>): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  return `${header}.${base64UrlEncode(JSON.stringify(payload))}.bdd-signature`;
}

function codexAuthJson(): string {
  const accessExp = Math.floor(now() / 1000) + 7200;
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      access_token: unsignedJwt({ exp: accessExp }),
      refresh_token: "rt_bdd_chat_fast_mode",
      account_id: "ws_acct_bdd_fast_mode",
      id_token: unsignedJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "ws_acct_bdd_fast_mode_id_token",
          chatgpt_plan_type: "plus",
          organization: { title: "BDD Chat Fast Mode" },
        },
        exp: accessExp,
      }),
    },
  });
}

// Keep Pi's sandbox launch resource handoff deterministic for tests that
// inspect the frozen Sandbox claim.
async function preparePiResourceHandoff(
  actor: ApiTestUser,
  agentId: string,
): Promise<void> {
  await publishPendingPiInstructions(actor, agentId);
  mockPiResourceArchiveDownloads(true);
  mockPiCheckpointObjectStore();
}

/**
 * A claimed Run reports the test-owned model's OpenRouter route unavailable.
 * The configured direct DeepSeek candidate remains ineligible for new Runs.
 */
async function builtInModelWithOpenRouterCoolingDown(
  actor: ApiTestUser,
  agentId: string,
  runnerGroup: string,
): Promise<"okou-1.0"> {
  await configureBuiltInPiModel(actor, "okou-1.0");
  await preparePiResourceHandoff(actor, agentId);
  await coolDownBuiltInRoutesThroughReports(context, {
    actor,
    agentId,
    runnerGroup,
    model: "okou-1.0",
    routes: [
      { providerType: "openrouter-codex", upstreamModel: "@preset/okou-1-0" },
    ],
  });
  return "okou-1.0";
}

/**
 * Wait for the background pick to consume a sent input: its replacement is
 * the launched `input.prompt` carrying the run, or its `input.rejected`.
 */
async function waitForPickedInput(
  actor: ApiTestUser,
  threadId: string,
  clientEventId: string,
) {
  await flushWaitUntilForTest();
  const messages = await waitForThreadMessages(actor, threadId, (items) => {
    return userMessages(items).some((message) => {
      return (
        message.revokesEventId === clientEventId &&
        (message.eventType === "input.rejected" || message.runId !== undefined)
      );
    });
  });
  const picked = userMessages(messages.events).find((message) => {
    return message.revokesEventId === clientEventId;
  });
  if (!picked) {
    throw new Error("Expected the picked input replacement");
  }
  return { picked, events: messages.events };
}

/** A send is accepted without a run; wait for its pick's outcome. */
async function sendUntilPicked(
  actor: ApiTestUser,
  body: Omit<ChatRunSendBody, "template" | "clientEventId">,
) {
  const clientEventId = randomUUID();
  const sent = await chat.requestSendEvent(
    actor,
    { ...body, clientEventId },
    [201],
  );
  if (sent.status !== 201) {
    throw new Error("Expected the send to be accepted");
  }
  expect(sent.body.runId).toBeNull();
  const threadId = sent.body.threadId;
  return {
    threadId,
    ...(await waitForPickedInput(actor, threadId, clientEventId)),
  };
}

describe("CHAT-02: model-first provider policies", () => {
  it("adds Codex image upload guidance for web chat Codex sends", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const prompt =
      "generate an image in web chat using the aurora-21210 color palette";

    await misc.upsertPersonalModelProvider(
      actor,
      {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        secrets: { CODEX_AUTH_JSON: codexAuthJson() },
      },
      [200, 201],
    );
    await api.updateUserModelPreference(actor, "gpt-6-astra");

    const run = await sendChatRun(actor, {
      agentId,
      prompt,
      model: "gpt-6-astra",
    });
    const { claim } = await claimChatRun(runnerGroup, run.runId);
    const appendSystemPrompt = claim.appendSystemPrompt ?? "";
    expect(claim.cliAgentType).toBe("codex");
    expect(appendSystemPrompt).toContain(
      "You are currently running inside: Web",
    );
    expect(appendSystemPrompt).toContain("okou web upload-file -h");
    expect(appendSystemPrompt).toContain("okou mail link <gmail-draft-id>");
    expect(appendSystemPrompt).toContain(
      "GET /gmail/v1/users/me/settings/sendAs",
    );
    expect(appendSystemPrompt).toContain(
      "Include a `multipart/alternative` body",
    );
    expect(appendSystemPrompt).toContain(
      "Keep each plain-text paragraph on one logical line",
    );
    expect(appendSystemPrompt).toContain(
      "use HTML paragraph elements so Gmail wraps the message naturally",
    );
    expect(appendSystemPrompt).toContain("append that signature exactly once");
    expect(appendSystemPrompt).toContain(
      "return the link from the command to the user",
    );
    expect(appendSystemPrompt).toContain("Do not add a mail callback prompt");
    expect(appendSystemPrompt).toContain(
      "confirm the send against Gmail before reporting it",
    );
    expect(appendSystemPrompt).toContain(
      "`okou workflow automation list <workflow>` shows one workflow's triggers",
    );
    expect(appendSystemPrompt).toContain(
      "Never send a reply automatically; the user always sends",
    );
    expect(appendSystemPrompt).toContain(CODEX_WEB_IMAGE_UPLOAD_PROMPT_SNIPPET);
    expect(appendSystemPrompt).not.toContain("When running in Codex");
    let previousSectionIndex = -1;
    for (const section of [
      "# Agent Identity",
      "# Execution Time Limit",
      "# Agent Tools",
      "# Current User Info",
      "# Current Integration",
      CODEX_WEB_IMAGE_UPLOAD_PROMPT_SNIPPET,
    ]) {
      const sectionIndex = appendSystemPrompt.indexOf(section);
      expect(sectionIndex).toBeGreaterThan(previousSectionIndex);
      previousSectionIndex = sectionIndex;
    }
    await cancelChatRun(actor, run.runId);
  });

  it("queues an existing-thread input with its model until the active run releases the thread", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await api.ensurePersonalSubscriptionModel(actor, {
      model: "claude-fable-5-1",
    });

    const thread = await chat.createThread(actor, {
      agentId,
      model: "claude-fable-5-1",
    });
    // Keep the thread busy so the follow-up stays queued after model selection.
    const active = await sendChatRun(actor, {
      agentId,
      threadId: thread.id,
      prompt: "keep the thread busy",
    });

    const clientEventId = randomUUID();
    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: thread.id,
        prompt: "enqueue with the thread model",
        clientEventId,
      },
      [201],
    );
    expect(sent).toMatchObject({ status: 201, body: { runId: null } });
    await flushWaitUntilForTest();
    expect(
      (await chat.listThreadEvents(actor, thread.id)).events,
    ).toContainEqual(
      expect.objectContaining({ id: clientEventId, eventType: "input.prompt" }),
    );
    expect(
      (await chat.listThreadEvents(actor, thread.id)).events,
    ).not.toContainEqual(
      expect.objectContaining({ revokesEventId: clientEventId }),
    );

    await cancelChatRun(actor, active.runId);
    const { picked } = await waitForPickedInput(
      actor,
      thread.id,
      clientEventId,
    );
    if (picked.runId === undefined) {
      throw new Error("Expected the follow-up to launch after the cancel");
    }
    const { claim } = await claimChatRun(runnerGroup, picked.runId);
    expect(claim.modelUsageProvider).toBe("claude-fable-5-1");
    await cancelChatRun(actor, picked.runId);
  }, 90_000);

  it.each(["deepseek-v4.1-flash", "deepseek-v4-flash", "gpt-6-luna"])(
    "rejects retired platform selection %s without a personal subscription",
    async (model) => {
      const { actor, agentId } = await entitledChatActor();
      const response = await chat.requestCreateThread(
        actor,
        { agentId, model },
        [400],
      );
      expect(response.status).toBe(400);
      expectApiError(response.body);
    },
  );

  it("exposes the owner's run trace URL after tracing is disabled", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = requireOrgId(actor);
    await configureBuiltInPiModel(actor, "okou-1.0");
    const pricing = await createGptUsagePricingResolution();
    mockPiResourceArchiveDownloads();
    const checkpointObjects = mockPiCheckpointObjectStore();
    mockOptionalEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-bdd-trace-link");
    mockOptionalEnv("LANGFUSE_SECRET_KEY", "sk-lf-bdd-trace-link");
    mockOptionalEnv("LANGFUSE_BASE_URL", undefined);
    mockOptionalEnv("LANGFUSE_PROJECT_ID", undefined);
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      {
        [FeatureSwitchKey.LangfuseTrace]: true,
      },
    );
    const tracedPrompt = "complete a traced run";
    const traced = await sendChatRun(actor, {
      agentId,
      prompt: tracedPrompt,
      model: "okou-1.0",
    });
    await completeSandboxFirstPiRun({
      actor,
      answer: "Completed answer",
      checkpointObjects,
      claim: await claimChatRun(runnerGroup, traced.runId),
      prompt: tracedPrompt,
      run: traced,
      usagePricingResolution: pricing,
    });
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      {
        [FeatureSwitchKey.LangfuseTrace]: false,
      },
    );
    const traceUrl = `https://us.cloud.langfuse.com/project/cmu0bvhcu012gad0drbw8ddts/traces/${traced.runId.replaceAll("-", "")}`;
    expect((await api.readRun(actor, traced.runId)).langfuseTraceUrl).toBe(
      traceUrl,
    );
    const untraced = await sendChatRun(actor, {
      agentId,
      threadId: traced.threadId,
      prompt: "continue without tracing",
      model: "okou-1.0",
    });
    await flushWaitUntilForTest();
    expect((await api.readRun(actor, untraced.runId)).status).toBe("pending");
    await expect(
      api.readRun(actor, untraced.runId),
    ).resolves.not.toHaveProperty("langfuseTraceUrl");
    expect((await api.readRun(actor, traced.runId)).langfuseTraceUrl).toBe(
      traceUrl,
    );
    const peer = { ...actor, userId: `${actor.userId}_peer` };
    await api.requestReadRun(peer, traced.runId, [404]);
    mockOptionalEnv("LANGFUSE_BASE_URL", "https://langfuse.example/");
    mockOptionalEnv("LANGFUSE_PROJECT_ID", "  project-debug  ");
    expect((await api.readRun(actor, traced.runId)).langfuseTraceUrl).toBe(
      `https://langfuse.example/project/project-debug/traces/${traced.runId.replaceAll("-", "")}`,
    );
    mockOptionalEnv("LANGFUSE_BASE_URL", "javascript:alert(1)");
    await expect(api.readRun(actor, traced.runId)).resolves.not.toHaveProperty(
      "langfuseTraceUrl",
    );
    await cancelChatRun(actor, untraced.runId);
  });

  it("relays admitted run traces with platform credentials after runner claim", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = requireOrgId(actor);
    await publishPendingPiInstructions(actor, agentId);
    await configureBuiltInPiModel(actor, "okou-1.0");
    mockPiResourceArchiveDownloads(true);
    mockOptionalEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-bdd-trace-admission");
    mockOptionalEnv("LANGFUSE_SECRET_KEY", "sk-lf-bdd-trace-admission");
    mockOptionalEnv("LANGFUSE_BASE_URL", "https://langfuse.example");
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      {
        [FeatureSwitchKey.LangfuseTrace]: true,
      },
    );
    await api.heartbeatRunner(runnerGroup);

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "preserve the Langfuse trace gate through claim",
      model: "okou-1.0",
    });
    await flushWaitUntilForTest();

    const claimed = await claimChatRun(runnerGroup, run.runId);
    expect(claimed.claim.cliAgentType).toBe("pi");
    expect(claimed.claim.platformEnvironment).toMatchObject({
      OKOU_PI_LANGFUSE_DEBUG_ENABLED: "true",
      LANGFUSE_TRACING_ENABLED: "true",
    });
    expect(claimed.claim.platformEnvironment).not.toHaveProperty(
      "LANGFUSE_PUBLIC_KEY",
    );
    expect(claimed.claim.platformEnvironment).not.toHaveProperty(
      "LANGFUSE_SECRET_KEY",
    );
    expect(claimed.claim.secretValues).not.toContain(
      "sk-lf-bdd-trace-admission",
    );
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      {
        [FeatureSwitchKey.LangfuseTrace]: false,
      },
    );
    const relay = await assertPiLangfuseRelayContract(context, {
      runId: run.runId,
      token: claimed.claim.platformEnvironment.OKOU_TOKEN,
    });
    await cancelChatRun(actor, run.runId, claimed.sandboxHeaders);

    const untraced = await sendChatRun(actor, {
      agentId,
      prompt: "run without trace admission",
      model: "okou-1.0",
    });
    await flushWaitUntilForTest();
    const untracedClaim = await claimChatRun(runnerGroup, untraced.runId);
    await relay.expectAdmissionDenied(
      untraced.runId,
      untracedClaim.claim.platformEnvironment.OKOU_TOKEN,
    );
    await cancelChatRun(actor, untraced.runId, untracedClaim.sandboxHeaders);
  });

  it.each([
    { name: "stored selection", requestedModel: undefined },
    { name: "retired personal alias", requestedModel: "claude-fable-5" },
  ])(
    "rejects a disconnected thread subscription ($name) until its owner explicitly selects Auto",
    async ({ requestedModel }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      chatCallbacks.failIfChatCallbackRouteIsFetched();
      await api.ensurePersonalSubscriptionModel(actor, {
        model: "claude-fable-5-1",
      });

      const first = await sendChatRun(actor, {
        agentId,
        prompt: "start before the thread model is removed",
        model: "claude-fable-5-1",
      });
      const firstClaim = await claimChatRun(runnerGroup, first.runId);
      expect(firstClaim.claim.cliAgentType).toBe("claude-code");
      expect(claimEnvironment(firstClaim.claim).ANTHROPIC_MODEL).toBe(
        "claude-fable-5-1",
      );
      chatCallbacks.mockChatOutputEvents([]);
      await completeChatRunOk(first.runId, firstClaim.sandboxHeaders);
      await flushWaitUntilForTest();

      await seedBuiltInModelKey(SEEDED_SYSTEM_DEFAULT_MODEL);
      await seedBuiltInModelKey("okou-1.0");
      await misc.deletePersonalModelProvider(
        actor,
        "claude-code-oauth-token",
        [204],
      );
      // The member preference does not replace an unavailable thread model.
      await api.updateUserModelPreference(actor, "okou-1.0");
      await preparePiResourceHandoff(actor, agentId);

      const clientEventId = randomUUID();
      await chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: first.threadId,
          prompt: "continue through my disconnected subscription",
          model: requestedModel,
          clientEventId,
        },
        [201],
      );
      const { picked } = await waitForPickedInput(
        actor,
        first.threadId,
        clientEventId,
      );
      expect(picked).toMatchObject({
        eventType: "input.rejected",
        error: "conflict",
      });
      expect(picked.runId).toBeUndefined();
      // A send may persist its requested alias as metadata; that alias must still
      // capture the personal source rather than authorizing platform execution.
      await expect(
        chat.readThreadMetadata(actor, first.threadId),
      ).resolves.toMatchObject({
        selectedModel: requestedModel ?? "claude-fable-5-1",
      });
      await chat.updateThreadModelSelection(actor, first.threadId, "okou-1.0");
      const fallback = await sendChatRun(actor, {
        agentId,
        threadId: first.threadId,
        prompt: "continue after explicitly selecting Auto",
      });
      const fallbackClaim = await claimChatRun(runnerGroup, fallback.runId);
      expect(fallbackClaim.claim.modelUsageProvider).toBe(
        SEEDED_SYSTEM_DEFAULT_MODEL,
      );
      await expect(
        chat.readThreadMetadata(actor, first.threadId),
      ).resolves.toMatchObject({
        selectedModel: "okou-1.0",
      });
      await cancelChatRun(actor, fallback.runId, fallbackClaim.sandboxHeaders);
    },
    90_000,
  );

  it("keeps the enqueued model after thread and member defaults change", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await seedBuiltInModelKey("okou-1.0");
    await api.ensurePersonalSubscriptionModel(actor, {
      model: "claude-fable-5-1",
    });

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "establish the historical thread model",
      model: "claude-fable-5-1",
    });
    const queuedEventId = randomUUID();
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "continue using the model captured before defaults change",
        clientEventId: queuedEventId,
      },
      [201],
    );
    if (queued.status !== 201) {
      throw new Error("Expected the legacy-thread follow-up to queue");
    }
    expect(queued.body.runId).toBeNull();

    const historicalMessages = await chat.listThreadEvents(
      actor,
      first.threadId,
    );
    expect(userMessages(historicalMessages.events)).toContainEqual(
      expect.objectContaining({ runId: first.runId }),
    );

    await api.updateUserModelPreference(actor, "okou-1.0");
    await chat.updateUserModelPreference(actor, "okou-1.0");
    await chat.updateThreadModelSelection(actor, first.threadId, null);
    expect(
      (await chat.readThreadMetadata(actor, first.threadId)).selectedModel,
    ).toBeNull();

    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders);
    await flushWaitUntilForTest();

    const promotedMessages = await waitForThreadMessages(
      actor,
      first.threadId,
      (messages) => {
        return userMessages(messages).some((message) => {
          return (
            message.revokesEventId === queuedEventId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const promotedRunId = userMessages(promotedMessages.events).find(
      (message) => {
        return message.revokesEventId === queuedEventId;
      },
    )?.runId;
    if (!promotedRunId) {
      throw new Error("Expected the queued legacy-thread message to run");
    }

    const promotedClaim = await claimChatRun(runnerGroup, promotedRunId);
    expect(promotedClaim.claim.cliAgentType).toBe("claude-code");
    expect(claimEnvironment(promotedClaim.claim).ANTHROPIC_MODEL).toBe(
      "claude-fable-5-1",
    );
    expect(
      (await chat.readThreadMetadata(actor, first.threadId)).selectedModel,
    ).toBeNull();

    const threadEvents = await chat.requestThreadEvents(actor, {}, [200]);
    if (threadEvents.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(threadEvents.body.events).not.toContainEqual(
      expect.objectContaining({
        kind: "model_selection_updated",
        chatThreadId: first.threadId,
        selectedModel: "okou-1.0",
      }),
    );

    await cancelChatRun(actor, promotedRunId, promotedClaim.sandboxHeaders);
  }, 90_000);

  it("does not overwrite a concurrent explicit thread model selection", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await seedBuiltInModelKey("okou-1.0");
    await api.ensurePersonalSubscriptionModel(actor, {
      model: "claude-fable-5-1",
    });
    const thread = await chat.createThread(actor, {
      agentId,
      model: "claude-fable-5-1",
    });
    await api.updateUserModelPreference(actor, "okou-1.0");

    const racedEventId = randomUUID();
    const [sent, updated] = await Promise.all([
      chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: thread.id,
          prompt: "send while choosing a new sticky model",
          clientEventId: racedEventId,
        },
        [201],
      ),
      chat.requestUpdateThreadModelSelection(
        actor,
        thread.id,
        "claude-fable-5-1",
        [204],
      ),
    ]);
    expect(updated.status).toBe(204);
    expect(sent.status).toBe(201);
    const { picked: racedInput } = await waitForPickedInput(
      actor,
      thread.id,
      racedEventId,
    );
    const racedRunId = racedInput.runId;
    if (racedRunId === undefined) {
      throw new Error("Expected the concurrent send to create a run");
    }
    const racedClaim = await claimChatRun(runnerGroup, racedRunId);
    expect(["okou-1.0", "claude-fable-5-1"]).toContain(
      racedClaim.claim.modelUsageProvider,
    );
    await cancelChatRun(actor, racedRunId, racedClaim.sandboxHeaders);

    const followUp = await sendChatRun(actor, {
      agentId,
      threadId: thread.id,
      prompt: "continue on the explicit sticky model",
    });
    const followUpClaim = await claimChatRun(runnerGroup, followUp.runId);
    expect(claimEnvironment(followUpClaim.claim).ANTHROPIC_MODEL).toBe(
      "claude-fable-5-1",
    );

    const events = await chat.requestThreadEvents(actor, {}, [200]);
    if (events.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(
      events.body.events.filter((event) => {
        return (
          event.kind === "model_selection_updated" &&
          event.chatThreadId === thread.id &&
          event.selectedModel === "claude-fable-5-1"
        );
      }),
    ).toHaveLength(1);
    expect(
      events.body.events.filter((event) => {
        return (
          event.kind === "model_selection_updated" &&
          event.chatThreadId === thread.id &&
          event.selectedModel === "okou-1.0"
        );
      }).length,
    ).toBeLessThanOrEqual(1);
    await cancelChatRun(actor, followUp.runId);
  }, 90_000);

  it("passes Fast only on a supported personal Codex route", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await api.ensurePersonalSubscriptionModel(actor, {
      model: "claude-sonnet-5-5",
    });
    await configureSubscriptionPiModel(actor, {}, "gpt-6-sol");

    await preparePiResourceHandoff(actor, agentId);
    const fast = await sendChatRun(actor, {
      agentId,
      prompt: "run codex fast",
      model: "gpt-6-sol",
      runOptions: { codexServiceTier: "fast" },
    });
    expect((await readThreadProjection(actor, fast.threadId)).serviceTier).toBe(
      "priority",
    );
    const fastMessages = await waitForThreadMessages(
      actor,
      fast.threadId,
      (events) => {
        return userMessages(events).some((event) => {
          return event.runId === fast.runId;
        });
      },
    );
    const fastUserMessage = userMessages(fastMessages.events).find(
      (event): event is PromptMessage => {
        return event.eventType === "input.prompt" && event.runId === fast.runId;
      },
    )?.userMessage;
    expect(
      fastUserMessage?.parts.find((part) => {
        return part.type === "model";
      }),
    ).toStrictEqual({
      type: "model",
      selectedModel: "gpt-6-sol",
      serviceTier: "priority",
    });
    const fastClaim = await claimChatRun(runnerGroup, fast.runId);
    expect(fastClaim.claim.cliAgentType).toBe("pi");
    expect(fastClaim.claim.piModelConfig).toMatchObject({
      provider: "openai-codex",
      model: "gpt-6-sol",
      serviceTier: "fast",
    });
    await cancelChatRun(actor, fast.runId, fastClaim.sandboxHeaders);
    expect((await readThreadProjection(actor, fast.threadId)).serviceTier).toBe(
      "priority",
    );

    const invalidFastPatch = await chat.requestUpdateThreadModelSelection(
      actor,
      fast.threadId,
      "claude-sonnet-5-5",
      [400],
      { codexServiceTier: "fast" },
    );
    expectApiError(invalidFastPatch.body);
    expect(invalidFastPatch.body.error.message).toBe(
      "Fast mode is unavailable for this model route",
    );
    expect((await readThreadProjection(actor, fast.threadId)).serviceTier).toBe(
      "priority",
    );

    await chat.updateThreadModelSelection(
      actor,
      fast.threadId,
      "claude-sonnet-5-5",
      {
        codexServiceTier: null,
      },
    );
    expect(
      (await readThreadProjection(actor, fast.threadId)).serviceTier,
    ).toBeNull();
    const updatedFastThreadEvents = await chat.requestThreadEvents(
      actor,
      {},
      [200],
    );
    expect(updatedFastThreadEvents.status).toBe(200);
    if (updatedFastThreadEvents.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(updatedFastThreadEvents.body.events).toContainEqual(
      expect.objectContaining({
        kind: "model_selection_updated",
        chatThreadId: fast.threadId,
        selectedModel: "claude-sonnet-5-5",
      }),
    );
    expect(updatedFastThreadEvents.body.events).toContainEqual(
      expect.objectContaining({
        kind: "created",
        chatThreadId: fast.threadId,
        serviceTier: "priority",
      }),
    );
    expect(updatedFastThreadEvents.body.events).toContainEqual(
      expect.objectContaining({
        kind: "service_tier_updated",
        chatThreadId: fast.threadId,
        serviceTier: null,
      }),
    );

    const standard = await sendChatRun(actor, {
      agentId,
      threadId: fast.threadId,
      prompt: "run codex standard",
      model: "gpt-6.1-sol",
    });
    expect(
      (await readThreadProjection(actor, standard.threadId)).serviceTier,
    ).toBeNull();
    const standardMessages = await waitForThreadMessages(
      actor,
      standard.threadId,
      (events) => {
        return userMessages(events).some((event) => {
          return event.runId === standard.runId;
        });
      },
    );
    const standardUserMessage = userMessages(standardMessages.events).find(
      (event): event is PromptMessage => {
        return (
          event.eventType === "input.prompt" && event.runId === standard.runId
        );
      },
    )?.userMessage;
    expect(
      standardUserMessage?.parts.find((part) => {
        return part.type === "model";
      }),
    ).toStrictEqual({
      type: "model",
      selectedModel: "gpt-6.1-sol",
    });
    const { claim: standardClaim } = await claimChatRun(
      runnerGroup,
      standard.runId,
    );
    expect(standardClaim.cliAgentType).toBe("pi");
    expect(standardClaim.piModelConfig).toMatchObject({
      provider: "openai-codex",
      model: "gpt-6.1-sol",
    });
    expect(standardClaim.piModelConfig).not.toHaveProperty("serviceTier");
    await cancelChatRun(actor, standard.runId);

    const rejectedThreadId = randomUUID();
    const rejected = await chat.requestSendEvent(
      actor,
      {
        agentId,
        prompt: "Claude cannot use Codex fast mode",
        clientThreadId: rejectedThreadId,
        model: "claude-sonnet-5-5",
        runOptions: { codexServiceTier: "fast" },
      },
      [400],
    );
    expectApiError(rejected.body);
    expect(rejected.body.error.message).toBe(
      "Codex fast mode is only available for GPT 5.6 runs",
    );
    await chat.requestReadThread(actor, rejectedThreadId, [404]);
  }, 90_000);

  it.each([
    {
      model: "okou-1.0",
      preset: "@preset/okou-1-0",
    },
  ] as const)(
    "routes the fixed default built-in $model only through its OpenRouter Preset",
    async ({ model, preset }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      await seedBuiltInModelCandidateKeys(context, model);
      await preparePiResourceHandoff(actor, agentId);
      await chat.updateUserModelPreference(actor, null);

      // No thread pin or member preference: the system default applies.
      const run = await sendChatRun(actor, {
        agentId,
        prompt: "capture the managed Okou Preset route",
      });
      const { claim } = await claimChatRun(runnerGroup, run.runId);
      expect(claim.cliAgentType).toBe("pi");
      expect(claim.modelUsageProvider).toBe(model);
      expect(claim.piModelConfig).toMatchObject({
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        model: preset,
        catalogModel: model,
      });
      expect(claim.billableFirewalls).toContain(
        "model-provider:openrouter-codex",
      );
      await cancelChatRun(actor, run.runId);
    },
  );

  it("launches a free-plan okou-1.0 run on its Built-in route", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await seedBuiltInModelCandidateKeys(context, "okou-1.0");
    await preparePiResourceHandoff(actor, agentId);
    await upsertOrgPlanEntitlementFixture({
      orgId: requireOrgId(actor),
      status: "active",
      supportByok: true,
      restrictedBuiltInModels: true,
    });

    const run = await sendChatRun(actor, {
      agentId,
      model: "okou-1.0",
      prompt: "run the free plan's model",
    });
    const { claim } = await claimChatRun(runnerGroup, run.runId);
    expect(claim.modelUsageProvider).toBe("okou-1.0");
    expect(claim.piModelConfig).toMatchObject({ catalogModel: "okou-1.0" });
    expect(claim.billableFirewalls).toContain(
      "model-provider:openrouter-codex",
    );
    await cancelChatRun(actor, run.runId);
  });

  it.each(
    [false, true].map((usRoutingEnabled) => {
      return { model: "okou-1.0" as const, usRoutingEnabled };
    }),
  )(
    "routes built-in $model through global OpenRouter with US routing $usRoutingEnabled",
    async ({ model, usRoutingEnabled }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      configureNativeCliArtifact();
      await seedBuiltInModelCandidateKeys(context, model);
      await configureBuiltInPiModel(actor, "okou-1.0");
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.OpenRouterUsRouting]: usRoutingEnabled,
      });
      await preparePiResourceHandoff(actor, agentId);

      const run = await sendChatRun(actor, {
        agentId,
        model,
        prompt: "capture the managed DeepSeek route",
      });
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.OpenRouterUsRouting]: !usRoutingEnabled,
      });
      const { claim } = await claimChatRun(runnerGroup, run.runId);
      expect(claim.cliAgentType).toBe("pi");
      expect(claim.piModelConfig).toMatchObject({
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "@preset/okou-1-0",
      });
      expect(claim.billableFirewalls).toContain(
        "model-provider:openrouter-codex",
      );
      await cancelChatRun(actor, run.runId);
    },
    90_000,
  );

  it.each(["okou-1.0"] as const)(
    "fails closed for built-in %s when its required OpenRouter route is unavailable",
    async () => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      configureNativeCliArtifact();
      const model = await builtInModelWithOpenRouterCoolingDown(
        actor,
        agentId,
        runnerGroup,
      );
      await api.updateUserModelPreference(actor, model);
      const thread = await chat.createThread(actor, { agentId, model });
      // Own even an unexpectedly admitted input before checking the rejection.
      // The real thread deletion cancels its pending work before route cleanup.
      onTestFinished(async () => {
        await createChatFilesBddApi(context).deleteThread(actor, thread.id);
        await flushWaitUntilForTest();
      });
      const { picked } = await sendUntilPicked(actor, {
        agentId,
        threadId: thread.id,
        prompt: "require the managed OpenRouter DeepSeek route",
        model,
      });
      expect(picked).toMatchObject({
        eventType: "input.rejected",
        error: "model_provider_unavailable",
      });
    },
  );

  it.each([false, true])(
    "freezes the Auto endpoint and firewall with US switch %s",
    async (enabled) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const model = await configureBuiltInPiModelOnOpenRouter(
        actor,
        "okou-1.0",
      );
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.OpenRouterUsRouting]: enabled,
      });
      await preparePiResourceHandoff(actor, agentId);
      const run = await sendChatRun(actor, {
        agentId,
        model,
        prompt: "capture the fixed Auto route",
      });
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.OpenRouterUsRouting]: !enabled,
      });
      const { claim, sandboxHeaders } = await claimChatRun(
        runnerGroup,
        run.runId,
      );
      expect(claim.cliAgentType).toBe("pi");
      expect(claim.piModelConfig).toMatchObject({
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "@preset/okou-1-0",
      });
      expect(claim.billableFirewalls).toContain(
        "model-provider:openrouter-codex",
      );
      if (!claim.encryptedSecrets) {
        throw new Error("Missing managed credential bundle");
      }
      const auth = await createFirewallApi(context).requestFirewallAuth(
        sandboxHeaders,
        {
          encryptedSecrets: claim.encryptedSecrets,
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("OPENROUTER_API_KEY")}`,
          },
          secretConnectorMap: claim.secretConnectorMap ?? undefined,
          secretConnectorMetadataMap:
            claim.secretConnectorMetadataMap ?? undefined,
        },
        [200],
      );
      expect(auth.body).toMatchObject({
        resolvedSecrets: ["OPENROUTER_API_KEY"],
      });
      await cancelChatRun(actor, run.runId);
    },
    90_000,
  );
});
