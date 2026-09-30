import { assertPiLangfuseRelayContract } from "./helpers/pi-langfuse-relay";
import { randomUUID } from "node:crypto";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import {
  readQueuedLangfuseContextFixture,
  readRunLangfuseTraceEnabledFixture,
  readRunModelRuntimeRouteFixture,
} from "../../../test-fixtures/agent-runs";
import { withBuiltInModelRuntimeRouteCandidateUnavailableForTest } from "../../../test-fixtures/built-in-model-runtime-route";
import {
  acquireBddBuiltInModelKey,
  releaseBddBuiltInModelKey,
} from "../../../test-fixtures/chat-events";
import {
  setOrgModelPolicyProviderTypeFixture,
  stageUnrepairedOrgModelPolicyFixture,
} from "../../../test-fixtures/org-model-policies";
import {
  deleteOrgPlanEntitlementFixture,
  upsertOrgPlanEntitlementFixture,
} from "../../../test-fixtures/org-plan-entitlement";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { expectApiError, type ApiTestUser } from "./helpers/api-bdd";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { overwriteModelProviderSecretForTests } from "./helpers/model-provider-state";
import { seedBuiltInModelCandidateKeys } from "./helpers/runtime-state";
import {
  createChatEventsFixture,
  configureNativeCliArtifact,
  CODEX_WEB_IMAGE_UPLOAD_PROMPT_SNIPPET,
  type ChatRunSendBody,
  type PromptMessage,
  requireOrgId,
  createGptUsagePricingResolution,
  createPiUsagePricingResolution,
  claimEnvironment,
  userMessages,
  modelProviderSecretPlaceholder,
} from "./helpers/chat-events-fixture";
import { SEEDED_SYSTEM_DEFAULT_MODEL } from "./helpers/seeded-system-default";

