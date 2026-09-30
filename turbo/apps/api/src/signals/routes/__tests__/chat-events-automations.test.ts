import {
  expectThreadModelCredits,
  readThreadModelCredits,
} from "./helpers/public-thread-usage";
import { readCompletedRunSessionId } from "./helpers/public-run-session";
import { randomUUID } from "node:crypto";
import { isChatRunTerminalEventType } from "@okouai/api-contracts/contracts/chat-events";
import { testWorkflowAutomationExecutionContract } from "@okouai/api-contracts/contracts/test-workflow-automation-execution";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { loadPiCatalogModelFixture } from "../../../test-fixtures/model-catalog";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { testWorkflowAutomationExecutionRoutes } from "../test-workflow-automation-execution";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  createChatEventsFixture,
  requireOrgId,
  createPiUsagePricingResolution,
} from "./helpers/chat-events-fixture";

const context = testContext();
const {
  api,
  chat,
  webhooks,
  entitledChatActor,
  seedBuiltInModelKey,
  configureBuiltInPiModel,
  configureSubscriptionPiModel,
  sendChatRun,
  claimChatRun,
  completeChatRunOk,
  failChatRun,
  cancelChatRun,
  sessionHeaders,
  upsertOrgModelProvider,
  threadPiAutomationsClient,
  postThreadPiAutomationEvent,
  lastThreadPiAutomationRun,
  expectThreadPiTerminal,
  claimGptPiSandbox,
  mockPiCheckpointObjectStore,
  mockPiResourceArchiveDownloads,
  completeSandboxFirstPiRun,
} = createChatEventsFixture(context);

async function builtInCatalogUpstreamModel(model: string): Promise<string> {
  const upstreamModel = (await loadPiCatalogModelFixture(model))?.builtIn[0]
    ?.upstreamModel;
  if (upstreamModel === undefined) {
    throw new Error(`Expected a Built-in catalog route for ${model}`);
  }
  return upstreamModel;
}

