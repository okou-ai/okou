import {
  sessionOutputDeltaSchema,
  type SessionOutputDelta,
} from "@okouai/api-contracts/contracts/realtime";
import { createHash, randomUUID } from "node:crypto";
import { piApiFirstTurnManifestSchema } from "@okouai/api-contracts/contracts/runners";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { readRunOutputMemoryCitationsFixture } from "../../../test-fixtures/chat-events";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { chatEventDisplayText } from "./helpers/chat-event";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  readThreadSessionBinding,
  readThreadSessionConversation,
} from "./helpers/runtime-state";
import {
  createChatEventsFixture,
  GPT_PI_BDD_MODELS,
  requireOrgId,
  expectPiApiUsage,
  createGptUsagePricingResolution,
  claimEnvironment,
  eventBackedContents,
  assistantEvent,
  PI_RESOURCE_ARCHIVE_DOWNLOAD_URL,
  occurrences,
} from "./helpers/chat-events-fixture";
import {
  piResponsesTextSse,
  piResponsesContentSse,
  piResponsesToolSse,
  nativeCodexSseResponse,
} from "./helpers/pi-responses";

const context = testContext();
const {
  api,
  chat,
  webhooks,
  chatCallbacks,
  authDeviceSupport,
  entitledChatActor,
  seedBuiltInModelKey,
  configureBuiltInPiModel,
  sendChatRun,
  claimChatRun,
  waitForThreadMessages,
  waitForRunStatus,
  completeChatRunOk,
  cancelChatRun,
  mockPiCheckpointObjectStore,
  piS3Object,
  publishPendingPiInstructions,
  mockPiResourceArchiveDownloads,
  queueCapabilityProvenPiRun,
} = createChatEventsFixture(context);

