import { randomUUID } from "node:crypto";
import { orgOpenrouterPresetContract } from "@okouai/api-contracts/contracts/org-openrouter-preset";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { orgOpenrouterPresetRoutes } from "../org-openrouter-preset";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { publicChatActor } from "./helpers/public-chat-actor";
import { readCompletedRunSessionId } from "./helpers/public-run-session";

const context = testContext();
const {
  api,
  bdd,
  chat,
  mockPiObjectStore,
  mockPiResourceArchiveDownloads,
  completeSandboxFirstPiRun,
} = createChatEventsFixture(context);

describe("Auto native routing", () => {
  it("rejects an Auto Run when its workspace preset is missing prices", async () => {
    const orgId = `org_${randomUUID()}`;
    const actor = bdd.user({ orgId, orgRole: "org:admin" });
    const owner = await publicChatActor(context, { actor });
    owner.ownsFeatureSwitches();
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      {
        [FeatureSwitchKey.OkouDebug]: true,
      },
    );
    const presets = setupApp({ context, routes: orgOpenrouterPresetRoutes })(
      orgOpenrouterPresetContract,
    );
    await accept(
      presets.update({
        headers: { authorization: "Bearer clerk-session" },
        body: { openrouterPreset: "@preset/okou-experimental" },
      }),
      [200],
    );

    const clientEventId = randomUUID();
    const sent = await owner.requestSendEvent(
      actor,
      { prompt: "start with Auto", model: "auto", clientEventId },
      [201],
    );
    if (sent.status !== 201) {
      throw new Error("Expected the Auto input to be queued");
    }
    await flushWaitUntilForTest();
    const { events } = await chat.listThreadEvents(actor, sent.body.threadId);
    expect(events).toContainEqual(
      expect.objectContaining({
        eventType: "input.rejected",
        revokesEventId: clientEventId,
        error: "model_provider_unavailable",
      }),
    );
  });

  it("claims the OpenRouter preset for a completed initial run and its successor", async () => {
    const {
      actor,
      run: own,
      sendChatRun,
      runExecution,
    } = await publicChatActor(context);
    mockPiResourceArchiveDownloads();
    const historyObjects = mockPiObjectStore();
    const preset = "@preset/okou-1-0";
    const expectedExecution = {
      cliAgentType: "pi",
      piModelConfig: {
        baseUrl: "https://openrouter.ai/api/v1",
        model: preset,
      },
      modelUsageProvider: preset,
    };
    const expectedSource = {
      providerType: "built-in",
      runtimeProviderType: "openrouter-codex",
      model: "auto",
      credentialScope: "org",
    };

    const initialPrompt = "start with Auto";
    const initial = await sendChatRun(actor, {
      prompt: initialPrompt,
      model: "auto",
    });
    await flushWaitUntilForTest();
    const initialExecution = await runExecution(initial.runId);
    expect(initialExecution.execution).toMatchObject(expectedExecution);
    await own(async () => {
      return await completeSandboxFirstPiRun({
        actor,
        run: initial,
        execution: initialExecution,
        historyObjects,
        prompt: initialPrompt,
        answer: "initial Auto answer",
        responsesModel: { provider: "openrouter", model: preset },
      });
    });
    await expect(api.readRun(actor, initial.runId)).resolves.toMatchObject({
      status: "completed",
      source: expectedSource,
    });
    const initialSession = await readCompletedRunSessionId(
      context,
      actor,
      initial.runId,
    );

    const successorPrompt = "continue without selecting another model";
    const successor = await sendChatRun(actor, {
      threadId: initial.threadId,
      prompt: successorPrompt,
    });
    expect(successor.runId).not.toBe(initial.runId);
    expect(successor.threadId).toBe(initial.threadId);
    await flushWaitUntilForTest();
    const successorExecution = await runExecution(successor.runId);
    expect(successorExecution.execution).toMatchObject(expectedExecution);
    await own(async () => {
      return await completeSandboxFirstPiRun({
        actor,
        run: successor,
        execution: successorExecution,
        historyObjects,
        prompt: successorPrompt,
        answer: "continued Auto answer",
        responsesModel: { provider: "openrouter", model: preset },
      });
    });
    await expect(api.readRun(actor, successor.runId)).resolves.toMatchObject({
      status: "completed",
      source: expectedSource,
    });
    await expect(
      readCompletedRunSessionId(context, actor, successor.runId),
    ).resolves.toBe(initialSession);
  }, 90_000);
});
