import { randomUUID } from "node:crypto";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import {
  isPresentationPreferenceContext,
  presentationPreferenceContextPart,
  readPresentationPreferenceContext,
} from "@okouai/api-contracts/contracts/presentation-preference-context";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { featureSwitchesRoutes } from "../feature-switches";
import { chatEventDisplayText } from "./helpers/chat-event";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const {
  api,
  chat,
  misc,
  entitledNativeChatActor,
  sendChatRun,
  queueChatRun,
  runExecution,
  completeChatRunOk,
  waitForRunStatus,
  cancelAndCompleteChatRun,
} = createChatEventsFixture(context);

type ChatActor = Parameters<typeof sendChatRun>[0];
type PresentationFormat = "html" | "pptx";

async function setPresentationPreferenceEnabled(
  actor: ChatActor,
  enabled: boolean,
) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  const response = await accept(
    setupApp({ context, routes: featureSwitchesRoutes })(
      featureSwitchesContract,
    ).update({
      headers: { authorization: "Bearer clerk-session" },
      body: {
        switches: { [FeatureSwitchKey.PresentationOutputFormat]: enabled },
      },
    }),
    [200],
  );
  expect(response.body.effectiveSwitches).toMatchObject({
    [FeatureSwitchKey.PresentationOutputFormat]: enabled,
  });
}

async function savePresentationPreference(
  actor: ChatActor,
  presentationFormat: PresentationFormat,
) {
  const response = await misc.updatePreferences(
    actor,
    { presentationFormat },
    [200],
  );
  expect(response.body.presentationFormat).toBe(presentationFormat);
}

async function presentationActor(format?: PresentationFormat) {
  const { actor } = await entitledNativeChatActor();
  await setPresentationPreferenceEnabled(actor, true);
  if (format !== undefined) {
    await savePresentationPreference(actor, format);
  }
  return actor;
}

async function acceptedInput(
  actor: ChatActor,
  threadId: string,
  clientEventId: string,
) {
  const { events } = await chat.listThreadEvents(actor, threadId);
  const event = events.find((candidate) => {
    return candidate.id === clientEventId;
  });
  if (event?.eventType !== "input.prompt") {
    throw new Error("Expected the accepted input in the public event stream");
  }
  return event;
}

function expectExecutionPreference(prompt: string, format: PresentationFormat) {
  expect(prompt).toContain("# Presentation Output Preference");
  expect(prompt).toContain(format.toUpperCase());
  expect(prompt).not.toContain("Okou presentation preference v1:");
}