describe("CHAT-02: model-first provider policies", () => {
  it("preserves one Pi session while selecting Terra, Sol, Luna, and Terra again", async () => {
    const { actor, agentId } = await entitledChatActor();
    for (const model of GPT_PI_BDD_MODELS) {
      await seedBuiltInModelKey(model);
    }
    await api.updateOrgModelPolicies(
      actor,
      GPT_PI_BDD_MODELS.map((model) => {
        return {
          model,
          isDefault: model === "gpt-5.6-terra",
          defaultProviderType: "built-in",
          credentialScope: "org",
          modelProviderId: null,
        };
      }),
    );
    await authDeviceSupport.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.PiLoop]: true,
    });
    const usagePricingResolution = await createGptUsagePricingResolution();
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();
    const requests: unknown[] = [];
    server.use(
      http.post("https://api.openai.com/v1/responses", async ({ request }) => {
        requests.push(await request.json());
        return nativeCodexSseResponse(
          piResponsesTextSse(`answer ${requests.length}`, requests.length),
        );
      }),
    );
    let threadId: string | undefined;
    let sessionId: string | null | undefined;
    for (const model of [...GPT_PI_BDD_MODELS, "gpt-5.6-terra"] as const) {
      const run = await sendChatRun(
        actor,
        { agentId, threadId, model, prompt: `continue with ${model}` },
        usagePricingResolution,
      );
      threadId = run.threadId;
      await waitForRunStatus(actor, run.runId, "completed");
      await flushWaitUntilForTest();
      const session = await readThreadSessionConversation(context, threadId);
      if (sessionId === undefined) {
        sessionId = session.agent_session_id;
        expect(sessionId).toStrictEqual(expect.any(String));
      }
      expect(session.agent_session_id).toBe(sessionId);
      expect(requests.at(-1)).toMatchObject({
        model,
        reasoning: { effort: "max" },
      });
      expect(requests.at(-1)).not.toHaveProperty("service_tier");
      await expectPiApiUsage(run.runId, model, "", {
        input: 5,
        output: 3,
        cacheRead: 0,
        cacheCreation: 0,
      });
    }
    expect(requests).toHaveLength(4);
    for (const answer of ["answer 1", "answer 2", "answer 3"]) {
      expect(occurrences(JSON.stringify(requests.at(-1)), answer)).toBe(1);
    }
  }, 90_000);

  it("preserves generations across Terra Pi and fast Astra Codex boundaries", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected entitled chat actor to have an org");
    }
    const piModel = "gpt-5.6-terra";
    await seedBuiltInModelKey(piModel);
    await seedBuiltInModelKey("gpt-6-astra");
    await api.updateOrgModelPolicies(actor, [
      {
        model: piModel,
        isDefault: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
      {
        model: "gpt-6-astra",
        isDefault: false,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      {
        [FeatureSwitchKey.PiLoop]: true,
      },
    );
    mockPiResourceArchiveDownloads();
    const checkpointObjects = mockPiCheckpointObjectStore();
    const firstPiAnswer = "first Pi generation answer";
    const returnedPiAnswer = "returned Pi generation answer";
    const interruptedPiAnswer = "Pi follow-up before Sandbox handoff";
    const repeatedPiAnswer = "repeated Pi generation answer";
    const modelRequests: unknown[] = [];
    server.use(
      http.post("https://api.openai.com/v1/responses", async ({ request }) => {
        const requestIndex = modelRequests.length;
        modelRequests.push(await request.json());
        const body =
          requestIndex === 2
            ? piResponsesContentSse({
                blocks: [
                  { type: "text", text: interruptedPiAnswer },
                  {
                    type: "toolCall",
                    callId: "call_generation_boundary",
                    name: "read",
                    arguments: { path: "/home/user/workspace/AGENTS.md" },
                  },
                ],
                sequence: requestIndex,
              })
            : piResponsesTextSse(
                [firstPiAnswer, returnedPiAnswer, undefined, repeatedPiAnswer][
                  requestIndex
                ] ?? "unexpected duplicate Pi model request",
                requestIndex,
              );
        return new HttpResponse(body, {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );

    const firstPiPrompt = "start the first Pi generation";
    const firstPi = await sendChatRun(actor, {
      agentId,
      prompt: firstPiPrompt,
      model: piModel,
    });
    await waitForRunStatus(actor, firstPi.runId, "completed", 10_000);
    await flushWaitUntilForTest();
    expect(modelRequests).toHaveLength(1);
    const firstPiBinding = await readThreadSessionBinding(
      context,
      firstPi.threadId,
    );
    if (!firstPiBinding.agent_session_id) {
      throw new Error("Expected the first Pi run to bind a canonical session");
    }
    await expect(
      readThreadSessionConversation(context, firstPi.threadId),
    ).resolves.toMatchObject({ conversation_run_id: firstPi.runId });

    const firstCodexPrompt = "continue through Codex between Pi generations";
    const firstCodexAnswer = "Codex answer between Pi generations";
    const firstCodex = await sendChatRun(actor, {
      agentId,
      threadId: firstPi.threadId,
      prompt: firstCodexPrompt,
      model: "gpt-6-astra",
      runOptions: { codexServiceTier: "fast" },
    });
    const firstCodexBinding = await readThreadSessionBinding(
      context,
      firstPi.threadId,
    );
    expect(firstCodexBinding.agent_session_id).not.toBe(
      firstPiBinding.agent_session_id,
    );
    const firstCodexRun = await api.readRun(actor, firstCodex.runId);
    expect(firstCodexRun.appendSystemPrompt).toContain(
      "# Web Chat Run Context",
    );
    expect(firstCodexRun.appendSystemPrompt).toContain(firstPiPrompt);
    expect(firstCodexRun.appendSystemPrompt).toContain(firstPiAnswer);
    const firstCodexClaim = await claimChatRun(runnerGroup, firstCodex.runId);
    expect(firstCodexClaim.claim.cliAgentType).toBe("codex");
    expect(
      claimEnvironment(firstCodexClaim.claim).OKOU_CODEX_SERVICE_TIER,
    ).toBe("fast");
    expect(firstCodexClaim.claim.piLaunchConfig).toBeUndefined();
    expect(firstCodexClaim.claim.resumeSession).toBeNull();
    chatCallbacks.mockChatOutputEvents([assistantEvent(0, firstCodexAnswer)]);
    await completeChatRunOk(firstCodex.runId, firstCodexClaim.sandboxHeaders, {
      cliAgentType: "codex",
      lastEventSequence: 0,
    });
    await flushWaitUntilForTest();

    const returnedPiPrompt = "return to Pi with every visible prior turn";
    await chat.updateThreadModelSelection(actor, firstPi.threadId, piModel, {
      codexServiceTier: null,
    });
    const returnedPi = await sendChatRun(actor, {
      agentId,
      threadId: firstPi.threadId,
      prompt: returnedPiPrompt,
      model: piModel,
    });
    await waitForRunStatus(actor, returnedPi.runId, "completed", 10_000);
    await flushWaitUntilForTest();
    expect(modelRequests).toHaveLength(2);
    const returnedPiBinding = await readThreadSessionBinding(
      context,
      firstPi.threadId,
    );
    if (!returnedPiBinding.agent_session_id) {
      throw new Error("Expected the returned Pi run to bind a new session");
    }
    expect(returnedPiBinding.agent_session_id).not.toBe(
      firstCodexBinding.agent_session_id,
    );
    expect(returnedPiBinding.agent_session_id).not.toBe(
      firstPiBinding.agent_session_id,
    );
    const returnedPiRun = await api.readRun(actor, returnedPi.runId);
    const returnedPiAppend = returnedPiRun.appendSystemPrompt ?? "";
    expect(returnedPiAppend).toContain("# Web Chat Run Context");
    for (const prior of [
      firstPiPrompt,
      firstPiAnswer,
      firstCodexPrompt,
      firstCodexAnswer,
    ]) {
      expect(occurrences(returnedPiAppend, prior)).toBe(1);
    }
    const returnedPiInput = JSON.stringify(modelRequests[1]);
    for (const turn of [
      firstPiPrompt,
      firstPiAnswer,
      firstCodexPrompt,
      firstCodexAnswer,
      returnedPiPrompt,
    ]) {
      expect(occurrences(returnedPiInput, turn)).toBe(1);
    }
    await expect(
      readThreadSessionConversation(context, firstPi.threadId),
    ).resolves.toMatchObject({
      agent_session_id: returnedPiBinding.agent_session_id,
      conversation_run_id: returnedPi.runId,
    });

    const piFollowUpPrompt = "resume the returned Pi generation once";
    const piFollowUp = await sendChatRun(actor, {
      agentId,
      threadId: firstPi.threadId,
      prompt: piFollowUpPrompt,
      model: piModel,
    });
    const piFollowUpManifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${piFollowUp.runId}/manifest.json`;
    await expect
      .poll(() => {
        return checkpointObjects.has(piFollowUpManifestKey);
      })
      .toBe(true);
    expect(modelRequests).toHaveLength(3);
    const piFollowUpRun = await api.readRun(actor, piFollowUp.runId);
    const piFollowUpAppend = piFollowUpRun.appendSystemPrompt ?? "";
    expect(piFollowUpAppend).not.toContain("# Web Chat Run Context");
    expect(piFollowUpAppend).not.toContain(firstPiPrompt);
    expect(piFollowUpAppend).not.toContain(firstCodexPrompt);
    const piFollowUpInput = JSON.stringify(modelRequests[2]);
    expect(occurrences(piFollowUpInput, returnedPiPrompt)).toBe(1);
    expect(occurrences(piFollowUpInput, returnedPiAnswer)).toBe(1);
    expect(occurrences(piFollowUpInput, piFollowUpPrompt)).toBe(1);
    expect(piFollowUpInput).not.toContain(firstPiPrompt);
    expect(piFollowUpInput).not.toContain(firstCodexPrompt);
    const piFollowUpBinding = await readThreadSessionBinding(
      context,
      firstPi.threadId,
    );
    expect(piFollowUpBinding.agent_session_id).toBe(
      returnedPiBinding.agent_session_id,
    );
    const piFollowUpClaim = await claimChatRun(runnerGroup, piFollowUp.runId);
    const resumedPiSession = piFollowUpClaim.claim.resumeSession;
    if (!resumedPiSession || !("historyRef" in resumedPiSession)) {
      throw new Error("Expected the Pi follow-up to resume a blob checkpoint");
    }
    expect(resumedPiSession).toMatchObject({
      sessionId: firstPi.threadId,
      historyRef: {
        kind: "blob",
        hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    expect(piFollowUpClaim.claim.piSessionId).toBe(firstPi.threadId);
    expect(piFollowUpClaim.claim.piLaunchConfig).toMatchObject({
      apiFirstTurn: {
        baseSession: {
          sessionId: firstPi.threadId,
          sha256: resumedPiSession.historyRef.hash,
        },
      },
    });
    const piFollowUpManifest = JSON.parse(
      checkpointObjects.get(piFollowUpManifestKey)?.toString("utf8") ?? "{}",
    ) as {
      readonly baseSession?: {
        readonly sessionId?: unknown;
        readonly sha256?: unknown;
      };
    };
    expect(piFollowUpManifest.baseSession).toStrictEqual({
      sessionId: firstPi.threadId,
      sha256: resumedPiSession.historyRef.hash,
    });
    await cancelChatRun(
      actor,
      piFollowUp.runId,
      piFollowUpClaim.sandboxHeaders,
    );
    await expect(
      readThreadSessionConversation(context, firstPi.threadId),
    ).resolves.toMatchObject({ conversation_run_id: returnedPi.runId });

    const repeatedCodexPrompt = "cross Codex before returning to Pi again";
    const repeatedCodexAnswer = "second intervening Codex answer";
    const repeatedCodex = await sendChatRun(actor, {
      agentId,
      threadId: firstPi.threadId,
      prompt: repeatedCodexPrompt,
      model: "gpt-6-astra",
      runOptions: { codexServiceTier: "fast" },
    });
    const repeatedCodexBinding = await readThreadSessionBinding(
      context,
      firstPi.threadId,
    );
    expect(repeatedCodexBinding.agent_session_id).not.toBe(
      returnedPiBinding.agent_session_id,
    );
    const repeatedCodexClaim = await claimChatRun(
      runnerGroup,
      repeatedCodex.runId,
    );
    expect(repeatedCodexClaim.claim.cliAgentType).toBe("codex");
    expect(
      claimEnvironment(repeatedCodexClaim.claim).OKOU_CODEX_SERVICE_TIER,
    ).toBe("fast");
    expect(repeatedCodexClaim.claim.piLaunchConfig).toBeUndefined();
    expect(repeatedCodexClaim.claim.resumeSession).toBeNull();
    const repeatedCodexRun = await api.readRun(actor, repeatedCodex.runId);
    expect(repeatedCodexRun.appendSystemPrompt).toContain(piFollowUpPrompt);
    expect(repeatedCodexRun.appendSystemPrompt).toContain("Run cancelled");
    expect(repeatedCodexRun.appendSystemPrompt).not.toContain(
      interruptedPiAnswer,
    );
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, repeatedCodexAnswer),
    ]);
    await completeChatRunOk(
      repeatedCodex.runId,
      repeatedCodexClaim.sandboxHeaders,
      { cliAgentType: "codex", lastEventSequence: 0 },
    );
    await flushWaitUntilForTest();

    const repeatedPiPrompt = "return to a third Pi generation";
    await chat.updateThreadModelSelection(actor, firstPi.threadId, piModel, {
      codexServiceTier: null,
    });
    const repeatedPi = await sendChatRun(actor, {
      agentId,
      threadId: firstPi.threadId,
      prompt: repeatedPiPrompt,
      model: piModel,
    });
    await waitForRunStatus(actor, repeatedPi.runId, "completed", 10_000);
    await flushWaitUntilForTest();
    expect(modelRequests).toHaveLength(4);
    const repeatedPiBinding = await readThreadSessionBinding(
      context,
      firstPi.threadId,
    );
    expect(repeatedPiBinding.agent_session_id).not.toBe(
      repeatedCodexBinding.agent_session_id,
    );
    expect(repeatedPiBinding.agent_session_id).not.toBe(
      returnedPiBinding.agent_session_id,
    );
    const repeatedPiRun = await api.readRun(actor, repeatedPi.runId);
    const repeatedPiAppend = repeatedPiRun.appendSystemPrompt ?? "";
    expect(repeatedPiAppend).toContain("# Web Chat Run Context");
    for (const prior of [
      firstPiPrompt,
      firstPiAnswer,
      firstCodexPrompt,
      firstCodexAnswer,
      returnedPiPrompt,
      returnedPiAnswer,
      piFollowUpPrompt,
      "Run cancelled",
      repeatedCodexPrompt,
      repeatedCodexAnswer,
    ]) {
      expect(occurrences(repeatedPiAppend, prior)).toBe(1);
    }
    expect(repeatedPiAppend).not.toContain(interruptedPiAnswer);
    const repeatedPiInput = JSON.stringify(modelRequests[3]);
    for (const turn of [
      firstPiPrompt,
      firstPiAnswer,
      firstCodexPrompt,
      firstCodexAnswer,
      returnedPiPrompt,
      returnedPiAnswer,
      piFollowUpPrompt,
      "Run cancelled",
      repeatedCodexPrompt,
      repeatedCodexAnswer,
      repeatedPiPrompt,
    ]) {
      expect(occurrences(repeatedPiInput, turn)).toBe(1);
    }
    expect(repeatedPiInput).not.toContain(interruptedPiAnswer);
    await expect(
      readThreadSessionConversation(context, firstPi.threadId),
    ).resolves.toMatchObject({
      agent_session_id: repeatedPiBinding.agent_session_id,
      conversation_run_id: repeatedPi.runId,
    });

    const visibleTurns = [
      { runId: firstPi.runId, prompt: firstPiPrompt, answer: firstPiAnswer },
      {
        runId: firstCodex.runId,
        prompt: firstCodexPrompt,
        answer: firstCodexAnswer,
      },
      {
        runId: returnedPi.runId,
        prompt: returnedPiPrompt,
        answer: returnedPiAnswer,
      },
      {
        runId: piFollowUp.runId,
        prompt: piFollowUpPrompt,
        answer: interruptedPiAnswer,
      },
      {
        runId: repeatedCodex.runId,
        prompt: repeatedCodexPrompt,
        answer: repeatedCodexAnswer,
      },
      {
        runId: repeatedPi.runId,
        prompt: repeatedPiPrompt,
        answer: repeatedPiAnswer,
      },
    ];
    const finalEvents = await waitForThreadMessages(
      actor,
      firstPi.threadId,
      (events) => {
        return eventBackedContents(events, repeatedPi.runId).some((event) => {
          return event.content === repeatedPiAnswer;
        });
      },
    );
    const allRunIds = new Set(
      visibleTurns.map((turn) => {
        return turn.runId;
      }),
    );
    expect(
      finalEvents.events
        .filter((event) => {
          return (
            event.runId !== undefined &&
            event.runId !== null &&
            allRunIds.has(event.runId) &&
            (event.eventType === "input.prompt" ||
              event.eventType === "output.message")
          );
        })
        .map((event) => {
          return {
            runId: event.runId,
            eventType: event.eventType,
            content: chatEventDisplayText(event),
          };
        }),
    ).toStrictEqual(
      visibleTurns.flatMap((turn) => {
        return [
          {
            runId: turn.runId,
            eventType: "input.prompt",
            content: turn.prompt,
          },
          {
            runId: turn.runId,
            eventType: "output.message",
            content: turn.answer,
          },
        ];
      }),
    );
    await expect(api.readRun(actor, firstPi.runId)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(api.readRun(actor, firstCodex.runId)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(api.readRun(actor, returnedPi.runId)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(api.readRun(actor, piFollowUp.runId)).resolves.toMatchObject({
      status: "cancelled",
    });
  }, 90_000);

  it("completes API-first output when transient stream publication fails", async () => {
    const { actor, agentId } = await entitledChatActor();
    await configureBuiltInPiModel(actor, "gpt-5.6-terra");
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: requireOrgId(actor) },
      { [FeatureSwitchKey.PiLoop]: true },
    );
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();
    const answer = "The complete answer survives the streaming outage";
    server.use(
      http.post("https://api.openai.com/v1/responses", () => {
        return new HttpResponse(piResponsesTextSse(answer, 1), {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
    const failedPublications: SessionOutputDelta[] = [];
    context.mocks.ably.publish.mockImplementation((_topic, payload) => {
      const chunk = sessionOutputDeltaSchema.safeParse(payload);
      if (chunk.success) {
        failedPublications.push(chunk.data);
        return Promise.reject(
          new Error("Session output transport unavailable"),
        );
      }
      return Promise.resolve(undefined);
    });

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "Finish the answer even if its live preview is unavailable",
      model: "gpt-5.6-terra",
    });
    await waitForRunStatus(actor, run.runId, "completed");
    const thread = await chat.listThreadEvents(actor, run.threadId);
    const messages = eventBackedContents(thread.events, run.runId);
    expect(messages).toStrictEqual([
      expect.objectContaining({ content: answer, sequenceNumber: 0 }),
    ]);
    expect(failedPublications).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: run.runId,
          eventId: messages[0]?.id,
          chunkIndex: 0,
          delta: answer,
        }),
      ]),
    );
    const reread = await chat.listThreadEvents(actor, run.threadId);
    expect(eventBackedContents(reread.events, run.runId)).toStrictEqual(
      messages,
    );
  });

  it("projects citation-free API-first blocks and durable private provenance", async () => {
    const { actor, agentId } = await entitledChatActor();
    if (!actor.orgId) {
      throw new Error("Expected entitled chat actor to have an org");
    }
    await configureBuiltInPiModel(actor, "gpt-5.6-terra");
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      { [FeatureSwitchKey.PiLoop]: true },
    );
    mockPiResourceArchiveDownloads();
    // A real assistant can copy the entire immutable archive notice. Its run
    // provenance must still keep citation transport private.
    const copiedArchiveNotice =
      "Okou Goal retired.\nGoal ID: 00000000-0000-4000-8000-000000000001\nOriginal recorded status: complete\nThe recorded status is preserved; retirement does not mark the objective complete.\n\nFull original objective:\nalpha";
    const consumedAgentEvents: Record<string, unknown>[] = [];
    server.use(
      http.post(
        "https://api.axiom.co/v1/datasets/agent-run-events/ingest",
        async ({ request }) => {
          const events: unknown = await request.json();
          if (!Array.isArray(events)) {
            throw new Error("Expected an Axiom event array");
          }
          consumedAgentEvents.push(
            ...events.filter((event): event is Record<string, unknown> => {
              return (
                typeof event === "object" &&
                event !== null &&
                !Array.isArray(event)
              );
            }),
          );
          return HttpResponse.json({
            ingested: events.length,
            failed: 0,
            processedBytes: 123,
          });
        },
      ),
      http.post("https://api.openai.com/v1/responses", () => {
        const hidden =
          "<oai-mem-citation><citation_entries>memory.md:2-3|note=[used]</citation_entries><rollout_ids>019c6e27-e55b-73d1-87d8-4e01f1f75043</rollout_ids></oai-mem-citation>";
        return new HttpResponse(
          piResponsesContentSse({
            blocks: [
              {
                type: "text",
                text: `${copiedArchiveNotice}${hidden.slice(0, 17)}`,
              },
              { type: "text", text: `${hidden.slice(17)}beta` },
              { type: "text", text: "gamma" },
              { type: "text", text: "delta" },
            ],
            sequence: 1,
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    mockPiCheckpointObjectStore();

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "preserve each complete API-first text block",
      model: "gpt-5.6-terra",
    });
    await waitForRunStatus(actor, run.runId, "completed");
    await flushWaitUntilForTest();

    const serializedAxiomEvents = JSON.stringify(consumedAgentEvents);
    expect(serializedAxiomEvents).not.toContain("oai-mem-citation");
    expect(serializedAxiomEvents).not.toContain("memory.md");
    // Private provenance intentionally has no user-facing API; this exact
    // event association is the only assertion that crosses the route boundary.
    await expect(
      readRunOutputMemoryCitationsFixture(run.runId),
    ).resolves.toStrictEqual([
      {
        sequenceNumber: 3,
        citation: {
          entries: [
            {
              path: "memory.md",
              lineStart: 2,
              lineEnd: 3,
              note: "used",
            },
          ],
          rolloutIds: ["019c6e27-e55b-73d1-87d8-4e01f1f75043"],
        },
      },
    ]);

    await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
      status: "completed",
    });
    expect(
      consumedAgentEvents
        .filter((event) => {
          return event.runId === run.runId;
        })
        .map((event) => {
          return {
            sequenceNumber: event.sequenceNumber,
            eventType: event.eventType,
          };
        }),
    ).toStrictEqual([
      { sequenceNumber: 0, eventType: "assistant" },
      { sequenceNumber: 1, eventType: "assistant" },
      { sequenceNumber: 2, eventType: "assistant" },
      { sequenceNumber: 3, eventType: "assistant" },
      { sequenceNumber: 4, eventType: "result" },
    ]);
    const thread = await chat.listThreadEvents(actor, run.threadId);
    expect(
      eventBackedContents(thread.events, run.runId).map((message) => {
        return {
          content: message.content,
          sequenceNumber: message.sequenceNumber,
          runEventId: message.runEventId,
        };
      }),
    ).toStrictEqual([
      {
        content: copiedArchiveNotice,
        sequenceNumber: 0,
        runEventId: expect.stringMatching(/^api-first:[0-9a-f-]{36}:0$/u),
      },
      {
        content: "beta",
        sequenceNumber: 1,
        runEventId: expect.stringMatching(/^api-first:[0-9a-f-]{36}:1$/u),
      },
      {
        content: "gamma",
        sequenceNumber: 2,
        runEventId: expect.stringMatching(/^api-first:[0-9a-f-]{36}:2$/u),
      },
      {
        content: "delta",
        sequenceNumber: 3,
        runEventId: expect.stringMatching(/^api-first:[0-9a-f-]{36}:3$/u),
      },
    ]);
  }, 90_000);

  it("transfers pre-provider active input through one stable sandbox-first delivery", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await publishPendingPiInstructions(actor, agentId);
    const resourceEntered = createDeferredPromise<void>(context.signal);
    const releaseResource = createDeferredPromise<void>(context.signal);
    server.use(
      http.get(PI_RESOURCE_ARCHIVE_DOWNLOAD_URL, async ({ request }) => {
        if (!resourceEntered.settled()) {
          resourceEntered.resolve(undefined);
        }
        await releaseResource.promise;
        const objectKey = new URL(request.url).searchParams.get("object");
        if (!objectKey) {
          throw new Error("Expected Pi resource archive object identity");
        }
        return new HttpResponse(piS3Object(objectKey), {
          headers: { "content-type": "application/gzip" },
        });
      }),
    );
    let modelCalls = 0;
    server.use(
      http.post("https://api.openai.com/v1/responses", () => {
        modelCalls += 1;
        return new HttpResponse(piResponsesTextSse("unexpected", modelCalls), {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
    const checkpointObjects = mockPiCheckpointObjectStore();
    const prompt = "execute the original prompt once in Sandbox";
    const { anchor, anchorClaim, run } = await queueCapabilityProvenPiRun({
      actor,
      agentId,
      runnerGroup,
      prompt,
    });

    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
    await resourceEntered.promise;
    // Speculative queued preparation can read resources before promotion; the
    // durable pending status is the Runner claim boundary.
    await waitForRunStatus(actor, run.runId, "pending", 5000);
    const claimed = await claimChatRun(runnerGroup, run.runId);
    await waitForRunStatus(actor, run.runId, "running", 5000);
    const activeInput = "apply this accepted steer once";
    const activeInputEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: run.threadId,
        prompt: activeInput,
        clientEventId: activeInputEventId,
      },
      [201],
    );
    const sandboxToken = claimed.claim.sandboxToken;
    const reserved = await api.reserveRunnerActiveInputs(
      sandboxToken,
      run.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected pre-provider active input to be reserved");
    }
    await expect(
      api.reserveRunnerActiveInputs(sandboxToken, run.runId),
    ).resolves.toStrictEqual(reserved);

    releaseResource.resolve(undefined);
    const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`;
    await expect
      .poll(() => {
        return checkpointObjects.get(manifestKey);
      })
      .toBeInstanceOf(Buffer);
    expect(modelCalls).toBe(0);
    await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
      status: "running",
    });
    const manifest = piApiFirstTurnManifestSchema.parse(
      JSON.parse(checkpointObjects.get(manifestKey)?.toString("utf8") ?? "{}"),
    );
    expect(manifest).toMatchObject({
      schemaVersion: 3,
      outcome: "ownership-transfer",
      mode: "sandbox-first",
      baseSession: { sessionId: run.threadId, sha256: null },
      sandboxEventSequenceStart: 1,
    });
    const h0 =
      checkpointObjects
        .get(
          `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/session.jsonl`,
        )
        ?.toString("utf8") ?? "";
    expect(
      MemoryPiSession.fromJsonl(h0).buildSessionContext().messages,
    ).toHaveLength(0);
    expect(claimed.claim.prompt).toBe(prompt);
    const receipts = await Promise.all([
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        run.runId,
        reserved.deliveryId,
      ),
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        run.runId,
        reserved.deliveryId,
      ),
    ]);
    expect(receipts).toStrictEqual([
      { outcome: "delivered" },
      { outcome: "delivered" },
    ]);
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        run.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });
    const events = await chat.listThreadEvents(actor, run.threadId);
    expect(
      events.events.filter((event) => {
        return (
          event.runId === run.runId &&
          event.revokesEventId === activeInputEventId
        );
      }),
    ).toHaveLength(1);
    await cancelChatRun(actor, run.runId, claimed.sandboxHeaders);
  }, 90_000);

  it("publishes text H1 once and continues one in-flight active input as a new prompt", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    mockPiResourceArchiveDownloads();
    const providerEntered = createDeferredPromise<void>(context.signal);
    const releaseProvider = createDeferredPromise<void>(context.signal);
    let modelCalls = 0;
    const apiAnswer = "API H1 settled before the accepted input";
    server.use(
      http.post("https://api.openai.com/v1/responses", async () => {
        modelCalls += 1;
        if (!providerEntered.settled()) {
          providerEntered.resolve(undefined);
        }
        await releaseProvider.promise;
        return new HttpResponse(piResponsesTextSse(apiAnswer, modelCalls), {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
    const checkpointObjects = mockPiCheckpointObjectStore();
    const originalPrompt = "settle this original API prompt once";
    const { anchor, anchorClaim, run } = await queueCapabilityProvenPiRun({
      actor,
      agentId,
      runnerGroup,
      prompt: originalPrompt,
    });

    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
    await providerEntered.promise;
    const claimed = await claimChatRun(runnerGroup, run.runId);
    const activeInput = "continue H1 with exactly one new prompt";
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: run.threadId,
        prompt: activeInput,
        clientEventId: randomUUID(),
      },
      [201],
    );
    const sandboxToken = claimed.claim.sandboxToken;
    const reserved = await api.reserveRunnerActiveInputs(
      sandboxToken,
      run.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected in-flight active input to be reserved");
    }
    releaseProvider.resolve(undefined);

    const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`;
    await expect
      .poll(() => {
        return checkpointObjects.get(manifestKey);
      })
      .toBeInstanceOf(Buffer);
    expect(modelCalls).toBe(1);
    await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
      status: "running",
    });
    const manifest = piApiFirstTurnManifestSchema.parse(
      JSON.parse(checkpointObjects.get(manifestKey)?.toString("utf8") ?? "{}"),
    );
    expect(manifest).toMatchObject({
      schemaVersion: 3,
      outcome: "ownership-transfer",
      mode: "settled-session-continuation",
      sandboxEventSequenceStart: 1,
    });
    const apiMessages = eventBackedContents(
      (await chat.listThreadEvents(actor, run.threadId)).events,
      run.runId,
    );
    expect(
      apiMessages.filter((message) => {
        return message.content === apiAnswer;
      }),
    ).toHaveLength(1);

    const h1 =
      checkpointObjects
        .get(
          `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/session.jsonl`,
        )
        ?.toString("utf8") ?? "";
    expect(occurrences(h1, originalPrompt)).toBe(1);
    expect(occurrences(h1, apiAnswer)).toBe(1);
    expect(occurrences(h1, activeInput)).toBe(0);
    const h2Session = MemoryPiSession.fromJsonl(h1);
    h2Session.appendMessage({
      role: "user",
      content: activeInput,
      timestamp: 3,
    });
    const sandboxAnswer = "Sandbox answered the accepted prompt once";
    const hiddenCitation =
      "<oai-mem-citation><citation_entries>memory.md:5-8|note=[sandbox used]</citation_entries><rollout_ids>019c6e27-e55b-73d1-87d8-4e01f1f75043</rollout_ids></oai-mem-citation>";
    const sandboxRawAnswer = `${sandboxAnswer}${hiddenCitation}`;
    h2Session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: sandboxRawAnswer }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.6-terra",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 4,
    });
    const h2 = h2Session.toJsonl();
    expect(occurrences(h2, originalPrompt)).toBe(1);
    expect(occurrences(h2, activeInput)).toBe(1);
    expect(occurrences(h2, hiddenCitation)).toBe(1);
    const h2Hash = createHash("sha256").update(h2).digest("hex");
    await webhooks.requestAgentCheckpointPrepareHistory(
      {
        runId: run.runId,
        hash: h2Hash,
        rawSize: Buffer.byteLength(h2),
        encodedSize: Buffer.byteLength(h2),
        encoding: "identity",
      },
      claimed.sandboxHeaders,
      [200],
    );
    checkpointObjects.set(
      `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${h2Hash}.blob`,
      Buffer.from(h2, "utf8"),
    );
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        run.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });
    const sandboxCitation = {
      entries: [
        {
          path: "memory.md",
          note: "sandbox used",
          lineStart: 5,
          lineEnd: 8,
        },
      ],
      rolloutIds: ["019c6e27-e55b-73d1-87d8-4e01f1f75043"],
    };
    const sandboxEvents = [
      {
        type: "assistant" as const,
        sequenceNumber: 1,
        message: {
          id: "new-guest-visible-answer",
          content: [{ type: "text" as const, text: sandboxAnswer }],
        },
      },
      {
        type: "result" as const,
        sequenceNumber: 2,
        result: sandboxAnswer,
      },
    ];
    const sandboxEventBody = {
      runId: run.runId,
      events: sandboxEvents,
      piMemoryCitationTransport: {
        schemaVersion: 1 as const,
        citations: [{ sequenceNumber: 1, citation: sandboxCitation }],
      },
    };
    await webhooks.requestAgentEvents(
      sandboxEventBody,
      claimed.sandboxHeaders,
      [200],
    );
    await webhooks.requestAgentEvents(
      sandboxEventBody,
      claimed.sandboxHeaders,
      [200],
    );
    const completion = await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 0,
        lastEventSequence: 2,
        activeInputDeliveryIds: [reserved.deliveryId],
        checkpoint: {
          cliAgentType: "pi",
          cliAgentSessionId: run.threadId,
          cliAgentSessionHistoryHash: h2Hash,
        },
      },
      claimed.sandboxHeaders,
      [200],
    );
    expect(completion.body).toStrictEqual({
      success: true,
      status: "completed",
    });
    await waitForRunStatus(actor, run.runId, "completed", 5000);
    expect(modelCalls).toBe(1);
    const completedMessages = eventBackedContents(
      (await chat.listThreadEvents(actor, run.threadId)).events,
      run.runId,
    );
    expect(
      completedMessages.filter((message) => {
        return message.content === sandboxAnswer;
      }),
    ).toHaveLength(1);
    expect(JSON.stringify(completedMessages)).not.toContain("oai-mem-citation");
    expect(JSON.stringify(completedMessages)).not.toContain("memory.md");
    // Private provenance intentionally has no user-facing API; this exact
    // event association is the only assertion that crosses the route boundary.
    await expect(
      readRunOutputMemoryCitationsFixture(run.runId),
    ).resolves.toStrictEqual([
      {
        sequenceNumber: 1,
        citation: {
          entries: sandboxCitation.entries,
          rolloutIds: sandboxCitation.rolloutIds,
        },
      },
    ]);
  }, 90_000);

  it("retains pending-tool continuation while one accepted input remains a steer", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    mockPiResourceArchiveDownloads();
    const providerEntered = createDeferredPromise<void>(context.signal);
    const releaseProvider = createDeferredPromise<void>(context.signal);
    let modelCalls = 0;
    server.use(
      http.post("https://api.openai.com/v1/responses", async () => {
        modelCalls += 1;
        if (!providerEntered.settled()) {
          providerEntered.resolve(undefined);
        }
        await releaseProvider.promise;
        return new HttpResponse(
          piResponsesToolSse({
            callId: "call_active_input_tool",
            name: "read",
            arguments: { path: "/home/user/workspace/***/pending.txt" },
            sequence: modelCalls,
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const checkpointObjects = mockPiCheckpointObjectStore();
    const originalPrompt = "start one provider request with a pending tool";
    const { anchor, anchorClaim, run } = await queueCapabilityProvenPiRun({
      actor,
      agentId,
      runnerGroup,
      prompt: originalPrompt,
    });

    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
    await providerEntered.promise;
    const claimed = await claimChatRun(runnerGroup, run.runId);
    const activeInput = "steer once after the pending tool boundary";
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: run.threadId,
        prompt: activeInput,
        clientEventId: randomUUID(),
      },
      [201],
    );
    const sandboxToken = claimed.claim.sandboxToken;
    const reserved = await api.reserveRunnerActiveInputs(
      sandboxToken,
      run.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected pending-tool active input to be reserved");
    }
    releaseProvider.resolve(undefined);

    const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`;
    await expect
      .poll(() => {
        return checkpointObjects.get(manifestKey);
      })
      .toBeInstanceOf(Buffer);
    const manifest = piApiFirstTurnManifestSchema.parse(
      JSON.parse(checkpointObjects.get(manifestKey)?.toString("utf8") ?? "{}"),
    );
    expect(manifest).toMatchObject({
      schemaVersion: 3,
      outcome: "ownership-transfer",
      mode: "pending-tool-continuation",
      sandboxEventSequenceStart: 1,
    });
    expect(modelCalls).toBe(1);
    await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
      status: "running",
    });
    const h1 =
      checkpointObjects
        .get(
          `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/session.jsonl`,
        )
        ?.toString("utf8") ?? "";
    const h2Session = MemoryPiSession.fromJsonl(h1);
    expect(h2Session.hasPendingToolCalls()).toBeTruthy();
    expect(occurrences(h1, originalPrompt)).toBe(1);
    expect(occurrences(h1, activeInput)).toBe(0);
    const pendingTool = [...h2Session.buildSessionContext().messages]
      .reverse()
      .find((message) => {
        return message.role === "assistant";
      });
    const toolCall =
      pendingTool?.role === "assistant"
        ? pendingTool.content.find((content) => {
            return content.type === "toolCall";
          })
        : undefined;
    if (toolCall?.type !== "toolCall") {
      throw new Error("Expected one pending Pi tool call");
    }
    h2Session.appendMessage({
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [{ type: "text", text: "Sandbox resumed the pending tool" }],
      details: {},
      isError: false,
      timestamp: 3,
    });
    h2Session.appendMessage({
      role: "user",
      content: activeInput,
      timestamp: 4,
    });
    h2Session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Sandbox applied the steer once" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.6-terra",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 5,
    });
    const h2 = h2Session.toJsonl();
    expect(occurrences(h2, originalPrompt)).toBe(1);
    expect(occurrences(h2, activeInput)).toBe(1);
    expect(MemoryPiSession.fromJsonl(h2).hasPendingToolCalls()).toBeFalsy();
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        run.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });
    await cancelChatRun(actor, run.runId, claimed.sandboxHeaders);
    expect(modelCalls).toBe(1);
  }, 90_000);
});