describe("thread-bound Pi Automation execution", () => {
  it.each(
    (["gpt-6-luna", "deepseek-v4.1-flash"] as const).flatMap(
      (selectedModel) => {
        return (["schedule", "event"] as const).map((source) => {
          return { source, selectedModel };
        });
      },
    ),
  )(
    "rotates the $source $selectedModel Automation session into Pi and learns only from its user turns",
    async ({ source, selectedModel }) => {
      const { actor, agentId, runnerGroup, providerId } =
        await entitledChatActor({}, source === "event" ? "team" : "pro");
      const orgId = requireOrgId(actor);
      const usagePricingResolution =
        await createPiUsagePricingResolution(selectedModel);
      const workflows = createWorkflowsBddApi(context);
      const workflowId = await workflows.createWorkflow(actor, {
        agentId,
        name: `pi-source-${source}`,
      });
      if (source === "schedule") {
        await seedBuiltInModelKey("gpt-6-astra");
        await api.updateOrgModelPolicies(actor, [
          {
            model: "gpt-6-astra",
            preferred: true,
            defaultProviderType: "built-in",
            credentialScope: "org",
            modelProviderId: null,
          },
        ]);
      } else {
        await api.updateOrgModelPolicies(actor, [
          {
            model: "claude-fable-5-1",
            preferred: true,
            defaultProviderType: "anthropic-api-key",
            credentialScope: "org",
            modelProviderId: providerId,
          },
        ]);
      }

      const created = await accept(
        threadPiAutomationsClient().create({
          headers: sessionHeaders(actor),
          params: { workflowId },
          body:
            source === "schedule"
              ? { schedule: { type: "loop", intervalSeconds: 3600 } }
              : { kind: "event", eventType: "webhook-received" },
        }),
        [201],
      );
      const automation = created.body;
      const eventRoute =
        automation.kind === "event" &&
        automation.eventType === "webhook-received" &&
        automation.webhookUrl &&
        automation.webhookSecret
          ? {
              webhookUrl: automation.webhookUrl,
              webhookSecret: automation.webhookSecret,
            }
          : null;
      let threadId: string;
      if (eventRoute) {
        await postThreadPiAutomationEvent({
          ...eventRoute,
          payload: "legacy",
          timestamp: Math.floor(now() / 1000),
          usagePricingResolution,
        });
        if (!automation.chatThreadId) {
          throw new Error("Expected the event thread");
        }
        threadId = automation.chatThreadId;
      } else {
        const started = await accept(
          threadPiAutomationsClient().run({
            headers: sessionHeaders(actor),
            params: { id: automation.id },
          }),
          [201],
        );
        threadId = started.body.chatThreadId;
      }
      const legacyRunId = await lastThreadPiAutomationRun(actor, threadId);
      const legacyClaim = await claimChatRun(runnerGroup, legacyRunId);
      const legacyFramework = source === "schedule" ? "codex" : "claude-code";
      await completeChatRunOk(legacyRunId, legacyClaim.sandboxHeaders, {
        cliAgentType: legacyFramework,
      });
      await flushWaitUntilForTest();
      const legacySessionId = await readCompletedRunSessionId(
        context,
        actor,
        legacyRunId,
      );

      await configureBuiltInPiModel(actor, selectedModel);
      await chat.updateThreadModelSelection(actor, threadId, selectedModel);
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        {
          [FeatureSwitchKey.PiMemory]: true,
        },
      );

      mockPiResourceArchiveDownloads();
      const checkpointObjects = mockPiCheckpointObjectStore();
      if (eventRoute) {
        const event = {
          ...eventRoute,
          payload: "pi-event",
          timestamp: Math.floor(now() / 1000),
          usagePricingResolution,
        };
        await expect(postThreadPiAutomationEvent(event)).resolves.toMatchObject(
          {
            duplicate: false,
          },
        );
        // A retry keeps the original signed envelope across clock seconds.
        mockNow(now() + 1000);
        await expect(postThreadPiAutomationEvent(event)).resolves.toMatchObject(
          {
            duplicate: true,
          },
        );
      } else {
        const scheduled = await workflows.readAutomation(automation.id);
        if (!scheduled.nextRunAt) {
          throw new Error("Expected preserved recurrence");
        }
        mockNow(Date.parse(scheduled.nextRunAt) + 1000);
        await accept(
          setupApp({
            context,
            routes: testWorkflowAutomationExecutionRoutes,
            usagePricingResolution,
          })(testWorkflowAutomationExecutionContract).execute({
            body: { automation_id: automation.id },
          }),
          [200],
        );
      }
      const piRunId = await lastThreadPiAutomationRun(actor, threadId);
      expect(piRunId).not.toBe(legacyRunId);
      // Workflow slash input intentionally enters native AgentSession in the
      // Sandbox. Exercise the real runner claim/checkpoint/completion protocol.
      await flushWaitUntilForTest();
      const piClaim = await claimChatRun(runnerGroup, piRunId);
      expect(piClaim.claim).toMatchObject({
        piModelConfig: {
          model: await builtInCatalogUpstreamModel(selectedModel),
        },
      });
      const sandboxUsage = {
        idempotencyKey: randomUUID(),
        kind: "model" as const,
        provider: selectedModel,
        category: "tokens.output",
        quantity: 3,
      };
      let creditsAfterFirstReceipt: number | undefined;
      for (const _receipt of [1, 2]) {
        await webhooks.requestAgentUsageEvent(
          { runId: piRunId, events: [sandboxUsage] },
          piClaim.sandboxHeaders,
          [200],
          usagePricingResolution,
        );
        const credits = await readThreadModelCredits(context, actor, threadId);
        if (creditsAfterFirstReceipt === undefined) {
          expect(credits).toBeGreaterThan(0);
          creditsAfterFirstReceipt = credits;
        } else {
          expect(credits).toBe(creditsAfterFirstReceipt);
        }
      }
      await completeSandboxFirstPiRun({
        actor,
        run: { runId: piRunId, threadId },
        claim: piClaim,
        checkpointObjects,
        prompt: piClaim.claim.prompt,
        answer: `owned ${source} answer`,
        outputTokens: 3,
        responsesModel: {
          provider:
            selectedModel === "deepseek-v4.1-flash" ? "deepseek" : "openai",
          model: await builtInCatalogUpstreamModel(selectedModel),
        },
        usagePricingResolution,
      });
      await expectThreadPiTerminal(actor, threadId, piRunId);
      const piSessionId = await readCompletedRunSessionId(
        context,
        actor,
        piRunId,
      );
      expect(piSessionId).toBe(legacySessionId);
      if (creditsAfterFirstReceipt === undefined) {
        throw new Error("Expected the first public model charge");
      }
      await expectThreadModelCredits(
        context,
        actor,
        threadId,
        creditsAfterFirstReceipt,
      );
      await accept(
        setupApp({ context, routes: testWorkflowAutomationExecutionRoutes })(
          testWorkflowAutomationExecutionContract,
        ).dispatchCallbacks({
          body: { run_id: piRunId, status: "completed", dispatch_count: 2 },
        }),
        [200],
      );
      await expectThreadPiTerminal(actor, threadId, piRunId);

      mockNow(now() + 1000);
      const user = await sendChatRun(
        actor,
        { agentId, threadId, prompt: "continue this Automation conversation" },
        usagePricingResolution,
      );
      await flushWaitUntilForTest();
      const userClaim = await claimChatRun(runnerGroup, user.runId);
      expect(userClaim.claim.piModelConfig).toMatchObject({
        model: await builtInCatalogUpstreamModel(selectedModel),
      });
      await completeSandboxFirstPiRun({
        actor,
        run: user,
        claim: userClaim,
        checkpointObjects,
        prompt: "continue this Automation conversation",
        answer: `owned user answer for ${source}`,
        outputTokens: 3,
        responsesModel: {
          provider:
            selectedModel === "deepseek-v4.1-flash" ? "deepseek" : "openai",
          model: await builtInCatalogUpstreamModel(selectedModel),
        },
        usagePricingResolution,
      });
      await expectThreadPiTerminal(actor, threadId, user.runId);
      await expect(
        readCompletedRunSessionId(context, actor, user.runId),
      ).resolves.toBe(piSessionId);
      clearMockNow();
    },
    90_000,
  );
});