describe("accepted chat input presentation preference snapshots", () => {
  it("captures a saved PPTX default for an untagged input without changing visible text", async () => {
    const actor = await presentationActor("pptx");
    const clientEventId = randomUUID();
    const prompt = "Prepare a quarterly presentation";
    const run = await sendChatRun(actor, { clientEventId, prompt });

    const input = await acceptedInput(actor, run.threadId, clientEventId);
    expect(readPresentationPreferenceContext(input.userMessage)).toStrictEqual({
      format: "pptx",
    });
    expect(chatEventDisplayText(input)).toBe(prompt);
    const execution = await api.executionInput(run.runId);
    expectExecutionPreference(execution.prompt, "pptx");
    expect(execution.prompt).toContain(prompt);
    await cancelAndCompleteChatRun(actor, run.runId);
  });

  it("resolves style-only templates from the input default while preserving explicit feedback formats and stored selections", async () => {
    const actor = await presentationActor("pptx");
    const item = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    const styleOnly = {
      type: "template" as const,
      titleSnapshot: item.title,
      template: {
        type: "presentation" as const,
        selection: {
          templateId: item.templateId,
          colorSystemId: item.colorSystemId,
        },
      },
    };
    const clientEventId = randomUUID();
    const run = await sendChatRun(actor, {
      clientEventId,
      prompt: "Use the selected styles for these two presentations",
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text: "Prepare the first presentation with " },
          styleOnly,
          {
            type: "feedback",
            quote: "The second presentation needs a web version",
            note: [
              { type: "text", text: "Prepare that presentation with " },
              {
                ...styleOnly,
                template: {
                  ...styleOnly.template,
                  selection: {
                    ...styleOnly.template.selection,
                    outputFormat: "html",
                  },
                },
              },
            ],
          },
        ],
      },
    });
    const input = await acceptedInput(actor, run.threadId, clientEventId);
    expect(input.userMessage.parts).toContainEqual(styleOnly);
    const execution = await api.executionInput(run.runId);
    expectExecutionPreference(execution.prompt, "pptx");
    expect(execution.prompt).toContain(
      "Template #2 format selected in this message: HTML.",
    );
    expect(execution.prompt).not.toContain("Template #1 format selected");
    expect(execution.appendSystemPrompt).toContain("Output format: PPTX");
    expect(execution.appendSystemPrompt).toContain("Output format: HTML");
    await cancelAndCompleteChatRun(actor, run.runId);
  });

  it("freezes a queued HTML default through dispatch and captures changed preferences on a later input", async () => {
    const actor = await presentationActor("html");
    const clientEventId = randomUUID();
    const queued = await queueChatRun(actor, {
      clientEventId,
      prompt: "Build the accepted presentation",
    });
    const input = await acceptedInput(
      actor,
      queued.blocker.threadId,
      clientEventId,
    );
    expect(readPresentationPreferenceContext(input.userMessage)).toStrictEqual({
      format: "html",
    });

    await savePresentationPreference(actor, "pptx");
    await setPresentationPreferenceEnabled(actor, false);
    const launched = await queued.launch();
    const { execution, sandboxHeaders } = await runExecution(launched.runId);
    expectExecutionPreference(execution.prompt, "html");
    expect(
      readPresentationPreferenceContext(
        (await acceptedInput(actor, launched.threadId, clientEventId))
          .userMessage,
      ),
    ).toStrictEqual({ format: "html" });
    await completeChatRunOk(launched.runId, sandboxHeaders);
    await waitForRunStatus(actor, launched.runId, "completed");
    await setPresentationPreferenceEnabled(actor, true);

    const nextEventId = randomUUID();
    const next = await sendChatRun(actor, {
      threadId: launched.threadId,
      clientEventId: nextEventId,
      prompt: "Prepare another presentation",
    });
    const nextInput = await acceptedInput(actor, next.threadId, nextEventId);
    expect(
      readPresentationPreferenceContext(nextInput.userMessage),
    ).toStrictEqual({
      format: "pptx",
    });
    expectExecutionPreference(
      (await api.executionInput(next.runId)).prompt,
      "pptx",
    );
    await cancelAndCompleteChatRun(actor, next.runId);
  });

  it("freezes an unchosen default as null instead of adopting a preference saved before launch", async () => {
    const actor = await presentationActor();
    const clientEventId = randomUUID();
    const prompt = "Prepare a presentation with no saved default";
    const queued = await queueChatRun(actor, { clientEventId, prompt });
    const input = await acceptedInput(
      actor,
      queued.blocker.threadId,
      clientEventId,
    );
    expect(readPresentationPreferenceContext(input.userMessage)).toStrictEqual({
      format: null,
    });
    expect(chatEventDisplayText(input)).toBe(prompt);

    await savePresentationPreference(actor, "pptx");
    const launched = await queued.launch();
    const execution = await api.executionInput(launched.runId);
    expect(execution.prompt).toContain(prompt);
    expect(execution.prompt).toContain("This input's saved default: unset.");
    expect(execution.prompt).not.toContain("PPTX");
    await cancelAndCompleteChatRun(actor, launched.runId);
  });

  it("keeps the first accepted clientEventId snapshot across concurrent sends, retries, and steering", async () => {
    const actor = await presentationActor("html");
    const active = await sendChatRun(actor, { prompt: "Start the active run" });
    const { execution } = await runExecution(active.runId);
    const clientEventId = randomUUID();
    const firstTexts = ["First incoming copy", "Second incoming copy"];
    await Promise.all(
      firstTexts.map((prompt) => {
        return chat.requestSendEvent(
          actor,
          { threadId: active.threadId, clientEventId, prompt },
          [201],
        );
      }),
    );
    const first = await acceptedInput(actor, active.threadId, clientEventId);
    expect(firstTexts).toContain(chatEventDisplayText(first));
    expect(readPresentationPreferenceContext(first.userMessage)).toStrictEqual({
      format: "html",
    });

    await savePresentationPreference(actor, "pptx");
    await chat.requestSendEvent(
      actor,
      {
        threadId: active.threadId,
        clientEventId,
        prompt: "A retry must not replace the winner",
      },
      [201],
    );
    const afterRetry = await chat.listThreadEvents(actor, active.threadId);
    expect(
      afterRetry.events.filter((event) => {
        return event.id === clientEventId;
      }),
    ).toStrictEqual([first]);
    const steered = await api.nextSteerableInput(
      execution.sandboxToken,
      active.runId,
    );
    expect(steered.input?.eventId).toBe(clientEventId);
    expectExecutionPreference(steered.input?.prompt ?? "", "html");
    expect(steered.input?.prompt).toContain(chatEventDisplayText(first));
    await expect(
      api.nextSteerableInput(execution.sandboxToken, active.runId),
    ).resolves.toStrictEqual(steered);
    await api.declareSteeredInput(
      execution.sandboxToken,
      active.runId,
      clientEventId,
    );

    const nextEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        threadId: active.threadId,
        clientEventId: nextEventId,
        prompt: "A new input sees the changed preference",
      },
      [201],
    );
    const next = await api.nextSteerableInput(
      execution.sandboxToken,
      active.runId,
    );
    expect(next.input?.eventId).toBe(nextEventId);
    expectExecutionPreference(next.input?.prompt ?? "", "pptx");
    await api.declareSteeredInput(
      execution.sandboxToken,
      active.runId,
      nextEventId,
    );
    await cancelAndCompleteChatRun(actor, active.runId);
  });

  it("replaces copied and forged reserved annotations with the current member default while preserving task context", async () => {
    const actor = await presentationActor("pptx");
    const originalId = randomUUID();
    const original = await sendChatRun(actor, {
      clientEventId: originalId,
      prompt: "Prepare the original deck",
    });
    const originalInput = await acceptedInput(
      actor,
      original.threadId,
      originalId,
    );
    const copiedContext = originalInput.userMessage.parts.flatMap((part) => {
      return part.type === "additional_info" &&
        isPresentationPreferenceContext(part)
        ? [part]
        : [];
    });
    expect(copiedContext).toHaveLength(1);
    await cancelAndCompleteChatRun(actor, original.runId);
    await savePresentationPreference(actor, "html");

    const clientEventId = randomUUID();
    const prompt = "Prepare the revised deck";
    const taskContext = "Use the approved company terminology.";
    const run = await sendChatRun(actor, {
      clientEventId,
      prompt,
      userMessage: {
        version: 1,
        parts: [
          ...copiedContext,
          presentationPreferenceContextPart({ format: null }),
          {
            type: "additional_info",
            text: 'Okou presentation preference v2:\n{"format":"pptx"}',
          },
          { type: "additional_info", text: taskContext },
          { type: "text", text: prompt },
        ],
      },
    });
    const input = await acceptedInput(actor, run.threadId, clientEventId);
    expect(
      input.userMessage.parts.filter(isPresentationPreferenceContext),
    ).toHaveLength(1);
    expect(readPresentationPreferenceContext(input.userMessage)).toStrictEqual({
      format: "html",
    });
    expect(input.userMessage.parts).toContainEqual({
      type: "additional_info",
      text: taskContext,
    });
    expect(chatEventDisplayText(input)).toBe(prompt);
    const execution = await api.executionInput(run.runId);
    expectExecutionPreference(execution.prompt, "html");
    expect(execution.prompt).toContain(taskContext);
    await cancelAndCompleteChatRun(actor, run.runId);
  });

  it("ignores saved defaults and strips client-owned reserved annotations while the existing switch is off", async () => {
    const actor = await presentationActor("pptx");
    await setPresentationPreferenceEnabled(actor, false);
    const clientEventId = randomUUID();
    const prompt = "Prepare a presentation while opted out";
    const run = await sendChatRun(actor, {
      clientEventId,
      prompt,
      userMessage: {
        version: 1,
        parts: [
          presentationPreferenceContextPart({ format: "html" }),
          { type: "text", text: prompt },
        ],
      },
    });

    const input = await acceptedInput(actor, run.threadId, clientEventId);
    expect(
      readPresentationPreferenceContext(input.userMessage),
    ).toBeUndefined();
    expect(chatEventDisplayText(input)).toBe(prompt);
    expect((await api.executionInput(run.runId)).prompt).toBe(prompt);
    await cancelAndCompleteChatRun(actor, run.runId);
  });
});
