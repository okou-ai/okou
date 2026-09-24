import { assertPiLangfuseRelayContract } from "./helpers/pi-langfuse-relay";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
  LIMITED_FREE1_DEFAULT_RUN_MODEL,
} from "@okouai/api-contracts/contracts/model-providers";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { env, mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  readQueuedLangfuseContextFixture,
  readRunLangfuseTraceEnabledFixture,
  readRunModelRuntimeRouteFixture,
} from "../../../test-fixtures/agent-runs";
import { withBuiltInModelRuntimeRouteCandidateUnavailableForTest } from "../../../test-fixtures/built-in-model-runtime-route";
import {
  acquireBddBuiltInModelKey,
  holdChatThreadRowLockFixture,
  releaseBddBuiltInModelKey,
} from "../../../test-fixtures/chat-events";
import {
  setOrgModelPolicyProviderTypeFixture,
  stageUnrepairedOrgModelPolicyFixture,
} from "../../../test-fixtures/org-model-policies";
import { withModelRoutingQueryReceipt } from "../../../test-fixtures/model-routing-query-receipt";
import {
  deleteOrgPlanEntitlementFixture,
  upsertOrgPlanEntitlementFixture,
} from "../../../test-fixtures/org-plan-entitlement";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import { holdAgentRunPiExecutionSnapshotFixture } from "../../../test-fixtures/thread-bound-run-admission";
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
  type PromptMessage,
  requireOrgId,
  expectPiApiUsage,
  createGptUsagePricingResolution,
  createPiApiFirstTurnUsagePricingResolution,
  claimEnvironment,
  userMessages,
  modelProviderSecretPlaceholder,
} from "./helpers/chat-events-fixture";
import { piResponsesTextSse, piResponsesToolSse } from "./helpers/pi-responses";

const context = testContext({ connectorCatalog: true });
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
  sendChatRun,
  expectNoThreadModelUpdateEvent,
  claimChatRun,
  waitForThreadMessages,
  waitForRunStatus,
  completeChatRunOk,
  cancelChatRun,
  upsertOrgModelProvider,
  readThreadProjection,
  requestSendEventRaw,
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