describe("CHAT effort: automation launches", () => {
  async function startAutomation() {
    const scenario = await entitledChatActor({}, "pro");
    const { actor, agentId, runnerGroup, providerId } = scenario;
    // Fable keeps the automation on the Claude Code Runner claim protocol;
    // the Sonnet fixture default would launch a Pi run instead.
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-fable-5-1",
        preferred: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);
    const workflowId = await createWorkflowsBddApi(context).createWorkflow(
      actor,
      { agentId, name: "native-effort" },
    );
    const created = await accept(
      threadPiAutomationsClient().create({
        headers: sessionHeaders(actor),
        params: { workflowId },
        body: { schedule: { type: "loop", intervalSeconds: 3600 } },
      }),
      [201],
    );
    const started = await accept(
      threadPiAutomationsClient().run({
        headers: sessionHeaders(actor),
        params: { id: created.body.id },
      }),
      [201],
    );
    const threadId = started.body.chatThreadId;
    const runId = await lastThreadPiAutomationRun(actor, threadId);
    const claimed = await claimChatRun(runnerGroup, runId);
    // No saved thread effort yet: the launch uses Fable's route default.
    expect(claimed.claim.platformEnvironment.OKOU_REASONING_EFFORT).toBe("max");
    return {
      ...scenario,
      threadId,
      runId,
      claimed,
      automationId: created.body.id,
    };
  }

  it("captures automation effort at enqueue and applies edits to later triggers", async () => {
    const { actor, runnerGroup, threadId, runId, claimed, automationId } =
      await startAutomation();
    await chat.updateThreadModelSelection(actor, threadId, "claude-fable-5-1", {
      reasoningEffort: "extra",
    });
    const queued = await accept(
      threadPiAutomationsClient().run({
        headers: sessionHeaders(actor),
        params: { id: automationId },
      }),
      [201],
    );
    expect(queued.body.runId).toBeNull();
    await chat.updateThreadModelSelection(actor, threadId, "claude-fable-5-1", {
      reasoningEffort: "high",
    });
    await completeChatRunOk(runId, claimed.sandboxHeaders, {
      cliAgentType: "claude-code",
    });
    await flushWaitUntilForTest();
    const nextRunId = await lastThreadPiAutomationRun(actor, threadId);
    expect(nextRunId).not.toBe(runId);
    const next = await claimChatRun(runnerGroup, nextRunId);
    expect(next.claim.platformEnvironment.OKOU_REASONING_EFFORT).toBe("extra");
    await expect(
      chat.readThreadMetadata(actor, threadId),
    ).resolves.toMatchObject({
      modelSettings: { "claude-fable-5-1": { effort: "high" } },
    });
    await cancelChatRun(actor, nextRunId, next.sandboxHeaders);

    // The edit applies to a newly enqueued trigger, not the prior queued input.
    await accept(
      threadPiAutomationsClient().run({
        headers: sessionHeaders(actor),
        params: { id: automationId },
      }),
      [201],
    );
    const latestRunId = await lastThreadPiAutomationRun(actor, threadId);
    expect(latestRunId).not.toBe(nextRunId);
    const latest = await claimChatRun(runnerGroup, latestRunId);
    expect(latest.claim.platformEnvironment.OKOU_REASONING_EFFORT).toBe("high");
    await cancelChatRun(actor, latestRunId, latest.sandboxHeaders);
  }, 90_000);

  it("uses route defaults for unsupported effort at automation launch", async () => {
    const { actor, runnerGroup, threadId, runId, claimed, automationId } =
      await startAutomation();
    await completeChatRunOk(runId, claimed.sandboxHeaders, {
      cliAgentType: "claude-code",
    });
    await flushWaitUntilForTest();
    let previousRunId = runId;
    for (const route of [
      {
        model: "claude-fable-5-1",
        effort: "ultracode",
        pi: false,
        providerType: "anthropic-api-key",
        effectiveEffort: "max",
      },
      {
        model: "gpt-5.6-sol",
        effort: "high",
        pi: true,
        providerType: "openai-api-key",
        effectiveEffort: "high",
      },
    ] as const) {
      const { providerId } = await upsertOrgModelProvider(actor, {
        type: route.providerType,
        secret: "test-workflow-effort-key",
      });
      await api.updateOrgModelPolicies(actor, [
        {
          model: route.model,
          preferred: true,
          defaultProviderType: route.providerType,
          credentialScope: "org",
          modelProviderId: providerId,
        },
      ]);
      await chat.updateThreadModelSelection(actor, threadId, route.model, {
        reasoningEffort: route.effort,
      });
      if (route.pi) {
        mockPiCheckpointObjectStore();
      }
      const started = await accept(
        threadPiAutomationsClient().run({
          headers: sessionHeaders(actor),
          params: { id: automationId },
        }),
        [201],
      );
      expect(started.body.runId).toBeNull();
      const startedRunId = await lastThreadPiAutomationRun(actor, threadId);
      expect(startedRunId).not.toBe(previousRunId);
      previousRunId = startedRunId;
      const next = await claimChatRun(runnerGroup, startedRunId);
      expect(next.claim.platformEnvironment.OKOU_REASONING_EFFORT).toBe(
        route.effectiveEffort,
      );
      if (route.pi) {
        expect(next.claim.piModelConfig).toMatchObject({
          thinkingLevel: route.effectiveEffort,
        });
      }
      await expect(
        chat.readThreadMetadata(actor, threadId),
      ).resolves.toMatchObject({
        modelSettings: { [route.model]: { effort: route.effort } },
      });
      await cancelChatRun(actor, startedRunId, next.sandboxHeaders);
    }
  }, 90_000);
});