const context = testContext({ connectorCatalog: true });
const {
  api,
  chat,
  chatCallbacks,
  misc,
  authDeviceSupport,
  entitledChatActor,
  entitledNativeChatActor,
  seedBuiltInModelKey,
  configureBuiltInPiModel,
  configureBuiltInPiModelOnOpenRouter,
  sendChatRun,
  requestSendEventRaw,
  expectNoThreadModelUpdateEvent,
  claimChatRun,
  waitForThreadMessages,
  completeChatRunOk,
  cancelChatRun,
  upsertOrgModelProvider,
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
    await api.updateOrgModelPolicies(actor, [
      {
        model: "gpt-6-astra",
        preferred: true,
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
        modelProviderId: null,
      },
    ]);

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

  it("routes model policy providers into the runner claim", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const orgId = requireOrgId(actor);
    // External model admission depends on plan capabilities, not built-in
    // model credit admission.
    await seedOrgMetadata({ orgId, tier: "pro", credits: 0 });
    const { providerId: openAiId } = await upsertOrgModelProvider(actor, {
      type: "openai-api-key",
      secret: "selected-openai-key",
    });
    await api.updateOrgModelPolicies(actor, [
      {
        model: "gpt-6-astra",
        preferred: true,
        defaultProviderType: "openai-api-key",
        credentialScope: "org",
        modelProviderId: openAiId,
      },
    ]);

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "run with the selected OpenAI provider",
      model: "gpt-6-astra",
    });

    const { claim, sandboxHeaders } = await claimChatRun(
      runnerGroup,
      run.runId,
    );
    const environment = claimEnvironment(claim);
    expect(environment.OPENAI_API_KEY).toBe(
      modelProviderSecretPlaceholder("openai-api-key", "OPENAI_API_KEY"),
    );
    // The native OpenAI Runner uses its canonical endpoint without an
    // OPENAI_BASE_URL override.
    expect(environment.OPENAI_BASE_URL).toBeUndefined();
    expect(environment.OPENAI_MODEL).toBe("gpt-6-astra");
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined();

    // The new thread's initial model is recorded on the created event. The
    // send route does not emit a model_selection_updated event.
    const thread = await chat.readThread(actor, run.threadId);
    expect(thread).not.toHaveProperty("selectedModel");
    expect(thread).not.toHaveProperty("modelProviderId");
    const threadEvents = await chat.requestThreadEvents(actor, {}, [200]);
    expect(threadEvents.status).toBe(200);
    if (threadEvents.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(threadEvents.body.events).toContainEqual(
      expect.objectContaining({
        kind: "created",
        chatThreadId: run.threadId,
        selectedModel: "gpt-6-astra",
      }),
    );
    expect(threadEvents.body.events).not.toContainEqual(
      expect.objectContaining({
        kind: "model_selection_updated",
        chatThreadId: run.threadId,
        selectedModel: "gpt-6-astra",
      }),
    );

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(run.runId, sandboxHeaders, {
      cliAgentType: "codex",
    });
    expect((await api.readRun(actor, run.runId)).status).toBe("completed");

    const followUp = await sendChatRun(actor, {
      agentId,
      threadId: run.threadId,
      prompt: "follow up without a send-time model override",
    });
    const { claim: followUpClaim } = await claimChatRun(
      runnerGroup,
      followUp.runId,
    );
    const followUpEnvironment = claimEnvironment(followUpClaim);
    expect(followUpEnvironment.OPENAI_API_KEY).toBe(
      modelProviderSecretPlaceholder("openai-api-key", "OPENAI_API_KEY"),
    );
    expect(followUpEnvironment.OPENAI_BASE_URL).toBeUndefined();
    expect(followUpEnvironment.OPENAI_MODEL).toBe("gpt-6-astra");
    await cancelChatRun(actor, followUp.runId);

    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        preferred: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);
    const insufficientBuiltIn = await sendUntilPicked(actor, {
      agentId,
      prompt: "reject built-in admission without spendable credits",
      model: "claude-sonnet-5",
    });
    expect(insufficientBuiltIn.picked).toMatchObject({
      eventType: "input.rejected",
      error: "insufficient_credits",
    });

    // Restore spendable credits before exercising the built-in branch.
    await seedOrgMetadata({ orgId, tier: "pro", credits: 1_000_000 });

    // A built-in provider pin in an entitled org passes the spendable-credits
    // admission. The pick's outcome past admission is race-dependent on the
    // shared database: a model-provider-unavailable rejection when no
    // built-in model key exists (no public provisioning surface), a run when
    // another suite's alive legacy test has seeded a global built-in model
    // key. Both prove the credits-ok admission arm.
    await setOrgModelPolicyProviderTypeFixture({
      orgId,
      model: "claude-sonnet-5",
      defaultProviderType: "built-in",
    });
    const builtIn = await sendUntilPicked(actor, {
      agentId,
      prompt: "built-in admission with spendable credits",
      model: "claude-sonnet-5",
    });
    if (builtIn.picked.eventType === "input.rejected") {
      expect(builtIn.picked.error).toBe("model_provider_unavailable");
    } else {
      const runId = builtIn.picked.runId;
      if (runId === undefined) {
        throw new Error("Expected the picked built-in input to carry its run");
      }
      await api.requestCancelRun(actor, runId, [200]);
    }
  }, 90_000);

  it("queues an existing-thread input with its model until the active run releases the thread", async () => {
    const { actor, agentId, providerId, runnerGroup } =
      await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-fable-5-1",
        preferred: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

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

  it("routes from the authoritative policies seeded by the same send", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await seedBuiltInModelKey(SEEDED_SYSTEM_DEFAULT_MODEL);
    await stageUnrepairedOrgModelPolicyFixture({
      orgId: requireOrgId(actor),
      state: "unseeded",
    });
    await preparePiResourceHandoff(actor, agentId);

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "route from the repaired policy snapshot",
    });
    await expect(
      chat.readThreadMetadata(actor, run.threadId),
    ).resolves.toMatchObject({
      selectedModel: SEEDED_SYSTEM_DEFAULT_MODEL,
    });
    const { claim } = await claimChatRun(runnerGroup, run.runId);
    expect(claim.cliAgentType).toBe("pi");
    expect(claim.piModelConfig).toMatchObject({
      catalogModel: SEEDED_SYSTEM_DEFAULT_MODEL,
    });
    await cancelChatRun(actor, run.runId);
  }, 90_000);

  it("preserves persisted external model plan-state outcomes", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const orgId = requireOrgId(actor);
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-fable-5-1",
        preferred: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

    const initial = await sendChatRun(actor, {
      agentId,
      prompt: "establish external plan capability admission",
      model: "claude-fable-5-1",
    });
    const initialClaim = await claimChatRun(runnerGroup, initial.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(initial.runId, initialClaim.sandboxHeaders);
    await flushWaitUntilForTest();

    const activeFollowUp = await sendChatRun(actor, {
      agentId,
      threadId: initial.threadId,
      prompt: "continue with active plan capabilities",
    });
    await cancelChatRun(actor, activeFollowUp.runId);
    // The cancel released the never-started run's slot; let its hand-off
    // finish before the next send so the two cannot both admit that send.
    await flushWaitUntilForTest();

    await upsertOrgPlanEntitlementFixture({
      orgId,
      status: "suspended",
      supportByok: true,
      restrictedBuiltInModels: false,
    });
    const suspended = await sendUntilPicked(actor, {
      agentId,
      threadId: initial.threadId,
      prompt: "reject suspended persisted admission",
    });
    expect(suspended.picked).toMatchObject({
      eventType: "input.rejected",
      error: "insufficient_credits",
    });

    // Missing canonical plan authority is an invariant failure during model
    // selection. The HTTP request fails before appending an input or a run.
    const missingThread = await chat.createThread(actor, {
      agentId,
      model: "claude-fable-5-1",
    });
    await deleteOrgPlanEntitlementFixture(orgId);
    const missingEventId = randomUUID();
    const prompt = "reject missing persisted plan authority";
    const missing = await requestSendEventRaw(actor, {
      agentId,
      threadId: missingThread.id,
      prompt,
      clientEventId: missingEventId,
      userMessage: { version: 1, parts: [{ type: "text", text: prompt }] },
      hasTextContent: true,
    });
    expect(missing).toStrictEqual({
      status: 500,
      body: { error: "Internal server error" },
    });
    await flushWaitUntilForTest();
    expect(
      (await chat.listThreadEvents(actor, missingThread.id)).events,
    ).toStrictEqual([]);

    await upsertOrgPlanEntitlementFixture({
      orgId,
      status: "active",
      supportByok: true,
      restrictedBuiltInModels: false,
    });
    const busy = await sendChatRun(actor, {
      agentId,
      threadId: initial.threadId,
      prompt: "hold the thread while the next input captures its model",
    });
    const queuedEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: initial.threadId,
        clientEventId: queuedEventId,
        prompt: "reject a model that becomes BYOK-disabled before pick",
      },
      [201],
    );
    await flushWaitUntilForTest();
    await upsertOrgPlanEntitlementFixture({
      orgId,
      status: "active",
      supportByok: false,
      restrictedBuiltInModels: false,
    });
    // Pick validates the model captured before the plan changed. It rejects
    // that model rather than selecting the newly available workspace default.
    await cancelChatRun(actor, busy.runId);
    const byokDisabled = await waitForPickedInput(
      actor,
      initial.threadId,
      queuedEventId,
    );
    expect(byokDisabled.picked).toMatchObject({
      eventType: "input.rejected",
      error: "insufficient_credits",
    });

    await upsertOrgPlanEntitlementFixture({
      orgId,
      status: "active",
      supportByok: true,
      restrictedBuiltInModels: false,
    });
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-fable-5-1",
        preferred: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);
    await upsertOrgPlanEntitlementFixture({
      orgId,
      status: "active",
      supportByok: true,
      restrictedBuiltInModels: true,
    });
    // A free plan's own API key is not a plan entitlement: the stored BYOK
    // policy stays listed, but the pick rejects it rather than borrowing
    // another route.
    const restrictedByok = await sendUntilPicked(actor, {
      agentId,
      threadId: initial.threadId,
      prompt: "free plans do not run models on their own API keys",
    });
    expect(restrictedByok.picked).toMatchObject({
      eventType: "input.rejected",
    });
    const restrictedPolicies = await misc.listModelPolicies(actor);
    expect(restrictedPolicies.policies).toContainEqual(
      expect.objectContaining({
        model: "claude-fable-5-1",
        defaultProviderType: "anthropic-api-key",
        modelProviderId: providerId,
      }),
    );
  }, 90_000);

  it.each(["deleted", "wrong-provider-key"] as const)(
    "rejects V4.1 %s credentials without borrowing another route",
    async (boundary) => {
      const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
      mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
      const anchor = await sendChatRun(actor, {
        agentId,
        prompt: "hold capacity",
        model: "claude-fable-5-1",
      });
      const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);
      configureNativeCliArtifact();
      const { providerId } = await upsertOrgModelProvider(actor, {
        type: "openrouter-codex",
        secret:
          boundary === "deleted"
            ? "selected-or-key"
            : "sk-ant-oat01-wrong-provider",
      });
      await upsertOrgModelProvider(actor, {
        type: "deepseek",
        secret: "unrelated-deepseek-key",
      });
      await api.updateOrgModelPolicies(actor, [
        {
          model: "deepseek-v4.1-flash",
          preferred: true,
          defaultProviderType: "openrouter-codex",
          credentialScope: "org",
          modelProviderId: providerId,
        },
      ]);

      const clientEventId = randomUUID();
      const sent = await chat.requestSendEvent(
        actor,
        {
          agentId,
          model: "deepseek-v4.1-flash",
          clientEventId,
          prompt: "Reject unavailable selected credentials",
        },
        [201],
      );
      if (sent.status !== 201) {
        throw new Error("Expected the V4.1 send to be accepted");
      }
      await flushWaitUntilForTest();
      if (boundary === "deleted") {
        await misc.deleteOrgModelProvider(actor, "openrouter-codex", [204]);
      }
      await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
      const { picked } = await waitForPickedInput(
        actor,
        sent.body.threadId,
        clientEventId,
      );
      await flushWaitUntilForTest();
      // Deletion before pick invalidates the public policy pin; a wrong
      // provider key is also an invalid request, not a substitute route.
      expect(picked).toMatchObject({
        eventType: "input.rejected",
        error: "bad_request",
      });
    },
    90_000,
  );

  it.each(["old-cli", "mutable-cli", "effort"] as const)(
    "rejects V4.1 %s at admission",
    async (boundary) => {
      const { actor, agentId } = await entitledChatActor();
      await configureBuiltInPiModel(actor, "deepseek-v4.1-flash");

      if (boundary !== "effort") {
        mockEnv(
          "CLI_PKG_URL",
          boundary === "old-cli"
            ? `https://static.okou.io/okou-cli/${"b".repeat(40)}/package.tgz`
            : "https://static.okou.io/okou-cli/latest/package.tgz",
        );
      }
      if (boundary === "effort") {
        // An unsupported effort is still refused by the send itself.
        const response = await chat.requestSendEvent(
          actor,
          {
            agentId,
            model: "deepseek-v4.1-flash",
            prompt: "Reject incompatible admission",
            clientEventId: randomUUID(),
            runOptions: { reasoningEffort: "high" },
          },
          [400],
        );
        expect(response.status).toBe(400);
      } else {
        // The CLI artifact is checked when the pick creates the run.
        const { picked } = await sendUntilPicked(actor, {
          agentId,
          model: "deepseek-v4.1-flash",
          prompt: "Reject incompatible admission",
        });
        expect(picked).toMatchObject({
          eventType: "input.rejected",
          error: "bad_request",
        });
      }
      await flushWaitUntilForTest();
    },
    90_000,
  );

  it("exposes the owner's run trace URL after tracing is disabled", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = requireOrgId(actor);
    await configureBuiltInPiModel(actor, "gpt-6-luna");
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
      model: "gpt-6-luna",
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
      model: "gpt-6-luna",
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
    await configureBuiltInPiModel(actor, "gpt-6-luna");
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
      model: "gpt-6-luna",
    });
    await flushWaitUntilForTest();
    await expect(
      readRunLangfuseTraceEnabledFixture(run.runId),
    ).resolves.toBeTruthy();
    const queuedContext = await readQueuedLangfuseContextFixture({
      runId: run.runId,
      userId: actor.userId,
      orgId,
    });
    expect(queuedContext.platformEnvironment).toMatchObject({
      OKOU_PI_LANGFUSE_DEBUG_ENABLED: "true",
      LANGFUSE_TRACING_ENABLED: "true",
    });
    expect(queuedContext.platformEnvironment).not.toHaveProperty(
      "LANGFUSE_PUBLIC_KEY",
    );
    expect(queuedContext.platformEnvironment).not.toHaveProperty(
      "LANGFUSE_SECRET_KEY",
    );
    expect(queuedContext.encryptedSecrets ?? {}).not.toHaveProperty(
      "LANGFUSE_PUBLIC_KEY",
    );
    expect(queuedContext.encryptedSecrets ?? {}).not.toHaveProperty(
      "LANGFUSE_SECRET_KEY",
    );

    const claimed = await claimChatRun(runnerGroup, run.runId);
    expect(claimed.claim.cliAgentType).toBe("pi");
    expect(claimed.claim.platformEnvironment).not.toHaveProperty(
      "LANGFUSE_PUBLIC_KEY",
    );
    expect(claimed.claim.platformEnvironment).not.toHaveProperty(
      "LANGFUSE_SECRET_KEY",
    );
    expect(claimed.claim.secretValues).not.toContain(
      "sk-lf-bdd-trace-admission",
    );
    await expect(
      readRunLangfuseTraceEnabledFixture(run.runId),
    ).resolves.toBeTruthy();
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
      model: "gpt-6-luna",
    });
    await flushWaitUntilForTest();
    const untracedClaim = await claimChatRun(runnerGroup, untraced.runId);
    await relay.expectAdmissionDenied(
      untraced.runId,
      untracedClaim.claim.platformEnvironment.OKOU_TOKEN,
    );
    await cancelChatRun(actor, untraced.runId, untracedClaim.sandboxHeaders);
  });

  it("reuses a Pi session across DeepSeek V4 model switches", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    configureNativeCliArtifact();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const { providerId } = await upsertOrgModelProvider(actor, {
      type: "deepseek",
      secret: "deepseek-family-session-key",
    });
    const { providerId: openrouterProviderId } = await upsertOrgModelProvider(
      actor,
      {
        type: "openrouter-codex",
        secret: "deepseek-family-openrouter-key",
      },
    );
    await api.updateOrgModelPolicies(actor, [
      {
        model: "deepseek-v4-flash",
        preferred: true,
        defaultProviderType: "deepseek",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "deepseek-v4.1-flash",
        defaultProviderType: "openrouter-codex",
        credentialScope: "org",
        modelProviderId: openrouterProviderId,
      },
    ]);

    await publishPendingPiInstructions(actor, agentId);
    mockPiResourceArchiveDownloads(true);
    const checkpointObjects = mockPiCheckpointObjectStore();
    const usagePricingResolution =
      await createPiUsagePricingResolution("deepseek-v4-flash");
    const firstPrompt = "start the DeepSeek V4 family session";
    const first = await sendChatRun(actor, {
      agentId,
      prompt: firstPrompt,
      model: "deepseek-v4-flash",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    expect(firstClaim.claim.cliAgentType).toBe("pi");
    expect(firstClaim.claim.piModelConfig).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-flash",
    });
    await completeSandboxFirstPiRun({
      actor,
      run: first,
      claim: firstClaim,
      checkpointObjects,
      prompt: firstPrompt,
      answer: "first DeepSeek Pi response",
      responsesModel: { provider: "deepseek", model: "deepseek-v4-flash" },
      usagePricingResolution,
    });

    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue with DeepSeek V4.1 Flash",
      model: "deepseek-v4.1-flash",
    });
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    expect(secondClaim.claim.cliAgentType).toBe("pi");
    expect(secondClaim.claim.piSessionId).toBe(first.threadId);
    expect(secondClaim.claim.piModelConfig).toMatchObject({
      provider: "openrouter",
      model: "deepseek/deepseek-v4.1-flash",
    });
    await cancelChatRun(actor, second.runId);
  });

  it("captures the fixed default without changing a thread whose model was removed", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-fable-5-1",
        preferred: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

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
    await seedBuiltInModelKey("gpt-6-astra");
    // The member preference does not replace an unavailable thread model.
    await api.updateOrgModelPolicies(actor, [
      {
        model: "gpt-6-astra",
        preferred: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);
    await preparePiResourceHandoff(actor, agentId);

    const fallback = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue through the fixed default",
    });
    const fallbackClaim = await claimChatRun(runnerGroup, fallback.runId);
    expect(fallbackClaim.claim.modelUsageProvider).toBe(
      SEEDED_SYSTEM_DEFAULT_MODEL,
    );
    await expect(
      chat.readThreadMetadata(actor, first.threadId),
    ).resolves.toMatchObject({
      selectedModel: "claude-fable-5-1",
    });
    await cancelChatRun(actor, fallback.runId, fallbackClaim.sandboxHeaders);
  }, 90_000);

  it("keeps the enqueued model after thread and member defaults change", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await seedBuiltInModelKey("gpt-6-astra");
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-fable-5-1",
        preferred: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "gpt-6-astra",
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);

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

    await api.updateOrgModelPolicies(actor, [
      {
        model: "gpt-6-astra",
        preferred: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
      {
        model: "claude-fable-5-1",
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);
    await chat.updateUserModelPreference(actor, "gpt-6-astra");
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
        selectedModel: "gpt-6-astra",
      }),
    );

    await cancelChatRun(actor, promotedRunId, promotedClaim.sandboxHeaders);
  }, 90_000);

  it("does not overwrite a concurrent explicit thread model selection", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await seedBuiltInModelKey("gpt-6-astra");
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-fable-5-1",
        preferred: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);
    const thread = await chat.createThread(actor, {
      agentId,
      model: "claude-fable-5-1",
    });
    await api.updateOrgModelPolicies(actor, [
      {
        model: "gpt-6-astra",
        preferred: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
      {
        model: "claude-fable-5-1",
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

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
    const racedEnvironment = claimEnvironment(racedClaim.claim);
    expect(["gpt-6-astra", "claude-fable-5-1"]).toContain(
      racedEnvironment.OPENAI_MODEL ?? racedEnvironment.ANTHROPIC_MODEL,
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
          event.selectedModel === "gpt-6-astra"
        );
      }).length,
    ).toBeLessThanOrEqual(1);
    await cancelChatRun(actor, followUp.runId);
  }, 90_000);

  it("passes Codex fast mode only for GPT 5.6 sends", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await seedBuiltInModelKey("gpt-5.6-sol");

    await api.updateOrgModelPolicies(actor, [
      {
        model: "gpt-5.6-sol",
        preferred: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
      {
        model: "gpt-5.6-luna",
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
      {
        model: "claude-sonnet-5",
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);

    await preparePiResourceHandoff(actor, agentId);
    const fast = await sendChatRun(actor, {
      agentId,
      prompt: "run codex fast",
      model: "gpt-5.6-sol",
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
      selectedModel: "gpt-5.6-sol",
      serviceTier: "priority",
    });
    const fastClaim = await claimChatRun(runnerGroup, fast.runId);
    expect(fastClaim.claim.cliAgentType).toBe("pi");
    expect(fastClaim.claim.piModelConfig).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-sol",
      serviceTier: "priority",
    });
    await cancelChatRun(actor, fast.runId, fastClaim.sandboxHeaders);
    expect((await readThreadProjection(actor, fast.threadId)).serviceTier).toBe(
      "priority",
    );

    const invalidFastPatch = await chat.requestUpdateThreadModelSelection(
      actor,
      fast.threadId,
      "claude-sonnet-5",
      [400],
      { codexServiceTier: "fast" },
    );
    expectApiError(invalidFastPatch.body);
    expect(invalidFastPatch.body.error.message).toBe(
      "Codex fast mode is only available for GPT 5.6 runs",
    );
    expect((await readThreadProjection(actor, fast.threadId)).serviceTier).toBe(
      "priority",
    );

    await chat.updateThreadModelSelection(
      actor,
      fast.threadId,
      "claude-sonnet-5",
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
        selectedModel: "claude-sonnet-5",
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
      model: "gpt-5.6-luna",
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
      selectedModel: "gpt-5.6-luna",
    });
    const { claim: standardClaim } = await claimChatRun(
      runnerGroup,
      standard.runId,
    );
    expect(standardClaim.cliAgentType).toBe("pi");
    expect(standardClaim.piModelConfig).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-luna",
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
        model: "claude-sonnet-5",
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

  it("preserves persisted fast mode after the current provider route changes", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected entitled chat actor to have an org");
    }
    await misc.upsertPersonalModelProvider(
      actor,
      {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        secrets: { CODEX_AUTH_JSON: codexAuthJson() },
      },
      [200, 201],
    );
    const { providerId: openAiProviderId } = await upsertOrgModelProvider(
      actor,
      {
        type: "openai-api-key",
        secret: "rerouted-openai-key",
      },
    );
    await api.updateOrgModelPolicies(actor, [
      {
        model: "gpt-5.6-luna",
        preferred: true,
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
        modelProviderId: null,
      },
    ]);

    await publishPendingPiInstructions(actor, agentId);
    mockPiResourceArchiveDownloads(true);
    const checkpointObjects = mockPiCheckpointObjectStore();
    const usagePricingResolution = await createGptUsagePricingResolution();
    const firstPrompt = "start fast before the provider route changes";
    const first = await sendChatRun(actor, {
      agentId,
      prompt: firstPrompt,
      model: "gpt-5.6-luna",
      runOptions: { codexServiceTier: "fast" },
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    expect(firstClaim.claim.piModelConfig).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      serviceTier: "fast",
      credentialBindings: [
        expect.objectContaining({ secretName: "CHATGPT_ACCESS_TOKEN" }),
        expect.objectContaining({ secretName: "CHATGPT_ACCOUNT_ID" }),
      ],
    });
    await completeSandboxFirstPiRun({
      actor,
      run: first,
      claim: firstClaim,
      checkpointObjects,
      prompt: firstPrompt,
      answer: "first Pi fast response",
      responsesModel: { provider: "openai-codex", model: "gpt-5.6-luna" },
      usagePricingResolution,
    });

    // A connected personal Codex subscription takes priority over an
    // organization API route for the same model.
    await misc.deletePersonalModelProvider(actor, "codex-oauth-token", [204]);
    await api.updateOrgModelPolicies(actor, [
      {
        model: "gpt-5.6-luna",
        preferred: true,
        defaultProviderType: "openai-api-key",
        credentialScope: "org",
        modelProviderId: openAiProviderId,
      },
    ]);
    const followUp = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue from a client that still has fast cached",
      runOptions: { codexServiceTier: "fast" },
    });
    const followUpClaim = await claimChatRun(runnerGroup, followUp.runId);
    expect(followUpClaim.claim.cliAgentType).toBe("pi");
    expect(followUpClaim.claim.piModelConfig).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-luna",
      credentialBindings: [
        expect.objectContaining({ secretName: "OPENAI_API_KEY" }),
      ],
      serviceTier: "priority",
    });
    expect(
      (await readThreadProjection(actor, first.threadId)).serviceTier,
    ).toBe("priority");
    await expectNoThreadModelUpdateEvent(actor, first.threadId, "gpt-5.6-luna");
    await cancelChatRun(actor, followUp.runId);
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
    (["deepseek-v4.1-flash", "deepseek-v4-flash"] as const).flatMap((model) => {
      return [false, true].flatMap((alternativeRoutingEnabled) => {
        return [false, true].map((usRoutingEnabled) => {
          return { model, alternativeRoutingEnabled, usRoutingEnabled };
        });
      });
    }),
  )(
    "routes built-in $model with alternative routing $alternativeRoutingEnabled and US routing $usRoutingEnabled",
    async ({ model, alternativeRoutingEnabled, usRoutingEnabled }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      if (model === "deepseek-v4.1-flash") {
        configureNativeCliArtifact();
      }
      await seedBuiltInModelCandidateKeys(context, model);
      await api.updateOrgModelPolicies(actor, [
        {
          model,
          preferred: true,
          defaultProviderType: "built-in",
          credentialScope: "org",
          modelProviderId: null,
        },
      ]);
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.DeepSeekAlternativeRouting]:
          alternativeRoutingEnabled,
        [FeatureSwitchKey.OpenRouterUsRouting]: usRoutingEnabled,
      });
      await preparePiResourceHandoff(actor, agentId);

      const run = await sendChatRun(actor, {
        agentId,
        model,
        prompt: "capture the managed DeepSeek route",
      });
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.DeepSeekAlternativeRouting]:
          !alternativeRoutingEnabled,
        [FeatureSwitchKey.OpenRouterUsRouting]: !usRoutingEnabled,
      });
      const { claim } = await claimChatRun(runnerGroup, run.runId);
      const expectedProvider = alternativeRoutingEnabled
        ? "openrouter-codex"
        : "deepseek";
      const expectedModel = alternativeRoutingEnabled
        ? `deepseek/${model}`
        : model === "deepseek-v4.1-flash"
          ? "deepseek-flash"
          : model;
      expect(claim.cliAgentType).toBe("pi");
      expect(claim.piModelConfig).toMatchObject({
        provider: alternativeRoutingEnabled ? "openrouter" : "deepseek",
        baseUrl: alternativeRoutingEnabled
          ? "https://openrouter.ai/api/v1"
          : "https://api.deepseek.com/",
        model: expectedModel,
      });
      expect(claim.billableFirewalls).toContain(
        `model-provider:${expectedProvider}`,
      );
      expect(claim.billableFirewalls).not.toContain(
        `model-provider:${alternativeRoutingEnabled ? "deepseek" : "openrouter-codex"}`,
      );
      await cancelChatRun(actor, run.runId);
    },
    90_000,
  );

  it.each(["deepseek-v4.1-flash", "deepseek-v4-flash"] as const)(
    "uses direct built-in %s when the OpenRouter fallback is unavailable",
    async (model) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      if (model === "deepseek-v4.1-flash") {
        configureNativeCliArtifact();
      }
      // Other tests can own the global OpenRouter key. Keep it present and
      // scope only its candidate's unavailability to this request.
      await seedBuiltInModelCandidateKeys(context, model);
      await api.updateOrgModelPolicies(actor, [
        {
          model,
          preferred: true,
          defaultProviderType: "built-in",
          credentialScope: "org",
          modelProviderId: null,
        },
      ]);
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.DeepSeekAlternativeRouting]: false,
        [FeatureSwitchKey.OpenRouterUsRouting]: true,
      });
      await preparePiResourceHandoff(actor, agentId);

      const run = await withBuiltInModelRuntimeRouteCandidateUnavailableForTest(
        {
          selectedModel: model,
          providerType: "openrouter-codex",
          upstreamModel: `deepseek/${model}`,
        },
        async () => {
          return await sendChatRun(actor, {
            agentId,
            prompt: "retain the managed DeepSeek direct priority",
            model,
          });
        },
      );
      const { claim } = await claimChatRun(runnerGroup, run.runId);
      expect(claim.cliAgentType).toBe("pi");
      expect(claim.piModelConfig).toMatchObject({
        provider: "deepseek",
        baseUrl: "https://api.deepseek.com/",
        model: model === "deepseek-v4.1-flash" ? "deepseek-flash" : model,
      });
      await cancelChatRun(actor, run.runId);
    },
  );

  it.each(["deepseek-v4.1-flash", "deepseek-v4-flash"] as const)(
    "fails closed for built-in %s when its required OpenRouter route is unavailable",
    async (model) => {
      const { actor, agentId } = await entitledChatActor();
      if (model === "deepseek-v4.1-flash") {
        configureNativeCliArtifact();
      }
      await seedBuiltInModelCandidateKeys(context, model);
      await api.updateOrgModelPolicies(actor, [
        {
          model,
          preferred: true,
          defaultProviderType: "built-in",
          credentialScope: "org",
          modelProviderId: null,
        },
      ]);
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.DeepSeekAlternativeRouting]: true,
        [FeatureSwitchKey.OpenRouterUsRouting]: false,
      });

      const { picked } =
        await withBuiltInModelRuntimeRouteCandidateUnavailableForTest(
          {
            selectedModel: model,
            providerType: "openrouter-codex",
            upstreamModel: `deepseek/${model}`,
          },
          async () => {
            return await sendUntilPicked(actor, {
              agentId,
              prompt: "require the managed OpenRouter DeepSeek route",
              model,
            });
          },
        );
      expect(picked).toMatchObject({
        eventType: "input.rejected",
        error: "model_provider_unavailable",
      });
    },
  );

  it.each(
    (
      [
        "claude-sonnet-5",
        "claude-fable-5-1",
        "gpt-5.6-luna",
        "deepseek-v4-flash",
      ] as const
    ).flatMap((model) => {
      const switchValues =
        model === "claude-fable-5-1" || model === "deepseek-v4-flash"
          ? [true]
          : [false, true];
      return switchValues.map((enabled) => {
        return { model, enabled };
      });
    }),
  )(
    "freezes managed $model endpoint and firewall with US switch $enabled",
    async ({ model, enabled }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const withRoute = await configureBuiltInPiModelOnOpenRouter(actor, model);
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.OpenRouterUsRouting]: enabled,
      });
      await preparePiResourceHandoff(actor, agentId);
      const run = await withRoute(() => {
        return sendChatRun(actor, {
          agentId,
          model,
          prompt: "capture the managed regional route",
        });
      });
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.OpenRouterUsRouting]: !enabled,
      });
      const { claim, sandboxHeaders } = await claimChatRun(
        runnerGroup,
        run.runId,
      );
      const messages = model.startsWith("claude");
      const usesUs =
        enabled &&
        model !== "claude-fable-5-1" &&
        !model.startsWith("deepseek");
      const baseUrl = `https://${usesUs ? "us." : ""}openrouter.ai/api${messages ? "" : "/v1"}`;
      if (model === "claude-fable-5-1") {
        expect(claim.cliAgentType).toBe("claude-code");
        expect(claimEnvironment(claim).ANTHROPIC_BASE_URL).toBe(baseUrl);
      } else {
        expect(claim.cliAgentType).toBe("pi");
        expect(claim.piModelConfig).toMatchObject({
          provider: messages ? "anthropic" : "openrouter",
          baseUrl,
        });
      }
      const name = `model-provider:${messages ? "openrouter-api-key" : "openrouter-codex"}`;
      expect(claim.billableFirewalls).toContain(name);
      if (usesUs) {
        expect(claim.firewalls).toContainEqual(
          expect.objectContaining({
            kind: "inline",
            firewall: expect.objectContaining({
              name,
              apis: expect.arrayContaining([
                expect.objectContaining({
                  base: `${baseUrl}${messages ? "/v1/messages" : "/responses"}`,
                  auth: {
                    headers: {
                      Authorization: `Bearer ${secretTemplate("OPENROUTER_API_KEY")}`,
                    },
                  },
                }),
              ]),
            }),
          }),
        );
      }
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

  it("routes OpenRouter provider pins through runtime model aliases and firewall auth", async () => {
    const fw = createFirewallApi(context);
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await authDeviceSupport.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.OpenRouterUsRouting]: true,
    });
    const { providerId } = await upsertOrgModelProvider(actor, {
      type: "openrouter-api-key",
      secret: "test-openrouter-key",
    });
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-opus-5",
        preferred: true,
        defaultProviderType: "openrouter-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

    await preparePiResourceHandoff(actor, agentId);
    const run = await sendChatRun(actor, {
      agentId,
      prompt: "run with the selected openrouter provider",
      model: "claude-opus-5",
    });

    const { claim, sandboxHeaders } = await claimChatRun(
      runnerGroup,
      run.runId,
    );
    expect(claim.cliAgentType).toBe("pi");
    expect(claim.piModelConfig).toMatchObject({
      schemaVersion: 4,
      route: "openrouter-api-key",
      provider: "anthropic",
      baseUrl: "https://openrouter.ai/api",
      model: "anthropic/claude-opus-5",
      credentialBindings: [
        expect.objectContaining({ secretName: "OPENROUTER_API_KEY" }),
      ],
    });

    if (!claim.encryptedSecrets) {
      throw new Error("Expected OpenRouter claim to carry encrypted secrets");
    }
    const resolved = await fw.requestFirewallAuth(
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
    if (resolved.status !== 200) {
      throw new Error("Expected OpenRouter firewall auth to resolve");
    }
    expect(resolved.body.headers.Authorization).toBe(
      "Bearer test-openrouter-key",
    );
    expect(resolved.body.resolvedSecrets).toStrictEqual(["OPENROUTER_API_KEY"]);

    const thread = await chat.readThread(actor, run.threadId);
    expect(thread).not.toHaveProperty("selectedModel");
    expect(thread).not.toHaveProperty("modelProviderId");
    const threadEvents = await chat.requestThreadEvents(actor, {}, [200]);
    expect(threadEvents.status).toBe(200);
    if (threadEvents.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(threadEvents.body.events).toContainEqual(
      expect.objectContaining({
        kind: "created",
        chatThreadId: run.threadId,
        selectedModel: "claude-opus-5",
      }),
    );

    await api.requestCancelRun(actor, run.runId, [200]);
  }, 90_000);

  it("runs built-in DeepSeek through the native Pi API credential", async () => {
    const fw = createFirewallApi(context);
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const keyFixtureId = randomUUID();
    const requestedApiKey = `built-in-key-bdd-dev-seed-${keyFixtureId}`;

    // Keep a second DeepSeek fixture owner alive to cover vendor-unique row
    // arbitration instead of relying on another test file's scheduling.
    await seedBuiltInModelKey("deepseek-v4-flash");
    let runId: string | null = null;
    onTestFinished(async () => {
      await Promise.all([
        releaseBddBuiltInModelKey({ fixtureId: keyFixtureId }),
        ...(runId ? [api.requestCancelRun(actor, runId, [200])] : []),
      ]);
    });
    const selectedApiKey = await acquireBddBuiltInModelKey({
      fixtureId: keyFixtureId,
      vendor: "deepseek",
      apiKey: requestedApiKey,
    });

    await api.updateOrgModelPolicies(actor, [
      {
        model: "deepseek-v4-flash",
        preferred: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();
    const run = await sendChatRun(actor, {
      agentId,
      prompt: "run with the selected built-in DeepSeek provider",
      model: "deepseek-v4-flash",
    });
    runId = run.runId;

    const { claim, sandboxHeaders } = await claimChatRun(
      runnerGroup,
      run.runId,
    );
    expect(claim.cliAgentType).toBe("pi");
    expect(claim.piModelConfig).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-flash",
    });
    if (!claim.encryptedSecrets) {
      throw new Error("Expected the built-in claim to carry encrypted secrets");
    }
    const resolved = await fw.requestFirewallAuth(
      sandboxHeaders,
      {
        encryptedSecrets: claim.encryptedSecrets,
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("DEEPSEEK_API_KEY")}`,
        },
      },
      [200],
    );
    if (resolved.status !== 200) {
      throw new Error("Expected built-in DeepSeek firewall auth to resolve");
    }
    expect(
      resolved.body.headers.Authorization === `Bearer ${selectedApiKey}`,
    ).toBeTruthy();
  }, 90_000);

  it("selects a built-in model key from a canonical policy without switching the run writer", async () => {
    const fw = createFirewallApi(context);
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const keyFixtureId = randomUUID();
    const requestedApiKey = `built-in-key-bdd-dev-seed-${keyFixtureId}`;
    await seedBuiltInModelKey("claude-opus-5");

    let runId: string | null = null;

    onTestFinished(async () => {
      await Promise.all([
        releaseBddBuiltInModelKey({ fixtureId: keyFixtureId }),
        ...(runId ? [api.requestCancelRun(actor, runId, [200])] : []),
      ]);
    });

    const acquiredApiKey = await acquireBddBuiltInModelKey({
      fixtureId: keyFixtureId,
      vendor: "anthropic",
      apiKey: requestedApiKey,
    });
    expect(acquiredApiKey === requestedApiKey).toBeFalsy();

    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-opus-5",
        preferred: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);
    if (!actor.orgId) {
      throw new Error("Expected the built-in model actor to have an org");
    }
    await setOrgModelPolicyProviderTypeFixture({
      orgId: actor.orgId,
      model: "claude-opus-5",
      defaultProviderType: "built-in",
    });

    await preparePiResourceHandoff(actor, agentId);
    const run = await sendChatRun(actor, {
      agentId,
      prompt: "run with the selected built-in provider",
      model: "claude-opus-5",
    });
    runId = run.runId;
    await expect(
      readRunModelRuntimeRouteFixture(run.runId),
    ).resolves.toMatchObject({
      modelProvider: "built-in",
      selectedModel: "claude-opus-5",
    });

    const { claim, sandboxHeaders } = await claimChatRun(
      runnerGroup,
      run.runId,
    );
    expect(claim.cliAgentType).toBe("pi");
    expect(claim.piModelConfig).toMatchObject({
      schemaVersion: 4,
      route: "anthropic-api-key",
      provider: "anthropic",
      billingOwner: "builtin",
      model: "claude-opus-5",
      credentialBindings: [
        expect.objectContaining({ secretName: "ANTHROPIC_API_KEY" }),
      ],
    });

    if (!claim.encryptedSecrets) {
      throw new Error("Expected the built-in claim to carry encrypted secrets");
    }
    const resolved = await fw.requestFirewallAuth(
      sandboxHeaders,
      {
        encryptedSecrets: claim.encryptedSecrets,
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("ANTHROPIC_API_KEY")}`,
        },
      },
      [200],
    );
    if (resolved.status !== 200) {
      throw new Error("Expected built-in firewall auth to resolve");
    }
    const authorization = resolved.body.headers.Authorization;
    expect(authorization?.startsWith("Bearer ")).toBeTruthy();
    expect(authorization?.length ?? 0).toBeGreaterThan("Bearer ".length);
    expect(authorization === `Bearer ${acquiredApiKey}`).toBeTruthy();
  }, 90_000);

  it("rejects legacy blank OpenRouter provider secrets before run admission", async () => {
    const { actor, agentId } = await entitledChatActor();
    const { providerId } = await upsertOrgModelProvider(actor, {
      type: "openrouter-api-key",
      secret: "test-openrouter-key",
    });
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-opus-5",
        preferred: true,
        defaultProviderType: "openrouter-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);
    await overwriteModelProviderSecretForTests(context.signal, {
      providerId,
      secretName: "OPENROUTER_API_KEY",
      secret: "   ",
    });

    // A blank legacy credential is no longer claimable: the pick rejects the
    // input before a Sandbox can receive its secret bundle.
    const { picked } = await sendUntilPicked(actor, {
      agentId,
      prompt: "run with a legacy blank openrouter provider",
      model: "claude-opus-5",
    });
    expect(picked).toMatchObject({
      eventType: "input.rejected",
      error: "provider_unavailable",
    });
  }, 60_000);
});