// Keep Pi's API-first resource handoff deterministic for tests that inspect
// the frozen Sandbox claim rather than executing a provider request.
async function preparePiResourceHandoff(
  actor: ApiTestUser,
  agentId: string,
): Promise<void> {
  await publishPendingPiInstructions(actor, agentId);
  mockPiResourceArchiveDownloads(true);
  mockPiCheckpointObjectStore();
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
        isDefault: true,
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
        isDefault: true,
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
        isDefault: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);
    const insufficientBuiltIn = await chat.requestSendEvent(
      actor,
      {
        agentId,
        prompt: "reject built-in admission without spendable credits",
        model: "claude-sonnet-5",
      },
      [201],
    );
    if (insufficientBuiltIn.status !== 201) {
      throw new Error("Expected insufficient-credit send to return 201");
    }
    expect(insufficientBuiltIn.body.runId).toBeNull();

    // Restore spendable credits before exercising the built-in branch.
    await seedOrgMetadata({ orgId, tier: "pro", credits: 1_000_000 });

    // A built-in provider pin in an entitled org passes the spendable-credits
    // admission. The outcome past admission is race-dependent on the shared
    // database: 503 when no built-in model key exists (no public provisioning
    // surface), 201 when another suite's alive legacy test has seeded a
    // global built-in model key. Both prove the credits-ok admission arm.
    await setOrgModelPolicyProviderTypeFixture({
      orgId,
      model: "claude-sonnet-5",
      defaultProviderType: "built-in",
    });
    const builtInPrompt = "built-in admission with spendable credits";
    const builtInSend = await requestSendEventRaw(actor, {
      agentId,
      prompt: builtInPrompt,
      userMessage: {
        version: 1,
        parts: [{ type: "text", text: builtInPrompt }],
      },
      model: "claude-sonnet-5",
      hasTextContent: true,
    });
    expect([201, 503]).toContain(builtInSend.status);
    type BuiltInAdmissionObservation =
      | {
          readonly outcome: "route-unavailable";
          readonly response: {
            readonly status: 503;
            readonly errorMessage: string;
          };
          readonly cleanup: null;
        }
      | {
          readonly outcome: "run-created";
          readonly response: {
            readonly status: 201;
            readonly runId: string | null;
          };
          readonly cleanup: { readonly status: number } | null;
        };
    let builtInObservation: BuiltInAdmissionObservation;
    let expectedBuiltInObservation: BuiltInAdmissionObservation;
    if (builtInSend.status === 503) {
      expectApiError(builtInSend.body);
      builtInObservation = {
        outcome: "route-unavailable",
        response: {
          status: 503,
          errorMessage: builtInSend.body.error.message,
        },
        cleanup: null,
      };
      expectedBuiltInObservation = {
        outcome: "route-unavailable",
        response: {
          status: 503,
          errorMessage:
            "Every built-in model route for this model is temporarily unavailable",
        },
        cleanup: null,
      };
    } else {
      if (builtInSend.status !== 201) {
        throw new Error("Expected a legal built-in admission outcome");
      }
      if (
        typeof builtInSend.body !== "object" ||
        builtInSend.body === null ||
        !("runId" in builtInSend.body) ||
        (builtInSend.body.runId !== null &&
          typeof builtInSend.body.runId !== "string")
      ) {
        throw new Error("Expected a built-in admission response body");
      }
      const runId = builtInSend.body.runId;
      const cancellation =
        runId === null ? null : await api.requestCancelRun(actor, runId, [200]);
      builtInObservation = {
        outcome: "run-created",
        response: { status: 201, runId },
        cleanup: cancellation === null ? null : { status: cancellation.status },
      };
      expectedBuiltInObservation = {
        outcome: "run-created",
        response: { status: 201, runId },
        cleanup: runId === null ? null : { status: 200 },
      };
    }
    expect(builtInObservation).toStrictEqual(expectedBuiltInObservation);
  }, 90_000);

  it("reuses request-scoped routing reads on an existing-thread send", async () => {
    const { actor, agentId, providerId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-fable-5-1",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

    const thread = await chat.createThread(actor, {
      agentId,
      model: "claude-fable-5-1",
    });

    const captured = await withModelRoutingQueryReceipt(() => {
      return sendChatRun(actor, {
        agentId,
        threadId: thread.id,
        prompt: "reuse the routing receipt facts",
      });
    });
    // The second plan read is final admission. The existing thread reuses
    // its request-scoped policy and feature-switch reads; member routing
    // loads personal metadata and accounts once to check for a preferred route.
    expect(captured.receipt).toStrictEqual({
      planReads: 2,
      policyReads: 1,
      featureSwitchReads: 1,
      personalMetadataReads: 1,
      personalAccountReads: 1,
    });
    await cancelChatRun(actor, captured.result.runId);
  }, 90_000);

  it("routes from the authoritative policies seeded by the same send", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await seedBuiltInModelKey(DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL);
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
      selectedModel: DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
    });
    const { claim } = await claimChatRun(runnerGroup, run.runId);
    expect(claim.cliAgentType).toBe("pi");
    expect(claim.piModelConfig).toMatchObject({
      model: DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
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
        isDefault: true,
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

    await upsertOrgPlanEntitlementFixture({
      orgId,
      status: "suspended",
      supportByok: true,
      restrictedBuiltInModels: false,
    });
    const suspendedEventId = randomUUID();
    const suspended = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: initial.threadId,
        prompt: "reject suspended persisted admission",
        clientEventId: suspendedEventId,
      },
      [201],
    );
    if (suspended.status !== 201) {
      throw new Error("Expected suspended-plan send to return 201");
    }
    expect(suspended.body.runId).toBeNull();
    const suspendedMessages = await chat.listThreadEvents(
      actor,
      initial.threadId,
    );
    expect(userMessages(suspendedMessages.events)).toContainEqual(
      expect.objectContaining({
        eventType: "input.rejected",
        revokesEventId: suspendedEventId,
        error: "insufficient_credits",
      }),
    );

    await deleteOrgPlanEntitlementFixture(orgId);
    const missing = await requestSendEventRaw(actor, {
      agentId,
      threadId: initial.threadId,
      prompt: "reject missing persisted plan authority",
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text: "reject missing persisted plan authority" },
        ],
      },
      hasTextContent: true,
    });
    expect(missing.status).toBe(500);

    await upsertOrgPlanEntitlementFixture({
      orgId,
      status: "active",
      supportByok: false,
      restrictedBuiltInModels: false,
    });
    await seedBuiltInModelKey(LIMITED_FREE1_DEFAULT_RUN_MODEL);
    await preparePiResourceHandoff(actor, agentId);
    const byokDisabled = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: initial.threadId,
        prompt: "fall back from a BYOK-disabled persisted route",
      },
      [201],
    );
    if (byokDisabled.status !== 201) {
      throw new Error("Expected BYOK-disabled send to return 201");
    }
    if (!byokDisabled.body.runId) {
      throw new Error("Expected BYOK-disabled policy fallback to create a run");
    }
    const byokDisabledPolicies = await misc.listModelPolicies(actor);
    expect(byokDisabledPolicies.policies).toContainEqual(
      expect.objectContaining({
        model: LIMITED_FREE1_DEFAULT_RUN_MODEL,
        isDefault: true,
        defaultProviderType: "built-in",
        modelProviderId: null,
      }),
    );
    const byokDisabledClaim = await claimChatRun(
      runnerGroup,
      byokDisabled.body.runId,
    );
    expect(byokDisabledClaim.claim.cliAgentType).toBe("pi");
    expect(byokDisabledClaim.claim.piModelConfig).toMatchObject({
      model: LIMITED_FREE1_DEFAULT_RUN_MODEL,
    });
    await cancelChatRun(
      actor,
      byokDisabled.body.runId,
      byokDisabledClaim.sandboxHeaders,
    );

    await upsertOrgPlanEntitlementFixture({
      orgId,
      status: "active",
      supportByok: true,
      restrictedBuiltInModels: false,
    });
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-fable-5-1",
        isDefault: true,
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
    const restrictedByok = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: initial.threadId,
        prompt: "keep BYOK when built-in models are restricted",
      },
      [201],
    );
    if (restrictedByok.status !== 201) {
      throw new Error("Expected restricted-plan BYOK send to return 201");
    }
    if (!restrictedByok.body.runId) {
      throw new Error("Expected restricted-plan BYOK policy to create a run");
    }
    const restrictedPolicies = await misc.listModelPolicies(actor);
    expect(restrictedPolicies.policies).toContainEqual(
      expect.objectContaining({
        model: "claude-fable-5-1",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        modelProviderId: providerId,
      }),
    );
    await cancelChatRun(actor, restrictedByok.body.runId);
  }, 90_000);

  it("reloads external plan capabilities at final admission", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const orgId = requireOrgId(actor);
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-fable-5-1",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

    const initial = await sendChatRun(actor, {
      agentId,
      prompt: "establish final plan admission freshness",
      model: "claude-fable-5-1",
    });
    const initialClaim = await claimChatRun(runnerGroup, initial.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(initial.runId, initialClaim.sandboxHeaders);
    await flushWaitUntilForTest();

    const threadLock = await holdChatThreadRowLockFixture({
      threadId: initial.threadId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      threadLock.release();
      await threadLock.done;
    });
    const prompt = "reject plan changed after persisted preflight";
    const followUp = chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: initial.threadId,
        prompt,
      },
      [402],
    );
    await expect.poll(threadLock.blockedWaiterCount).toBe(1);

    await upsertOrgPlanEntitlementFixture({
      orgId,
      status: "suspended",
      supportByok: true,
      restrictedBuiltInModels: false,
    });
    threadLock.release();
    const rejected = await followUp;
    await threadLock.done;
    expectApiError(rejected.body);
    expect(rejected.body.error.code).toBe("INSUFFICIENT_CREDITS");

    const runs = await api.listAgentRuns(actor, {
      status: "queued,pending,running,completed,failed,timeout,cancelled",
      limit: 100,
    });
    expect(
      runs.runs.filter((run) => {
        return run.prompt === prompt;
      }),
    ).toHaveLength(0);
  }, 90_000);

  it.each(["deleted", "wrong-provider-key"] as const)(
    "rejects V4.1 %s credentials without borrowing another route",
    async (boundary) => {
      const { actor, agentId } = await entitledChatActor();
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
          isDefault: true,
          defaultProviderType: "openrouter-codex",
          credentialScope: "org",
          modelProviderId: providerId,
        },
      ]);

      const gate = holdAgentRunPiExecutionSnapshotFixture({
        userId: actor.userId,
        orgId: requireOrgId(actor),
        signal: context.signal,
      });
      onTestFinished(gate.release);
      let calls = 0;
      server.use(
        ...["https://api.deepseek.com/*", "https://openrouter.ai/*"].map(
          (url) => {
            return http.post(url, () => {
              calls += 1;
              return new HttpResponse(null, { status: 500 });
            });
          },
        ),
      );
      const sent = chat.requestSendEvent(
        actor,
        {
          agentId,
          model: "deepseek-v4.1-flash",
          clientEventId: randomUUID(),
          prompt: "Reject unavailable selected credentials",
        },
        boundary === "deleted" ? [503] : [400],
      );
      await expect(gate.arrival).resolves.toMatchObject({ piExecution: true });
      if (boundary === "deleted") {
        await misc.deleteOrgModelProvider(actor, "openrouter-codex", [204]);
      }
      gate.release();
      const response = await sent;
      await flushWaitUntilForTest();
      expect(response.status).toBe(boundary === "deleted" ? 503 : 400);
      expect(calls).toBe(0);
    },
    90_000,
  );

  it.each(["old-cli", "mutable-cli", "effort"] as const)(
    "rejects V4.1 %s before provider I/O",
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
      let calls = 0;
      server.use(
        ...["https://api.deepseek.com/*", "https://openrouter.ai/*"].map(
          (url) => {
            return http.post(url, () => {
              calls += 1;
              return new HttpResponse(piResponsesTextSse("unexpected", calls), {
                headers: { "content-type": "text/event-stream" },
              });
            });
          },
        ),
      );
      const response = await chat.requestSendEvent(
        actor,
        {
          agentId,
          model: "deepseek-v4.1-flash",
          prompt: "Reject incompatible admission",
          clientEventId: randomUUID(),
          ...(boundary === "effort"
            ? { runOptions: { reasoningEffort: "high" as const } }
            : {}),
        },
        [400],
      );
      await flushWaitUntilForTest();
      expect(response.status).toBe(400);
      expect(calls).toBe(0);
    },
    90_000,
  );

  it("exposes the owner's run trace URL after tracing is disabled", async () => {
    const { actor, agentId } = await entitledChatActor();
    const orgId = requireOrgId(actor);
    await configureBuiltInPiModel(actor, "gpt-5.6-terra");
    const pricing = await createGptUsagePricingResolution();
    mockPiResourceArchiveDownloads();
    const checkpointObjects = mockPiCheckpointObjectStore();
    mockOptionalEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-bdd-trace-link");
    mockOptionalEnv("LANGFUSE_SECRET_KEY", "sk-lf-bdd-trace-link");
    mockOptionalEnv("LANGFUSE_BASE_URL", undefined);
    mockOptionalEnv("LANGFUSE_PROJECT_ID", undefined);
    server.use(
      http.post("https://api.openai.com/v1/responses", () => {
        return new HttpResponse(piResponsesTextSse("Completed answer", 0), {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      {
        [FeatureSwitchKey.LangfuseTrace]: true,
      },
    );
    const traced = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "complete a traced run",
        model: "gpt-5.6-terra",
      },
      pricing,
    );
    // API-first execution can outlive the send response; join its owned work
    // before asserting completion or changing the tracing configuration.
    await flushWaitUntilForTest();
    expect((await api.readRun(actor, traced.runId)).status).toBe("completed");
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
    const untraced = await sendChatRun(
      actor,
      {
        agentId,
        threadId: traced.threadId,
        prompt: "continue without tracing",
        model: "gpt-5.6-terra",
      },
      pricing,
    );
    await flushWaitUntilForTest();
    expect(
      checkpointObjects.has(
        `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${untraced.runId}/manifest.json`,
      ),
    ).toBeTruthy();
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
    await configureBuiltInPiModel(actor, "gpt-5.6-terra");
    const usagePricingResolution = await createGptUsagePricingResolution();
    mockPiResourceArchiveDownloads(true);
    const checkpointObjects = mockPiCheckpointObjectStore();
    mockOptionalEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-bdd-trace-admission");
    mockOptionalEnv("LANGFUSE_SECRET_KEY", "sk-lf-bdd-trace-admission");
    mockOptionalEnv("LANGFUSE_BASE_URL", "https://langfuse.example");
    server.use(
      http.post("https://api.openai.com/v1/responses", () => {
        return new HttpResponse(
          piResponsesToolSse({
            callId: "call_langfuse_trace_admission",
            name: "read",
            arguments: { path: "/etc/os-release" },
            sequence: 1,
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      {
        [FeatureSwitchKey.LangfuseTrace]: true,
      },
    );
    await api.heartbeatRunner(runnerGroup);

    const run = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "preserve the Langfuse trace gate through claim",
        model: "gpt-5.6-terra",
      },
      usagePricingResolution,
    );
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
      sessionId: run.threadId,
      token: claimed.claim.platformEnvironment.OKOU_TOKEN,
      checkpointObjects,
    });
    await cancelChatRun(actor, run.runId, claimed.sandboxHeaders);

    const untraced = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "run without trace admission",
        model: "gpt-5.6-terra",
      },
      usagePricingResolution,
    );
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
        isDefault: true,
        defaultProviderType: "deepseek",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "deepseek-v4.1-flash",
        isDefault: false,
        defaultProviderType: "openrouter-codex",
        credentialScope: "org",
        modelProviderId: openrouterProviderId,
      },
    ]);

    await publishPendingPiInstructions(actor, agentId);
    mockPiResourceArchiveDownloads(true);
    const checkpointObjects = mockPiCheckpointObjectStore();
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution("deepseek-v4-flash");
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

  it("recovers a removed thread model through the current workspace route", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-fable-5-1",
        isDefault: true,
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

    await seedBuiltInModelKey("gpt-6-astra");
    await api.updateOrgModelPolicies(actor, [
      {
        model: "gpt-6-astra",
        isDefault: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);

    const threadLock = await holdChatThreadRowLockFixture({
      threadId: first.threadId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      threadLock.release();
      await threadLock.done;
    });
    const [recovered] = await Promise.all([
      sendChatRun(actor, {
        agentId,
        threadId: first.threadId,
        prompt: "continue through the current workspace default",
      }),
      (async () => {
        await expect
          .poll(threadLock.firstBlockedStatementKind)
          .toBe("select_for_update");
        threadLock.release();
        await threadLock.done;
      })(),
    ]);
    const recoveredClaim = await claimChatRun(runnerGroup, recovered.runId);
    expect(recoveredClaim.claim.cliAgentType).toBe("codex");
    expect(recoveredClaim.claim.resumeSession).toBeNull();
    const recoveredEnvironment = claimEnvironment(recoveredClaim.claim);
    expect(recoveredEnvironment.OPENAI_MODEL).toBe("gpt-6-astra");
    expect(recoveredEnvironment.ANTHROPIC_MODEL).toBeUndefined();

    const threadEvents = await chat.requestThreadEvents(actor, {}, [200]);
    if (threadEvents.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(
      threadEvents.body.events.filter((event) => {
        return (
          event.kind === "model_selection_updated" &&
          event.chatThreadId === first.threadId &&
          event.selectedModel === "gpt-6-astra"
        );
      }),
    ).toHaveLength(1);

    await cancelChatRun(actor, recovered.runId);
  }, 90_000);

  it("resolves a NULL legacy thread from current defaults without replaying its first run", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await seedBuiltInModelKey("gpt-6-astra");
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-fable-5-1",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "gpt-6-astra",
        isDefault: false,
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
        prompt: "continue after canonical default resolution",
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
        isDefault: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
      {
        model: "claude-fable-5-1",
        isDefault: false,
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
    expect(promotedClaim.claim.cliAgentType).toBe("codex");
    expect(claimEnvironment(promotedClaim.claim).OPENAI_MODEL).toBe(
      "gpt-6-astra",
    );
    expect(
      (await chat.readThreadMetadata(actor, first.threadId)).selectedModel,
    ).toBe("gpt-6-astra");

    const threadEvents = await chat.requestThreadEvents(actor, {}, [200]);
    if (threadEvents.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(threadEvents.body.events).toContainEqual(
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
        isDefault: true,
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
        isDefault: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
      {
        model: "claude-fable-5-1",
        isDefault: false,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

    const [sent, updated] = await Promise.all([
      chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: thread.id,
          prompt: "send while choosing a new sticky model",
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
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected the concurrent send to create a run");
    }
    const racedClaim = await claimChatRun(runnerGroup, sent.body.runId);
    const racedEnvironment = claimEnvironment(racedClaim.claim);
    expect(["gpt-6-astra", "claude-fable-5-1"]).toContain(
      racedEnvironment.OPENAI_MODEL ?? racedEnvironment.ANTHROPIC_MODEL,
    );
    await cancelChatRun(actor, sent.body.runId, racedClaim.sandboxHeaders);

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
        isDefault: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
      {
        model: "gpt-5.6-luna",
        isDefault: false,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
      {
        model: "claude-sonnet-5",
        isDefault: false,
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
        isDefault: true,
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
        isDefault: true,
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
    {
      model: "okou-1.0-pro",
      preset: "@preset/okou-1-0-pro",
    },
    {
      model: "okou-1.0-max",
      preset: "@preset/okou-1-0-max",
    },
  ] as const)(
    "routes built-in $model only through its OpenRouter Preset",
    async ({ model, preset }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      await seedBuiltInModelCandidateKeys(context, model);
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.OkouModels]: true,
      });
      await api.updateOrgModelPolicies(actor, [
        {
          model,
          isDefault: true,
          defaultProviderType: "built-in",
          credentialScope: "org",
          modelProviderId: null,
        },
      ]);
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.OkouModels]: false,
      });
      await preparePiResourceHandoff(actor, agentId);

      const run = await sendChatRun(actor, {
        agentId,
        model,
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
          isDefault: true,
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
          isDefault: true,
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
          isDefault: true,
          defaultProviderType: "built-in",
          credentialScope: "org",
          modelProviderId: null,
        },
      ]);
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.DeepSeekAlternativeRouting]: true,
        [FeatureSwitchKey.OpenRouterUsRouting]: false,
      });

      const prompt = "require the managed OpenRouter DeepSeek route";
      const response =
        await withBuiltInModelRuntimeRouteCandidateUnavailableForTest(
          {
            selectedModel: model,
            providerType: "openrouter-codex",
            upstreamModel: `deepseek/${model}`,
          },
          async () => {
            return await requestSendEventRaw(actor, {
              agentId,
              prompt,
              userMessage: {
                version: 1,
                parts: [{ type: "text", text: prompt }],
              },
              model,
              hasTextContent: true,
            });
          },
        );
      expect(response.status).toBe(503);
      expectApiError(response.body);
      expect(response.body.error.message).toBe(
        "Every built-in model route for this model is temporarily unavailable",
      );
    },
  );

  it.each(
    (
      [
        "claude-sonnet-5",
        "claude-fable-5-1",
        "gpt-5.6-terra",
        "deepseek-v4-flash",
      ] as const
    ).flatMap((model) => {
      return [false, true].map((enabled) => {
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
        isDefault: true,
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
    const { actor, agentId } = await entitledChatActor();
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution("deepseek-v4-flash");
    const keyFixtureId = randomUUID();
    const requestedApiKey = `built-in-key-bdd-dev-seed-${keyFixtureId}`;

    // Keep a second DeepSeek fixture owner alive to cover vendor-unique row
    // arbitration instead of relying on another test file's scheduling.
    await seedBuiltInModelKey("deepseek-v4-flash");
    const selectedApiKey = await acquireBddBuiltInModelKey({
      fixtureId: keyFixtureId,
      vendor: "deepseek",
      apiKey: requestedApiKey,
    });

    let runId: string | null = null;
    const cancelRunIfCreated = async () => {
      if (runId) {
        const status = (await api.readRun(actor, runId)).status;
        if (status === "pending" || status === "running") {
          await api.requestCancelRun(actor, runId, [200]);
        }
      }
    };
    const releaseBuiltInDeepSeekKey = async () => {
      await releaseBddBuiltInModelKey({ fixtureId: keyFixtureId });
    };
    const cleanupRunAndKeys = async () => {
      await Promise.all([releaseBuiltInDeepSeekKey(), cancelRunIfCreated()]);
    };

    await (async () => {
      if (!actor.orgId) {
        throw new Error("Expected an organization-scoped chat actor");
      }

      await api.updateOrgModelPolicies(actor, [
        {
          model: "deepseek-v4-flash",
          isDefault: true,
          defaultProviderType: "built-in",
          credentialScope: "org",
          modelProviderId: null,
        },
      ]);
      mockPiResourceArchiveDownloads();
      mockPiCheckpointObjectStore();
      const modelRequests: {
        readonly authorizationMatches: boolean;
        readonly body: unknown;
      }[] = [];
      server.use(
        http.post("https://api.deepseek.com/responses", async ({ request }) => {
          modelRequests.push({
            authorizationMatches:
              request.headers.get("authorization") ===
              `Bearer ${selectedApiKey}`,
            body: await request.json(),
          });
          return new HttpResponse(
            piResponsesTextSse(
              "built-in Pi API response",
              modelRequests.length,
            ),
            { headers: { "content-type": "text/event-stream" } },
          );
        }),
      );

      const run = await sendChatRun(
        actor,
        {
          agentId,
          prompt: "run with the selected built-in DeepSeek provider",
          model: "deepseek-v4-flash",
        },
        usagePricingResolution,
      );
      runId = run.runId;
      await waitForRunStatus(actor, run.runId, "completed");
      await flushWaitUntilForTest();
      expect(modelRequests).toHaveLength(1);
      expect(modelRequests[0]?.authorizationMatches).toBeTruthy();
      expect(modelRequests[0]?.body).toMatchObject({
        model: "deepseek-v4-flash",
        stream: true,
      });
      await expectPiApiUsage(run.runId, "deepseek-v4-flash", "", {
        input: 5,
        output: 3,
        cacheRead: 0,
        cacheCreation: 0,
      });
      const claim = await api.requestClaimRunnerJob(true, run.runId, [404]);
      expect(claim.status).toBe(404);
      runId = null;
    })().then(cleanupRunAndKeys, async (error: unknown) => {
      await cleanupRunAndKeys();
      throw error;
    });
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
        isDefault: true,
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
        isDefault: true,
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

    // A blank legacy credential is no longer claimable: the external send
    // boundary fails closed before a Sandbox can receive its secret bundle.
    const prompt = "run with a legacy blank openrouter provider";
    const rejected = await requestSendEventRaw(actor, {
      agentId,
      prompt,
      userMessage: {
        version: 1,
        parts: [{ type: "text", text: prompt }],
      },
      model: "claude-opus-5",
      hasTextContent: true,
    });
    expect(rejected.status).toBe(503);
    expectApiError(rejected.body);
    expect(rejected.body.error.code).toBe("PROVIDER_UNAVAILABLE");
  }, 60_000);
});