describe("thread-bound Pi terminal failures", () => {
  it.each([{ status: "failed" }, { status: "cancelled" }] as const)(
    "settles a user-owned automation $status once without Built-in charges",
    async ({ status }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      await configureSubscriptionPiModel(
        actor,
        { accountId: "terminal-owner" },
        "gpt-5.6-luna",
      );
      mockPiResourceArchiveDownloads();
      mockPiCheckpointObjectStore();
      let run: { readonly runId: string; readonly threadId: string };
      {
        const workflowId = await createWorkflowsBddApi(context).createWorkflow(
          actor,
          { agentId, name: "pi-terminal" },
        );
        const created = await accept(
          threadPiAutomationsClient().create({
            headers: sessionHeaders(actor),
            params: { workflowId },
            body: { schedule: { type: "loop", intervalSeconds: 3600 } },
          }),
          [201],
        );
        const started = await accept(
          threadPiAutomationsClient().run({
            headers: sessionHeaders(actor),
            params: { id: created.body.id },
          }),
          [201],
        );
        const threadId = started.body.chatThreadId;
        const runId = await lastThreadPiAutomationRun(actor, threadId);
        run = { runId, threadId };
        await flushWaitUntilForTest();
        await api.heartbeatRunner(runnerGroup);
        const claim = await claimGptPiSandbox(actor, runId, undefined);
        const claimed = {
          claim,
          sandboxHeaders: { authorization: `Bearer ${claim.sandboxToken}` },
        };
        expect(claimed.claim.piModelConfig).toMatchObject({
          model: "gpt-5.6-luna",
        });
        if (status === "cancelled") {
          await cancelChatRun(actor, runId, claimed.sandboxHeaders);
        } else {
          await failChatRun(
            runId,
            claimed.sandboxHeaders,
            "subscription rejected",
          );
        }
        await failChatRun(
          runId,
          claimed.sandboxHeaders,
          "duplicate terminal delivery",
        );
      }
      await flushWaitUntilForTest();
      await accept(
        setupApp({ context, routes: testWorkflowAutomationExecutionRoutes })(
          testWorkflowAutomationExecutionContract,
        ).dispatchCallbacks({
          body: {
            run_id: run.runId,
            status: "failed",
            error:
              status === "cancelled"
                ? "Run cancelled"
                : "subscription rejected",
            dispatch_count: 2,
          },
        }),
        [200],
      );
      await flushWaitUntilForTest();

      await expectThreadModelCredits(context, actor, run.threadId, 0);
      const events = (await chat.listThreadEvents(actor, run.threadId)).events;
      expect(
        events
          .filter((event) => {
            return (
              event.runId === run.runId &&
              isChatRunTerminalEventType(event.eventType)
            );
          })
          .map((event) => {
            return event.eventType;
          }),
      ).toStrictEqual([`run.${status}`]);
    },
    90_000,
  );
});
