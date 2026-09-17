import { randomUUID } from "node:crypto";
import { HeadObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import type {
  GenerationTemplateRequest,
  UserMessageInputDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  VIDEO_TEMPLATE_ITEMS,
  WEBSITE_TEMPLATE_ITEMS,
  WORKFLOW_TEMPLATE_ITEMS,
} from "@okouai/core";
import { avatarTemplateStylePresetId } from "@okouai/core/avatar-template";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { formatUserPresentationTemplateId } from "@okouai/core/presentation-template-selection";
import { describe, expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import {
  buildArtifactKeyV2,
  buildArtifactPrefixV2,
} from "../../../lib/file-url";
import { holdChatThreadRowLockFixture } from "../../../test-fixtures/chat-events";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { expectApiError } from "./helpers/api-bdd";
import { chatEventDisplayText } from "./helpers/chat-event";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  createChatEventsFixture,
  type PromptMessage,
  userMessageWithTemplate,
  requireOrgId,
  userMessages,
  eventBackedContents,
  assistantEvent,
} from "./helpers/chat-events-fixture";

const context = testContext();
const {
  bdd,
  api,
  chat,
  chatCallbacks,
  entitledChatActor,
  seedBuiltInModelKey,
  sendChatRun,
  claimChatRun,
  waitForThreadMessages,
  waitForRunUserMessage,
  completeChatRunOk,
  cancelChatRun,
  requestSendEventRaw,
} = createChatEventsFixture(context);

describe("CHAT-02: generation templates and attachments", () => {
  const introVideoTemplate: GenerationTemplateRequest = {
    type: "intro-video",
    selection: {
      options: {
        style: {
          kind: "catalog",
          style: {
            id: "minimalism",
            name: "Minimalism",
            tags: ["iconic-artist"],
            aspectRatio: "16:9",
          },
        },
        avatar: { kind: "none" },
        voice: { kind: "none" },
      },
    },
  };

  it("gates intro video template sends with the rollout override while preserving ordinary video", async () => {
    const { actor, agentId } = await entitledChatActor();
    const scopedActor = { ...actor, orgId: requireOrgId(actor) };
    await updateFeatureSwitchesForUser(context, scopedActor, {
      [FeatureSwitchKey.IntroVideo]: false,
    });
    const ordinary = VIDEO_TEMPLATE_ITEMS[0]!;
    const ordinaryTemplate: GenerationTemplateRequest = {
      type: "video",
      selection: { stylePresetId: ordinary.id },
    };
    for (const templates of [
      [introVideoTemplate],
      [ordinaryTemplate, introVideoTemplate],
    ]) {
      const rejected = await chat.requestSendEvent(
        actor,
        {
          agentId,
          prompt: "Explain the product",
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: "Explain the product" },
              ...templates.map((template) => {
                return {
                  type: "template" as const,
                  titleSnapshot: "Selected video",
                  template,
                };
              }),
            ],
          },
        },
        [400],
      );
      expectApiError(rejected.body);
      expect(rejected.body.error.message).toBe("Intro video is not available");
    }
    const events = await chat.requestThreadEvents(actor, {}, [200]);
    if (events.status !== 200) {
      throw new Error("Expected thread events to load");
    }
    expect(events.body.events).toStrictEqual([]);
    const video = await sendChatRun(actor, {
      agentId,
      prompt: "Make a creative scene",
      template: ordinaryTemplate,
    });
    expect(
      (await api.readRun(actor, video.runId)).appendSystemPrompt,
    ).toContain(ordinary.id);
    await cancelChatRun(actor, video.runId);

    await updateFeatureSwitchesForUser(context, scopedActor, {
      [FeatureSwitchKey.IntroVideo]: true,
    });

    const malformed = await chat.requestSendEvent(
      actor,
      {
        agentId,
        prompt: "Explain it",
        userMessage: userMessageWithTemplate("Explain it", {
          type: "intro-video",
          selection: {},
        }),
      },
      [400],
    );
    expectApiError(malformed.body);
    expect(malformed.body.error.message).toBe(
      "Intro video settings are missing",
    );
    const explained = await sendChatRun(actor, {
      agentId,
      prompt: "Explain the product",
      template: introVideoTemplate,
    });
    const prompt = (await api.readRun(actor, explained.runId))
      .appendSystemPrompt;
    expect(prompt).toContain("Use the $intro-video skill");
    expect(prompt).toContain("- HeyGen style: Minimalism (minimalism)");
    expect(prompt).toContain("- HeyGen style preview aspect ratio: 16:9");
    expect(prompt).toContain("- Avatar: No avatar");
    expect(prompt).toContain("- Voice: No voiceover");
    await cancelChatRun(actor, explained.runId);
  }, 90_000);

  it.each(["queued dispatch", "active input"] as const)(
    "rechecks intro video access before %s",
    async (delivery) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const scopedActor = { ...actor, orgId: requireOrgId(actor) };
      await updateFeatureSwitchesForUser(context, scopedActor, {
        [FeatureSwitchKey.IntroVideo]: true,
      });
      const active = await sendChatRun(actor, {
        agentId,
        prompt: "Start the conversation",
      });
      const claimed = await claimChatRun(runnerGroup, active.runId);
      const eventId = randomUUID();
      await chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: active.threadId,
          clientEventId: eventId,
          prompt: "Explain the product",
          userMessage: userMessageWithTemplate(
            "Explain the product",
            introVideoTemplate,
          ),
        },
        [201],
      );
      await updateFeatureSwitchesForUser(context, scopedActor, {
        [FeatureSwitchKey.IntroVideo]: false,
      });
      context.mocks.axiom.ingest.mockClear();
      if (delivery === "active input") {
        const reserved = await api.reserveRunnerActiveInputs(
          claimed.claim.sandboxToken,
          active.runId,
        );
        if (reserved.outcome !== "reserved") {
          throw new Error("Expected the active input to be reserved");
        }
        expect(reserved.prompt).toContain("Explain the product");
        expect(reserved.prompt).not.toContain("Use the $intro-video skill");
        await cancelChatRun(actor, active.runId);
        return;
      }
      await completeChatRunOk(active.runId, claimed.sandboxHeaders);
      await flushWaitUntilForTest();
      const messages = await waitForThreadMessages(
        actor,
        active.threadId,
        (items) => {
          return userMessages(items).some((message) => {
            return (
              message.revokesEventId === eventId &&
              typeof message.runId === "string"
            );
          });
        },
      );
      const next = userMessages(messages.events).find((message) => {
        return (
          message.revokesEventId === eventId &&
          typeof message.runId === "string"
        );
      });
      if (!next?.runId) {
        throw new Error("Expected the queued input to dispatch");
      }
      const run = await api.readRun(actor, next.runId);
      expect(run.prompt).toContain("Explain the product");
      expect(run.appendSystemPrompt).not.toContain(
        "Use the $intro-video skill",
      );
      await cancelChatRun(actor, next.runId);
    },
    90_000,
  );

  it("uses the userMessage document for the runtime prompt", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const style = ILLUSTRATION_TEMPLATE_ITEMS[0];
    if (!style) {
      throw new Error("Expected a registered illustration style");
    }
    const generationTemplate: GenerationTemplateRequest = {
      type: "illustration",
      selection: { illustrationStyleId: style.illustrationStyleId },
    };
    const fileId = randomUUID();
    const referencedThreadId = randomUUID();
    const mailDraftId = randomUUID();
    const feedbackPrompt =
      `The user quoted 2 parts of an email draft (mail draft ID: ${mailDraftId}):\n\n` +
      "> First quote\n\nClarify this point\n\n---\n\n" +
      `> Second quote\n\nAdd supporting evidence from [Roadmap](/chats/${referencedThreadId})`;
    const prompt =
      `Review [Roadmap](/chats/${referencedThreadId}) now\n\n` + feedbackPrompt;
    const userMessage: UserMessageInputDocument = {
      version: 1,
      parts: [
        {
          type: "template",
          titleSnapshot: style.title,
          template: generationTemplate,
        },
        {
          type: "file",
          fileId,
          filenameSnapshot: "brief.pdf",
          contentType: "application/pdf",
        },
        { type: "text", text: "Review " },
        {
          type: "chat_thread",
          threadId: referencedThreadId,
          titleSnapshot: "Roadmap",
        },
        { type: "text", text: " now" },
        {
          type: "feedback",
          quote: "First quote",
          note: [{ type: "text", text: "Clarify this point" }],
          eventId: "assistant-event-first-quote",
          range: { start: 0, end: 11 },
          source: {
            type: "mail",
            id: mailDraftId,
            status: "draft",
          },
        },
        {
          type: "feedback",
          quote: "Second quote",
          note: [
            { type: "text", text: "Add supporting evidence from " },
            {
              type: "chat_thread",
              threadId: referencedThreadId,
              titleSnapshot: "Roadmap",
            },
          ],
          source: {
            type: "mail",
            id: mailDraftId,
            status: "draft",
          },
        },
        {
          type: "source",
          kind: "slack",
          href: "https://vm0.slack.com/archives/C123/p456",
        },
      ],
    };
    chat.mockCompletedUploadObject(actor, fileId, "brief.pdf", 42);

    const sent = await sendChatRun(actor, {
      agentId,
      prompt,
      userMessage,
    });

    const run = await api.readRun(actor, sent.runId);
    expect(run.prompt).toBe(
      [
        `[Template #1: ${style.title} (illustration)]`,
        `[Web file] brief.pdf (application/pdf)\n   [ID] ${fileId}`,
        prompt,
      ].join("\n\n"),
    );
    expect(run.appendSystemPrompt).toContain("# Inline Templates");
    expect(run.appendSystemPrompt).toContain(style.illustrationStyleId);

    const messages = await waitForThreadMessages(
      actor,
      sent.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return message.runId === sent.runId;
        });
      },
    );
    const message = userMessages(messages.events).find(
      (item): item is PromptMessage => {
        return item.eventType === "input.prompt" && item.runId === sent.runId;
      },
    );
    expect(message).toMatchObject({
      content: null,
      userMessage: {
        version: 1,
        parts: [
          ...userMessage.parts,
          { type: "model", selectedModel: "claude-sonnet-5" },
        ],
      },
    });

    await cancelChatRun(actor, sent.runId);
  }, 90_000);

  it("projects referenced passages without requiring every feedback note", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const userMessage: UserMessageInputDocument = {
      version: 1,
      parts: [
        {
          type: "feedback",
          quote: "First quote",
          note: [{ type: "text", text: "Clarify the owner" }],
        },
        {
          type: "feedback",
          quote: "Second quote",
          note: [],
        },
      ],
    };
    const prompt =
      "The user quoted 2 parts of your reply:\n\n" +
      "> First quote\n\nClarify the owner\n\n---\n\n" +
      "> Second quote";

    const sent = await sendChatRun(actor, {
      agentId,
      prompt: "legacy fallback",
      userMessage,
    });

    const run = await api.readRun(actor, sent.runId);
    expect(run.prompt).toBe(prompt);

    const messages = await waitForThreadMessages(
      actor,
      sent.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return message.runId === sent.runId;
        });
      },
    );
    const message = userMessages(messages.events).find(
      (item): item is PromptMessage => {
        return item.eventType === "input.prompt" && item.runId === sent.runId;
      },
    );
    expect(message?.userMessage?.parts.slice(0, 2)).toStrictEqual(
      userMessage.parts,
    );

    await cancelChatRun(actor, sent.runId);
  }, 90_000);

  it("projects forwarded passages from the authoritative source title", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const source = await sendChatRun(actor, {
      agentId,
      prompt: "source content selected for forwarding",
    });
    await chat.renameThread(actor, source.threadId, "Source launch plan");
    const targetThread = await chat.createThread(actor, { agentId });
    const userMessage: UserMessageInputDocument = {
      version: 1,
      parts: [
        {
          type: "feedback",
          quote: "The deployment window is fifteen minutes.",
          note: [],
        },
      ],
    };
    const expectedPrompt =
      'The user forwarded this from the chat "Source launch plan":\n\n' +
      "> The deployment window is fifteen minutes.";
    const forwarded = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: targetThread.id,
        prompt: "legacy fallback",
        userMessage,
        sourceRunId: source.runId,
      },
      [201],
    );
    if (forwarded.status !== 201 || !forwarded.body.runId) {
      throw new Error("Expected the forwarded passage to launch a run");
    }

    const run = await api.readRun(actor, forwarded.body.runId);
    expect(run.prompt).toBe(expectedPrompt);
    const messages = await chat.listThreadEvents(actor, targetThread.id);
    const forwardedMessage = userMessages(messages.events).find(
      (message): message is PromptMessage => {
        return (
          message.eventType === "input.prompt" &&
          message.runId === forwarded.body.runId
        );
      },
    );
    expect(forwardedMessage?.userMessage?.parts).toContainEqual({
      type: "source",
      kind: "agent",
      runId: source.runId,
      threadId: source.threadId,
      agentId,
      titleSnapshot: "Source launch plan",
      href: `/chats/${source.threadId}#run-${source.runId}`,
    });

    await cancelChatRun(actor, forwarded.body.runId);
    await cancelChatRun(actor, source.runId);
  }, 90_000);

  it("projects multiple inline templates into one ordered prompt and one shared context", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const style = ILLUSTRATION_TEMPLATE_ITEMS[0];
    const workflow = WORKFLOW_TEMPLATE_ITEMS[0];
    if (!style || !workflow) {
      throw new Error("Expected registered inline templates");
    }
    const illustrationTemplate: GenerationTemplateRequest = {
      type: "illustration",
      selection: { illustrationStyleId: style.illustrationStyleId },
    };
    const workflowTemplate: GenerationTemplateRequest = {
      type: "workflow",
      selection: { workflowTemplateId: workflow.id },
    };
    const userMessage: UserMessageInputDocument = {
      version: 1,
      parts: [
        { type: "text", text: "Use " },
        {
          type: "template",
          titleSnapshot: style.title,
          template: illustrationTemplate,
        },
        { type: "text", text: " for the dog, then " },
        {
          type: "template",
          titleSnapshot: workflow.title,
          template: workflowTemplate,
        },
        { type: "text", text: " for the follow-up" },
        {
          type: "feedback",
          quote: "Earlier answer",
          note: [
            { type: "text", text: "Restyle with " },
            {
              type: "template",
              titleSnapshot: style.title,
              template: illustrationTemplate,
            },
          ],
        },
      ],
    };

    const sent = await sendChatRun(actor, {
      agentId,
      prompt: "legacy fallback",
      userMessage,
    });
    const run = await api.readRun(actor, sent.runId);
    const firstMarker = `[Template #1: ${style.title} (illustration)]`;
    const secondMarker = `[Template #2: ${workflow.title} (workflow)]`;
    const feedbackMarker = `[Template #3: ${style.title} (illustration)]`;
    expect(run.prompt).toContain(
      `Use ${firstMarker} for the dog, then ${secondMarker} for the follow-up`,
    );
    expect(run.prompt).toContain(`Restyle with ${feedbackMarker}`);
    expect(run.prompt.indexOf(firstMarker)).toBeLessThan(
      run.prompt.indexOf(secondMarker),
    );

    const systemPrompt = run.appendSystemPrompt ?? "";
    expect(systemPrompt.match(/^# Inline Templates$/gm)).toHaveLength(1);
    expect(systemPrompt).not.toContain("# Artifact Template Context");
    expect(systemPrompt).not.toContain("# Workflow Template Context");
    expect(systemPrompt).toContain("## Template #1 (illustration)");
    expect(systemPrompt).toContain("## Template #2 (workflow)");
    expect(systemPrompt).toContain("## Template #3 (illustration)");
    expect(systemPrompt).toContain(style.illustrationStyleId);
    expect(systemPrompt).toContain(workflow.id);

    const messages = await waitForThreadMessages(
      actor,
      sent.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return message.runId === sent.runId;
        });
      },
    );
    const message = userMessages(messages.events).find(
      (item): item is PromptMessage => {
        return item.eventType === "input.prompt" && item.runId === sent.runId;
      },
    );
    expect(message).toMatchObject({
      content: null,
      userMessage: {
        version: 1,
        parts: [
          ...userMessage.parts,
          { type: "model", selectedModel: "claude-sonnet-5" },
        ],
      },
    });
    await cancelChatRun(actor, sent.runId);
  }, 90_000);

  it("preserves the attachment userMessage order in the runtime prompt", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const fileId = randomUUID();
    chat.mockCompletedUploadObject(actor, fileId, "api-input.txt", 12);
    const sent = await sendChatRun(actor, {
      agentId,
      prompt: "plain API attachment",
      userMessage: {
        version: 1,
        parts: [
          {
            type: "file",
            fileId,
            filenameSnapshot: "api-input.txt",
            contentType: "text/plain",
          },
          { type: "text", text: "plain API attachment" },
        ],
      },
    });

    const run = await api.readRun(actor, sent.runId);
    expect(run.prompt).toBe(
      [
        `[Web file] api-input.txt (text/plain)\n   [ID] ${fileId}`,
        "plain API attachment",
      ].join("\n\n"),
    );
    const messages = await waitForThreadMessages(
      actor,
      sent.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return message.runId === sent.runId;
        });
      },
    );
    expect(
      userMessages(messages.events).find((message) => {
        return message.runId === sent.runId;
      }),
    ).toMatchObject({
      content: null,
      userMessage: {
        version: 1,
        parts: [
          {
            type: "file",
            fileId,
            filenameSnapshot: "api-input.txt",
            contentType: "text/plain",
          },
          { type: "text", text: "plain API attachment" },
          { type: "model", selectedModel: "claude-sonnet-5" },
        ],
      },
    });
    expect(
      chatEventDisplayText(
        userMessages(messages.events).find((message) => {
          return message.runId === sent.runId;
        })!,
      ),
    ).toBe("plain API attachment");
    await cancelChatRun(actor, sent.runId);
  }, 60_000);

  it("uses only the canonical template part", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const style = ILLUSTRATION_TEMPLATE_ITEMS[0];
    if (!style) {
      throw new Error("Expected a registered illustration style");
    }
    const generationTemplate: GenerationTemplateRequest = {
      type: "illustration",
      selection: { illustrationStyleId: style.illustrationStyleId },
    };
    const sent = await sendChatRun(actor, {
      agentId,
      prompt: "draw a dog",
      template: generationTemplate,
    });

    const run = await api.readRun(actor, sent.runId);
    expect(run.prompt).toBe(
      "draw a dog\n\n[Template #1: Illustration template (illustration)]",
    );
    const systemPrompt = run.appendSystemPrompt ?? "";
    expect(systemPrompt).toContain("# Inline Templates");
    expect(systemPrompt).toContain(style.illustrationStyleId);
    const messages = await chat.listThreadEvents(actor, sent.threadId);
    const message = userMessages(messages.events).find((event) => {
      return event.eventType === "input.prompt" && event.runId === sent.runId;
    });
    expect(message).toMatchObject({
      userMessage: {
        version: 1,
        parts: expect.arrayContaining([
          {
            type: "template",
            titleSnapshot: "Illustration template",
            template: generationTemplate,
          },
        ]),
      },
    });
    await cancelChatRun(actor, sent.runId);
  }, 90_000);

  it.each([
    "Create a presentation.\nNumber of slides: 10.",
    "Create a video.\nDuration: 6s.\nAudio: off.",
    "Create an image.\nAspect ratio: 1:1.",
  ])(
    "preserves client-authored additional info in the agent prompt: %s",
    async (additionalInfo) => {
      const { actor, agentId } = await entitledChatActor();
      chatCallbacks.failIfChatCallbackRouteIsFetched();
      const prompt = "Our launch brief";
      const userMessage: UserMessageInputDocument = {
        version: 1,
        parts: [
          { type: "additional_info", text: additionalInfo },
          { type: "text", text: prompt },
        ],
      };
      const sent = await sendChatRun(actor, { agentId, prompt, userMessage });
      const run = await api.readRun(actor, sent.runId);
      expect(run.prompt).toBe(`${additionalInfo}\n\n${prompt}`);
      const messages = await chat.listThreadEvents(actor, sent.threadId);
      const message = userMessages(messages.events).find((event) => {
        return event.eventType === "input.prompt" && event.runId === sent.runId;
      });
      if (!message) {
        throw new Error("Expected the sent message to be persisted");
      }
      expect(message).toMatchObject({
        userMessage: { parts: expect.arrayContaining(userMessage.parts) },
      });
      expect(chatEventDisplayText(message)).toBe(prompt);
      await cancelChatRun(actor, sent.runId);
    },
    90_000,
  );

  it("renders generation template guidance into the run system prompt", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
    if (!template) {
      throw new Error("Expected a registered presentation runbook item");
    }
    const colorSystemId = template.colorSystemId;
    if (!colorSystemId) {
      throw new Error(
        "Expected the presentation template to have a color system",
      );
    }

    const presentation = await sendChatRun(actor, {
      agentId,
      prompt: "make a launch deck",
      template: {
        type: "presentation",
        selection: {
          colorSystemId,
          templateId: template.templateId,
        },
      },
    });
    const presentationRun = await api.readRun(actor, presentation.runId);
    expect(presentationRun.prompt).toBe(
      "make a launch deck\n\n[Template #1: Presentation template (presentation)]",
    );
    const presentationPrompt = presentationRun.appendSystemPrompt ?? "";
    expect(presentationPrompt).toContain("# Inline Templates");
    expect(presentationPrompt).toContain(
      "Selected presentation template: Playful Launch Presentation (template:html-ppt-playful-launch)",
    );
    expect(presentationPrompt).not.toContain("Selected design system");
    expect(presentationPrompt).toContain(
      `okou resource pull ${template.templateId}-runbook --dir ./generated/resources`,
    );
    const colorToken = colorSystemId
      .replace("color-system:", "")
      .replaceAll("-", "_");
    expect(presentationPrompt).toContain(`Color system token: ${colorToken}`);
    expect(presentationPrompt).toContain(
      "./generated/resources/playful-launch/SKILL.md",
    );
    expect(presentationPrompt).toContain(
      "Keep all slides and visible content in index.html; render the first slide without JavaScript",
    );
    expect(presentationPrompt).toContain("--artifact-kind presentation-html");
    expect(presentationPrompt).not.toContain(
      "okou generate presentation --design-system",
    );
    expect(presentationPrompt).not.toContain("- Artifact type: presentation");
    await cancelChatRun(actor, presentation.runId);

    const videoTemplate = VIDEO_TEMPLATE_ITEMS.find((item) => {
      return item.id === "video-template:epic-grandeur";
    });
    if (!videoTemplate) {
      throw new Error("Expected the epic-grandeur video template");
    }
    const video = await sendChatRun(actor, {
      agentId,
      prompt: "make a product video",
      template: {
        type: "video",
        selection: { stylePresetId: videoTemplate.id },
      },
    });
    const videoRun = await api.readRun(actor, video.runId);
    const videoPrompt = videoRun.appendSystemPrompt ?? "";
    expect(videoPrompt).toContain("# Inline Templates");
    expect(videoPrompt).toContain(
      `Template: ${videoTemplate.title} (${videoTemplate.id})`,
    );
    expect(videoPrompt).toContain(
      `okou generate video --provider built-in --template ${videoTemplate.id}`,
    );
    await cancelChatRun(actor, video.runId);

    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor");
    }

    // Run options are the composer's channel for video parameters now. They
    // ride one message, reach no table, and only enter the agent prompt when the
    // user moved a value off the effective model's default -- and they enter
    // it as defaults this run's message can override, not as instructions.
    const videoRunOptions = await sendChatRun(actor, {
      agentId,
      prompt: "make a clip from this brief",
      runOptions: {
        video: {
          aspectRatio: "9:16",
          duration: "6s",
          resolution: "480p",
          generateAudio: false,
        },
      },
    });
    const videoRunOptionsRun = await api.readRun(actor, videoRunOptions.runId);
    const videoRunOptionsPrompt = videoRunOptionsRun.prompt;
    expect(videoRunOptionsPrompt).toContain("# Video Generation Defaults");
    expect(videoRunOptionsPrompt).toContain("- Aspect ratio: 9:16");
    expect(videoRunOptionsPrompt).toContain("- Duration: 6s");
    expect(videoRunOptionsPrompt).toContain("- Resolution: 480p");
    expect(videoRunOptionsPrompt).toContain("- Audio: off");
    // Stated as defaults the message outranks, not as requirements: the chip
    // was set before the message was written, so "make it square" has to win.
    expect(videoRunOptionsPrompt).toContain(
      "the message wins, for that parameter only",
    );
    expect(videoRunOptionsPrompt).toMatch(/\n\nmake a clip from this brief$/);
    // Values only. A pre-assembled flag string is a ready-made answer that
    // stops being correct as soon as the message overrides one value.
    expect(videoRunOptionsPrompt).not.toContain("--aspect-ratio");
    expect(videoRunOptionsPrompt).not.toContain("--no-audio");
    expect(videoRunOptionsRun.appendSystemPrompt ?? "").not.toContain(
      "# Video Generation Defaults",
    );
    await cancelChatRun(actor, videoRunOptions.runId);

    // Most runs never generate a video, so a send that set nothing carries no
    // trace of the block at all.
    const withoutVideoRunOptions = await sendChatRun(actor, {
      agentId,
      prompt: "answer a plain question",
    });
    expect(
      (await api.readRun(actor, withoutVideoRunOptions.runId)).prompt,
    ).not.toContain("# Video Generation Defaults");
    await cancelChatRun(actor, withoutVideoRunOptions.runId);

    const avatarId = 81;
    const avatarVoiceId = "en-US-ChristopherNeural";
    const avatar = await sendChatRun(actor, {
      agentId,
      prompt: "make a presenter video",
      template: {
        type: "video",
        selection: {
          stylePresetId: avatarTemplateStylePresetId(avatarId),
          titleSnapshot: "Do not inject this avatar name",
          previewUrl: "https://example.com/untrusted-avatar.jpg",
          voiceId: avatarVoiceId,
          aspectRatio: "landscape",
        },
      },
    });
    const avatarRun = await api.readRun(actor, avatar.runId);
    const avatarPrompt = avatarRun.appendSystemPrompt ?? "";
    expect(avatarPrompt).toContain("# Inline Templates");
    expect(avatarPrompt).toContain(`Public JoggAI avatar ID: ${avatarId}`);
    expect(avatarPrompt).toContain(`Public JoggAI voice ID: ${avatarVoiceId}`);
    expect(avatarPrompt).toContain("Aspect ratio: landscape");
    expect(avatarPrompt).not.toContain("--list-voices");
    expect(avatarPrompt).toContain(
      `okou generate avatar-video --provider built-in --avatar-id ${avatarId} --voice-id ${avatarVoiceId} --aspect-ratio landscape`,
    );
    expect(avatarPrompt).not.toContain("Do not inject this avatar name");
    expect(avatarPrompt).not.toContain("untrusted-avatar.jpg");
    await cancelChatRun(actor, avatar.runId);

    const websiteTemplate = WEBSITE_TEMPLATE_ITEMS[0];
    if (!websiteTemplate) {
      throw new Error("Expected a registered website template");
    }
    const website = await sendChatRun(actor, {
      agentId,
      prompt: "make a campaign landing page",
      template: {
        type: "website",
        selection: { websiteTemplateId: websiteTemplate.id },
      },
    });
    const websiteRun = await api.readRun(actor, website.runId);
    const websitePrompt = websiteRun.appendSystemPrompt ?? "";
    expect(websitePrompt).toContain("# Inline Templates");
    expect(websitePrompt).toContain(
      `Template: ${websiteTemplate.title} (${websiteTemplate.id})`,
    );
    expect(websitePrompt).toContain(
      "okou resource pull template:black-slabs --dir ./generated/resources",
    );
    expect(websitePrompt).toContain(
      "Image workflow: use supplied images first;",
    );
    expect(websitePrompt).toMatch(
      /npx --yes --package="\$\{CLI_PKG_URL\}" okou generate image-batch start <manifest\.tsv> <state-dir>/,
    );
    expect(websitePrompt).toMatch(
      /npx --yes --package="\$\{CLI_PKG_URL\}" okou generate image-batch wait <state-dir>/,
    );
    expect(websitePrompt).not.toContain("tools/generate-images.mjs");
    expect(websitePrompt).not.toContain("resolve-images.mjs");
    expect(websitePrompt).not.toContain("render.mjs");
    await cancelChatRun(actor, website.runId);
  }, 90_000);

  it("uses R2 for archive-backed styles", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const style = ILLUSTRATION_TEMPLATE_ITEMS.find((item) => {
      return item.illustrationStyleId === "image-style:ink-storefront";
    });
    if (!style) {
      throw new Error("Expected the ink-storefront illustration style");
    }

    const defaultR2Run = await sendChatRun(actor, {
      agentId,
      prompt: "draw a flower shop from the default R2 source",
      template: {
        type: "illustration",
        selection: { illustrationStyleId: style.illustrationStyleId },
      },
    });
    const defaultR2Prompt =
      (await api.readRun(actor, defaultR2Run.runId)).appendSystemPrompt ?? "";
    expect(defaultR2Prompt).toContain(
      "Style source: private R2 registry resource image-style:ink-storefront",
    );
    expect(defaultR2Prompt).toContain("--compile --style-source r2");
    await cancelChatRun(actor, defaultR2Run.runId);
  }, 90_000);

  it("is one-shot: a follow-up without re-attaching the style gets no template context", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const style = ILLUSTRATION_TEMPLATE_ITEMS[0];
    if (!style) {
      throw new Error("Expected a registered illustration style");
    }

    // Turn 1: the user explicitly attaches the style — the live block is present.
    const first = await sendChatRun(actor, {
      agentId,
      prompt: "draw a fox",
      template: {
        type: "illustration",
        selection: { illustrationStyleId: style.illustrationStyleId },
      },
    });
    const firstPrompt = (await api.readRun(actor, first.runId))
      .appendSystemPrompt;
    expect(firstPrompt).toContain("# Inline Templates");
    expect(firstPrompt).toContain(
      `okou generate image --provider built-in --style ${style.illustrationStyleId} --prompt "<user request>" --compile`,
    );
    expect(firstPrompt).toContain("Follow the returned packet completely");
    expect(firstPrompt).toContain(
      "If the R2 source is unavailable, stop without generating; do not fall back to GitHub.",
    );
    expect(firstPrompt).toContain("--compiled-prompt");
    expect(firstPrompt).toContain(style.illustrationStyleId);

    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([assistantEvent(0, "here is a fox")]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders, {
      lastEventSequence: 0,
    });
    await waitForThreadMessages(actor, first.threadId, (items) => {
      return eventBackedContents(items, first.runId).some((message) => {
        return message.content === "here is a fox";
      });
    });

    // Turn 2: a follow-up without re-attaching the style gets no template
    // context.
    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "another one",
    });
    const secondPrompt = (await api.readRun(actor, second.runId))
      .appendSystemPrompt;
    expect(secondPrompt).not.toContain("# Inline Templates");
    expect(secondPrompt).toContain("# This Chat Thread");
    expect(secondPrompt).not.toContain("Selected a template");
    expect(secondPrompt).not.toContain(style.illustrationStyleId);
    await waitForRunUserMessage(
      actor,
      first.threadId,
      second.runId,
      "another one",
    );
    await cancelChatRun(actor, second.runId);

    // Turn 3: attaching a video preset now only resolves the video template live
    // — templates no longer merge across turns or types.
    const videoTemplate = VIDEO_TEMPLATE_ITEMS.find((item) => {
      return item.id === "video-template:epic-grandeur";
    });
    if (!videoTemplate) {
      throw new Error("Expected the epic-grandeur video template");
    }
    const third = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "now make a video",
      template: {
        type: "video",
        selection: { stylePresetId: videoTemplate.id },
      },
    });
    const thirdPrompt = (await api.readRun(actor, third.runId))
      .appendSystemPrompt;
    expect(thirdPrompt).toContain(
      `Template: ${videoTemplate.title} (${videoTemplate.id})`,
    );
    expect(thirdPrompt).toContain(
      `okou generate video --provider built-in --template ${videoTemplate.id}`,
    );
    expect(thirdPrompt).toContain("# Incomplete Rounds Context");
    expect(thirdPrompt).not.toContain("# Web Chat Run Context");
    // The illustration style is gone entirely for this turn: it's not attached
    // to this message, and prior/incomplete context no longer repeats template
    // selections.
    expect(thirdPrompt).not.toContain(style.illustrationStyleId);
    await cancelChatRun(actor, third.runId);

    // A brand-new thread starts clean: neither template carries over.
    const fresh = await sendChatRun(actor, { agentId, prompt: "draw a cat" });
    const freshPrompt = (await api.readRun(actor, fresh.runId))
      .appendSystemPrompt;
    expect(freshPrompt).not.toContain("# Inline Templates");
    expect(freshPrompt).not.toContain(
      "okou generate image --provider built-in --style",
    );
    expect(freshPrompt).not.toContain(style.illustrationStyleId);
    await cancelChatRun(actor, fresh.runId);
  }, 120_000);

  it("injects workflow templates as one-shot context without prior template selections", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const style = ILLUSTRATION_TEMPLATE_ITEMS[0];
    const workflowTemplate = WORKFLOW_TEMPLATE_ITEMS[0];
    if (!style) {
      throw new Error("Expected a registered illustration style");
    }
    if (!workflowTemplate) {
      throw new Error("Expected a registered workflow template");
    }

    const illustration = await sendChatRun(actor, {
      agentId,
      prompt: "draw a labeled inbox",
      template: {
        type: "illustration",
        selection: { illustrationStyleId: style.illustrationStyleId },
      },
    });
    const illustrationPrompt = (await api.readRun(actor, illustration.runId))
      .appendSystemPrompt;
    expect(illustrationPrompt).toContain("# Inline Templates");
    expect(illustrationPrompt).toContain(style.illustrationStyleId);
    await cancelChatRun(actor, illustration.runId);

    const workflow = await sendChatRun(actor, {
      agentId,
      threadId: illustration.threadId,
      prompt: "create the workflow version",
      template: {
        type: "workflow",
        selection: { workflowTemplateId: workflowTemplate.id },
      },
    });
    const workflowPrompt = (await api.readRun(actor, workflow.runId))
      .appendSystemPrompt;
    expect(workflowPrompt).toContain("# Inline Templates");
    expect(workflowPrompt).toContain(
      `Auto-inbox label (${workflowTemplate.id})`,
    );
    expect(workflowPrompt).toContain("Use the workflow-setup skill");
    expect(workflowPrompt).toContain(
      "Save the reusable workflow draft as soon as the template behavior is clear.",
    );
    expect(workflowPrompt).not.toContain("Before creating anything");
    expect(workflowPrompt).toContain("Gmail label-applied automation");
    // The illustration run saved no native history, so its message text is
    // replayed in the new session without the style id.
    expect(workflowPrompt).toContain("# Web Chat Run Context");
    expect(workflowPrompt).toContain("User: draw a labeled inbox");
    expect(workflowPrompt).not.toContain("# Incomplete Rounds Context");
    expect(workflowPrompt).not.toContain(style.illustrationStyleId);
    await cancelChatRun(actor, workflow.runId);

    const followUp = await sendChatRun(actor, {
      agentId,
      threadId: illustration.threadId,
      prompt: "continue the thread",
    });
    const followUpPrompt = (await api.readRun(actor, followUp.runId))
      .appendSystemPrompt;
    // Neither cancelled run saved native history. Replay their message text
    // without carrying either prior template selection into the new session.
    expect(followUpPrompt).not.toContain("# Inline Templates");
    expect(followUpPrompt).not.toContain(workflowTemplate.id);
    expect(followUpPrompt).toContain("# Web Chat Run Context");
    expect(followUpPrompt).toContain("User: draw a labeled inbox");
    expect(followUpPrompt).toContain("User: create the workflow version");
    expect(followUpPrompt).not.toContain("# Incomplete Rounds Context");
    expect(followUpPrompt).not.toContain("Selected a template");
    expect(followUpPrompt).not.toContain(style.illustrationStyleId);
    await cancelChatRun(actor, followUp.runId);
  }, 120_000);

  it("rejects a private presentation template the caller cannot read", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, {
      displayName: "Private template agent",
    });
    // Well formed and syntactically a row id, but no such row exists for this
    // owner. A deleted template and someone else's template are the same
    // answer on purpose: neither may be distinguished from the outside.
    const templateId = formatUserPresentationTemplateId(randomUUID());
    const selection: GenerationTemplateRequest = {
      type: "presentation",
      selection: { templateId },
    };

    const rejected = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "use my own deck",
        userMessage: userMessageWithTemplate("use my own deck", selection),
      },
      [400],
    );
    expectApiError(rejected.body);
    expect(rejected.body.error.message).toBe("Presentation template not found");

    // Rejected before dispatch: no event is persisted and no run starts.
    const events = await chat.requestThreadEvents(actor, {}, [200]);
    expect(events.status).toBe(200);
    if (events.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(events.body.events).toStrictEqual([]);
  }, 60_000);

  it("rejects unknown generation template selections", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, {
      displayName: "Invalid template agent",
    });
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
    if (!template) {
      throw new Error("Expected a registered presentation runbook item");
    }

    const arms: readonly {
      readonly template: GenerationTemplateRequest;
      readonly message: string;
    }[] = [
      {
        template: {
          type: "presentation",
          selection: {
            templateId: "template:html-ppt-missing",
          },
        },
        message: "Unknown generation template",
      },
      {
        // A runbook with an unknown color system is still rejected by the
        // runbook flow.
        template: {
          type: "presentation",
          selection: {
            colorSystemId: "color-system:missing",
            templateId: template.templateId,
          },
        },
        message: "Unknown generation template color system",
      },
      {
        // A runbook id without a package is unknown; presentations are
        // runbook-only, so there is no separate "wrong target type" path.
        template: {
          type: "presentation",
          selection: {
            templateId: "template:html-ppt-missing",
          },
        },
        message: "Unknown generation template",
      },
      {
        template: {
          type: "video",
          selection: { stylePresetId: "video-style:missing" },
        },
        message: "Unknown video template",
      },
      {
        template: {
          type: "workflow",
          selection: { workflowTemplateId: "workflow-template:missing" },
        },
        message: "Unknown workflow template",
      },
      {
        template: {
          type: "website",
          selection: { websiteTemplateId: "website-template:missing" },
        },
        message: "Unknown website template",
      },
    ];
    for (const arm of arms) {
      const rejected = await chat.requestSendEvent(
        actor,
        {
          agentId: agent.agentId,
          prompt: "make something from a bad template",
          userMessage: userMessageWithTemplate(
            "make something from a bad template",
            arm.template,
          ),
        },
        [400],
      );
      expectApiError(rejected.body);
      expect(rejected.body.error.message).toBe(arm.message);
    }

    const events = await chat.requestThreadEvents(actor, {}, [200]);
    expect(events.status).toBe(200);
    if (events.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(events.body.events).toStrictEqual([]);
  }, 60_000);

  it("overlaps attachment metadata with thread model reconciliation", async () => {
    const { actor, agentId, providerId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);
    const thread = await chat.createThread(actor, {
      agentId,
      model: "claude-sonnet-5",
    });

    await seedBuiltInModelKey("gpt-5.6-terra");
    await api.updateOrgModelPolicies(actor, [
      {
        model: "gpt-5.6-terra",
        isDefault: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);

    const files = Array.from({ length: 2 }, (_, index) => {
      return {
        id: randomUUID(),
        filename: `overlap-${index + 1}.txt`,
        contentType: "text/plain",
        size: 40 + index,
      };
    });
    const objectsByKey = new Map(
      files.map((file) => {
        return [buildArtifactKeyV2(file.id, file.filename), file];
      }),
    );
    const releaseHeads = createDeferredPromise<void>(context.signal);
    let startedHeads = 0;
    let activeHeads = 0;
    context.mocks.s3.send.mockImplementation(
      async (command: unknown): Promise<unknown> => {
        if (command instanceof HeadObjectCommand) {
          const key = command.input.Key;
          const file =
            typeof key === "string" ? objectsByKey.get(key) : undefined;
          if (!file) {
            return {};
          }
          startedHeads += 1;
          activeHeads += 1;
          await releaseHeads.promise;
          activeHeads -= 1;
          return {
            ContentLength: file.size,
            ContentType: file.contentType,
            LastModified: new Date("2026-09-03T00:00:00.000Z"),
            Metadata: {
              "artifact-id": file.id,
              filename: encodeURIComponent(file.filename),
              "user-id": encodeURIComponent(actor.userId),
            },
          };
        }
        return { Contents: [] };
      },
    );

    const threadLock = await holdChatThreadRowLockFixture({
      threadId: thread.id,
      signal: context.signal,
    });
    const prompt = "read attachments during model recovery";
    const send = chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: thread.id,
        prompt,
        userMessage: {
          version: 1,
          parts: [
            ...files.map((file) => {
              return {
                type: "file" as const,
                fileId: file.id,
                filenameSnapshot: file.filename,
                contentType: file.contentType,
              };
            }),
            { type: "text", text: prompt },
          ],
        },
      },
      [201],
    );
    onTestFinished(async () => {
      if (!releaseHeads.settled()) {
        releaseHeads.resolve(undefined);
      }
      threadLock.release();
      await threadLock.done;
      const response = await send;
      if (response.status === 201 && response.body.runId) {
        await cancelChatRun(actor, response.body.runId);
      }
    });

    await expect
      .poll(threadLock.firstBlockedStatementKind)
      .toBe("select_for_update");
    await expect
      .poll(() => {
        return startedHeads;
      })
      .toBe(files.length);
    expect(activeHeads).toBe(files.length);

    releaseHeads.resolve(undefined);
    threadLock.release();
    await threadLock.done;
    const sent = await send;
    if (sent.status !== 201 || !sent.body.runId) {
      throw new Error("Expected attachment overlap send to create a run");
    }
    const run = await api.readRun(actor, sent.body.runId);
    const promptPositions = files.map((file) => {
      return run.prompt.indexOf(`[ID] ${file.id}`);
    });
    expect(
      promptPositions.every((position) => {
        return position >= 0;
      }),
    ).toBeTruthy();
    expect(promptPositions).toStrictEqual(
      [...promptPositions].sort((a, b) => {
        return a - b;
      }),
    );
  }, 90_000);

  it("preserves a later thread failure when attachment lookup rejects", async () => {
    const { actor, agentId } = await entitledChatActor();
    const fileId = randomUUID();
    const filename = "speculative-rejection.txt";
    const exactKey = buildArtifactKeyV2(fileId, filename);
    const releaseHead = createDeferredPromise<void>(context.signal);
    let startedHeads = 0;
    let rejectedHeads = 0;
    context.mocks.s3.send.mockImplementation(
      async (command: unknown): Promise<unknown> => {
        if (
          command instanceof HeadObjectCommand &&
          command.input.Key === exactKey
        ) {
          startedHeads += 1;
          await releaseHead.promise;
          rejectedHeads += 1;
          throw new Error("speculative attachment lookup failed");
        }
        return { Contents: [] };
      },
    );

    let responseSettled = false;
    const responsePromise = chat
      .requestSendEvent(
        actor,
        {
          agentId,
          threadId: randomUUID(),
          prompt: "preserve the missing thread failure",
          userMessage: {
            version: 1,
            parts: [
              {
                type: "file",
                fileId,
                filenameSnapshot: filename,
                contentType: "text/plain",
              },
              { type: "text", text: "preserve the missing thread failure" },
            ],
          },
        },
        [404],
      )
      .then((response) => {
        responseSettled = true;
        return response;
      });
    onTestFinished(async () => {
      if (!releaseHead.settled()) {
        releaseHead.resolve(undefined);
      }
      await responsePromise;
    });

    await expect
      .poll(() => {
        return startedHeads;
      })
      .toBe(1);
    await expect
      .poll(() => {
        return responseSettled;
      })
      .toBeTruthy();
    const response = await responsePromise;
    expectApiError(response.body);
    expect(response.body.error.message).toBe("Chat thread not found");

    releaseHead.resolve(undefined);
    await expect
      .poll(() => {
        return rejectedHeads;
      })
      .toBe(1);
  }, 30_000);

  it("resolves attachment metadata in ordered waves of four", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const files = Array.from({ length: 5 }, (_, index) => {
      return {
        id: randomUUID(),
        filename: `bounded-${index + 1}.txt`,
        contentType: `text/x-bounded-${index + 1}`,
        size: 100 + index,
      };
    });
    const objects = files.map((file) => {
      return {
        ...file,
        key: buildArtifactKeyV2(file.id, file.filename),
        prefix: buildArtifactPrefixV2(file.id),
      };
    });
    const objectsByPrefix = new Map(
      objects.map((object) => {
        return [object.prefix, object];
      }),
    );
    const objectsByKey = new Map(
      objects.map((object) => {
        return [object.key, object];
      }),
    );
    const firstWaveStarted = createDeferredPromise<void>(context.signal);
    const releaseFirstWave = createDeferredPromise<void>(context.signal);
    let matchingListRequests = 0;
    let startedHeads = 0;
    let activeHeads = 0;
    let peakActiveHeads = 0;
    context.mocks.s3.send.mockImplementation(
      async (command: unknown): Promise<unknown> => {
        if (command instanceof ListObjectsV2Command) {
          const prefix = command.input.Prefix;
          const object =
            typeof prefix === "string"
              ? objectsByPrefix.get(prefix)
              : undefined;
          if (!object) {
            return { Contents: [] };
          }
          matchingListRequests += 1;
          return {
            Contents: [
              {
                Key: object.key,
                Size: object.size,
                LastModified: new Date("2026-08-18T00:00:00.000Z"),
              },
            ],
          };
        }
        if (command instanceof HeadObjectCommand) {
          const key = command.input.Key;
          const object =
            typeof key === "string" ? objectsByKey.get(key) : undefined;
          if (!object) {
            return {};
          }
          startedHeads += 1;
          activeHeads += 1;
          peakActiveHeads = Math.max(peakActiveHeads, activeHeads);
          if (startedHeads === 4) {
            firstWaveStarted.resolve(undefined);
          }
          await releaseFirstWave.promise;
          activeHeads -= 1;
          return {
            ContentLength: object.size,
            ContentType: object.contentType,
            LastModified: new Date("2026-08-18T00:00:00.000Z"),
            Metadata: {
              "artifact-id": object.id,
              filename: encodeURIComponent(object.filename),
              "user-id": encodeURIComponent(actor.userId),
            },
          };
        }
        return {};
      },
    );

    const prompt = "read the bounded attachment set";
    const send = chat.requestSendEvent(
      actor,
      {
        agentId,
        prompt,
        userMessage: {
          version: 1,
          parts: [
            ...files.map((file) => {
              return {
                type: "file" as const,
                fileId: file.id,
                filenameSnapshot: file.filename,
                contentType: file.contentType,
              };
            }),
            { type: "text", text: prompt },
          ],
        },
      },
      [201],
    );
    onTestFinished(async () => {
      if (!releaseFirstWave.settled()) {
        releaseFirstWave.resolve(undefined);
      }
      const response = await send;
      if (response.status === 201 && response.body.runId) {
        await cancelChatRun(actor, response.body.runId);
      }
    });

    await firstWaveStarted.promise;
    expect(startedHeads).toBe(4);
    expect(activeHeads).toBe(4);
    expect(peakActiveHeads).toBe(4);
    releaseFirstWave.resolve(undefined);

    const sent = await send;
    expect(sent.status).toBe(201);
    if (sent.status !== 201 || !sent.body.runId) {
      throw new Error("Expected the bounded attachment send to create a run");
    }
    expect(startedHeads).toBe(5);
    expect(peakActiveHeads).toBe(4);
    expect(matchingListRequests).toBe(0);

    const run = await api.readRun(actor, sent.body.runId);
    const promptPositions = files.map((file) => {
      return run.prompt.indexOf(`[ID] ${file.id}`);
    });
    expect(
      promptPositions.every((position) => {
        return position >= 0;
      }),
    ).toBeTruthy();
    expect(promptPositions).toStrictEqual(
      [...promptPositions].sort((a, b) => {
        return a - b;
      }),
    );

    const catalog = await chat.listArtifactCatalog(actor, {
      chatThreadId: sent.body.threadId,
      kind: "file",
      limit: 20,
    });
    for (const file of files) {
      const summary = catalog.artifacts.find((artifact) => {
        return artifact.title === file.filename;
      });
      if (!summary) {
        throw new Error(`Expected catalog entry for ${file.filename}`);
      }
      const detail = await chat.getArtifactCatalogEntry(actor, summary.id);
      expect(detail.kind).toBe("file");
      if (detail.kind !== "file") {
        throw new Error(`Expected file catalog entry for ${file.filename}`);
      }
      expect(detail.file).toMatchObject({
        filename: file.filename,
        contentType: file.contentType,
        size: file.size,
      });
    }
  }, 60_000);

  it("falls back to v2 listing when the attachment filename hint is stale", async () => {
    const { actor, agentId } = await entitledChatActor();
    const fileId = randomUUID();
    const filenameSnapshot = "stale-extension.txt";
    const storedFilename = "current-extension.png";
    const exactKey = buildArtifactKeyV2(fileId, filenameSnapshot);
    const storedKey = buildArtifactKeyV2(fileId, storedFilename);
    const prefix = buildArtifactPrefixV2(fileId);
    const operations: string[] = [];
    context.mocks.s3.send.mockImplementation(
      (command: unknown): Promise<unknown> => {
        if (command instanceof HeadObjectCommand) {
          if (command.input.Key === exactKey) {
            operations.push("head:exact");
            const notFound = new Error("exact attachment key not found");
            notFound.name = "NotFound";
            return Promise.reject(notFound);
          }
          if (command.input.Key === storedKey) {
            operations.push("head:listed");
            return Promise.resolve({
              ContentLength: 42,
              ContentType: "image/png",
              LastModified: new Date("2026-08-24T00:00:00.000Z"),
              Metadata: {
                "artifact-id": fileId,
                filename: encodeURIComponent(storedFilename),
                "user-id": encodeURIComponent(actor.userId),
              },
            });
          }
          return Promise.resolve({});
        }
        if (
          command instanceof ListObjectsV2Command &&
          command.input.Prefix === prefix
        ) {
          operations.push("list:v2");
          return Promise.resolve({
            Contents: [
              {
                Key: storedKey,
                Size: 42,
                LastModified: new Date("2026-08-24T00:00:00.000Z"),
              },
            ],
          });
        }
        return Promise.resolve({ Contents: [] });
      },
    );

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "read the stale filename attachment",
      userMessage: {
        version: 1,
        parts: [
          {
            type: "file",
            fileId,
            filenameSnapshot,
            contentType: "image/png",
          },
          { type: "text", text: "read the stale filename attachment" },
        ],
      },
    });

    expect(operations).toStrictEqual(["head:exact", "list:v2", "head:listed"]);
    const created = await api.readRun(actor, run.runId);
    expect(created.prompt).toContain(`[Web file] ${filenameSnapshot}`);
  }, 60_000);

  it("falls back to v2 listing when the exact head lacks size", async () => {
    const { actor, agentId } = await entitledChatActor();
    const fileId = randomUUID();
    const filename = "incomplete-head.txt";
    const key = buildArtifactKeyV2(fileId, filename);
    const prefix = buildArtifactPrefixV2(fileId);
    const operations: string[] = [];
    let headRequests = 0;
    context.mocks.s3.send.mockImplementation(
      (command: unknown): Promise<unknown> => {
        if (command instanceof HeadObjectCommand && command.input.Key === key) {
          headRequests += 1;
          operations.push(headRequests === 1 ? "head:exact" : "head:listed");
          return Promise.resolve({
            ContentType: "text/plain",
            LastModified: new Date("2026-08-24T00:00:00.000Z"),
            Metadata: {
              "artifact-id": fileId,
              filename: encodeURIComponent(filename),
              "user-id": encodeURIComponent(actor.userId),
            },
          });
        }
        if (
          command instanceof ListObjectsV2Command &&
          command.input.Prefix === prefix
        ) {
          operations.push("list:v2");
          return Promise.resolve({
            Contents: [
              {
                Key: key,
                Size: 73,
                LastModified: new Date("2026-08-24T00:00:00.000Z"),
              },
            ],
          });
        }
        return Promise.resolve({ Contents: [] });
      },
    );

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "read the incomplete head attachment",
      userMessage: {
        version: 1,
        parts: [
          {
            type: "file",
            fileId,
            filenameSnapshot: filename,
            contentType: "text/plain",
          },
          { type: "text", text: "read the incomplete head attachment" },
        ],
      },
    });

    expect(operations).toStrictEqual(["head:exact", "list:v2", "head:listed"]);
    const catalog = await chat.listArtifactCatalog(actor, {
      chatThreadId: run.threadId,
      kind: "file",
      limit: 20,
    });
    const summary = catalog.artifacts.find((artifact) => {
      return artifact.title === filename;
    });
    if (!summary) {
      throw new Error("Expected incomplete-head attachment in the catalog");
    }
    const detail = await chat.getArtifactCatalogEntry(actor, summary.id);
    expect(detail.kind).toBe("file");
    if (detail.kind !== "file") {
      throw new Error("Expected incomplete-head file catalog entry");
    }
    expect(detail.file.size).toBe(73);
  }, 60_000);

  it("does not create a run when an attachment is missing", async () => {
    const { actor, agentId } = await entitledChatActor();
    const fileId = randomUUID();
    const filename = "missing.txt";
    const exactKey = buildArtifactKeyV2(fileId, filename);
    let exactHeadRequests = 0;
    context.mocks.s3.send.mockImplementation(
      (command: unknown): Promise<unknown> => {
        if (
          command instanceof HeadObjectCommand &&
          command.input.Key === exactKey
        ) {
          exactHeadRequests += 1;
          return Promise.resolve({
            ContentLength: 42,
            ContentType: "text/plain",
            LastModified: new Date("2026-08-24T00:00:00.000Z"),
            Metadata: {
              "artifact-id": fileId,
              filename: encodeURIComponent(filename),
              "user-id": encodeURIComponent(`${actor.userId}-other`),
            },
          });
        }
        return Promise.resolve({ Contents: [] });
      },
    );
    const model = await chat.getDefaultCreateThreadModel(actor);
    const prompt = "reject the missing attachment";
    const response = await requestSendEventRaw(actor, {
      agentId,
      model,
      prompt,
      userMessage: {
        version: 1,
        parts: [
          {
            type: "file",
            fileId,
            filenameSnapshot: filename,
            contentType: "text/plain",
          },
          { type: "text", text: prompt },
        ],
      },
      hasTextContent: true,
    });

    expect(response).toStrictEqual({
      status: 500,
      body: { error: "Internal server error" },
    });
    expect(exactHeadRequests).toBe(1);
    const runs = await api.listAgentRuns(actor, {
      status: "queued,pending,running,completed,failed,timeout,cancelled",
      limit: 100,
    });
    expect(
      runs.runs.some((run) => {
        return run.prompt === prompt;
      }),
    ).toBeFalsy();
  }, 60_000);

  it("does not create a run when attachment storage fails", async () => {
    const { actor, agentId } = await entitledChatActor();
    const model = await chat.getDefaultCreateThreadModel(actor);
    context.mocks.s3.send.mockRejectedValue(
      new Error("object storage unavailable"),
    );
    const prompt = "reject the failed attachment lookup";
    const response = await requestSendEventRaw(actor, {
      agentId,
      model,
      prompt,
      userMessage: {
        version: 1,
        parts: [
          {
            type: "file",
            fileId: randomUUID(),
            filenameSnapshot: "unavailable.txt",
            contentType: "text/plain",
          },
          { type: "text", text: prompt },
        ],
      },
      hasTextContent: true,
    });

    expect(response).toStrictEqual({
      status: 500,
      body: { error: "Internal server error" },
    });
    const runs = await api.listAgentRuns(actor, {
      status: "queued,pending,running,completed,failed,timeout,cancelled",
      limit: 100,
    });
    expect(
      runs.runs.some((run) => {
        return run.prompt === prompt;
      }),
    ).toBeFalsy();
  }, 60_000);

  it("does not create a run when attachment resolution is aborted", async () => {
    const { actor, agentId } = await entitledChatActor();
    const model = await chat.getDefaultCreateThreadModel(actor);
    const controller = new AbortController();
    const abortError = new Error(
      "client disconnected during attachment lookup",
    );
    abortError.name = "AbortError";
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (command instanceof ListObjectsV2Command) {
        controller.abort(abortError);
      }
      return Promise.resolve({ Contents: [] });
    });
    const prompt = "abort the attachment lookup";
    const response = await requestSendEventRaw(
      actor,
      {
        agentId,
        model,
        prompt,
        userMessage: {
          version: 1,
          parts: [
            {
              type: "file",
              fileId: randomUUID(),
              filenameSnapshot: "aborted.txt",
              contentType: "text/plain",
            },
            { type: "text", text: prompt },
          ],
        },
        hasTextContent: true,
      },
      controller.signal,
    );

    expect(controller.signal.aborted).toBeTruthy();
    expect(response).toStrictEqual({
      status: 500,
      body: { error: "Internal server error" },
    });
    const runs = await api.listAgentRuns(actor, {
      status: "queued,pending,running,completed,failed,timeout,cancelled",
      limit: 100,
    });
    expect(
      runs.runs.some((run) => {
        return run.prompt === prompt;
      }),
    ).toBeFalsy();
  }, 60_000);

  it("persists attachments and injects them into the run prompt", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const fileId = randomUUID();
    const filename = "diagram final 100%.png";
    chat.mockCompletedUploadObject(actor, fileId, filename, 42);

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "read this file",
      userMessage: {
        version: 1,
        parts: [
          {
            type: "file",
            fileId,
            filenameSnapshot: filename,
            contentType: "image/png",
          },
          { type: "text", text: "read this file" },
        ],
      },
    });

    const created = await api.readRun(actor, run.runId);
    expect(created.prompt).toContain(`[Web file] ${filename} (image/png)`);
    expect(created.prompt).toContain(`[ID] ${fileId}`);
    expect(created.appendSystemPrompt).toContain("okou web download-file -h");
    expect(created.appendSystemPrompt).toContain("okou web upload-file -h");

    const messages = await waitForThreadMessages(
      actor,
      run.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.eventType === "input.prompt" &&
            message.userMessage?.parts.some((part) => {
              return part.type === "file";
            }) === true
          );
        });
      },
    );
    const attachedMessage = userMessages(messages.events).find((message) => {
      return message.eventType === "input.prompt";
    });
    const attached = attachedMessage?.userMessage?.parts.find((part) => {
      return part.type === "file";
    });
    expect(attached).toMatchObject({
      type: "file",
      fileId,
      filenameSnapshot: filename,
      contentType: "image/png",
    });
    await cancelChatRun(actor, run.runId);
  }, 60_000);

  it("projects one structured annotated file through its rendered derivative", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const fileId = randomUUID();
    const annotatedFileId = randomUUID();
    const filename = "billing-page.png";
    chat.mockCompletedUploadObjects(actor, [
      { id: fileId, filename, size: 42 },
      { id: annotatedFileId, filename: "billing-page.annotated.png", size: 54 },
    ]);
    const filePart = {
      type: "file" as const,
      fileId,
      filenameSnapshot: filename,
      contentType: "image/png",
      annotatedFileId,
      annotations: {
        marks: [
          {
            id: "spacing-mark",
            ordinal: 1,
            shape: "box" as const,
            rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
            ink: "#5E6AD2",
            note: "Tighten this spacing",
          },
        ],
      },
    };

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "fix this",
      userMessage: {
        version: 1,
        parts: [filePart, { type: "text", text: "fix this" }],
      },
    });

    const created = await api.readRun(actor, run.runId);
    expect(created.prompt).toContain(
      `[Web file] billing-page.annotated.png (image/png)\n   [ID] ${annotatedFileId}`,
    );
    expect(created.prompt).toContain(
      `[Image annotations]\n${JSON.stringify(filePart)}`,
    );
    expect(created.prompt).not.toContain(
      `[Web file] ${filename} (image/png)\n   [ID] ${fileId}`,
    );

    const messages = await waitForThreadMessages(
      actor,
      run.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.eventType === "input.prompt" &&
            message.userMessage.parts.some((part) => {
              return part.type === "file" && part.fileId === fileId;
            })
          );
        });
      },
    );
    const attached = userMessages(messages.events)
      .filter((message) => {
        return message.eventType === "input.prompt";
      })
      .flatMap((message) => {
        return message.eventType === "input.prompt"
          ? message.userMessage.parts
          : [];
      })
      .find((part) => {
        return part.type === "file";
      });
    expect(attached).toStrictEqual(filePart);
    await cancelChatRun(actor, run.runId);
  }, 60_000);

  it("keeps a legacy VM0 attachment on the VM0 CDN for an Okou send", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const fileId = randomUUID();
    const filename = "legacy-brand.txt";
    chat.mockCompletedUploadObject(actor, fileId, filename, 24);

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "read the legacy attachment",
      userMessage: {
        version: 1,
        parts: [
          {
            type: "file",
            fileId,
            filenameSnapshot: filename,
            contentType: "text/plain",
          },
          { type: "text", text: "read the legacy attachment" },
        ],
      },
    });
    await flushWaitUntilForTest();

    const catalog = await chat.listArtifactCatalog(actor, {
      chatThreadId: run.threadId,
      kind: "file",
      limit: 20,
    });
    const summary = catalog.artifacts.find((artifact) => {
      return artifact.title === filename;
    });
    if (!summary) {
      throw new Error("Expected the legacy attachment in the artifact catalog");
    }
    const detail = await chat.getArtifactCatalogEntry(actor, summary.id);
    if (detail.kind !== "file") {
      throw new Error("Expected a file artifact for the legacy attachment");
    }
    expect(detail.file.url).toMatch(/^https:\/\/cdn\.vm7\.io\//);
    expect(detail.file.url).not.toMatch(
      /^https:\/\/(?:a\.okou\.io|cdn\.okou\.io)\//,
    );

    await cancelChatRun(actor, run.runId);
  }, 60_000);
});

describe("CHAT-02: queued attachments on auto-send", () => {
  it("preserves structured part order when a queued message is promoted", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "anchor before the structured queue item",
    });
    const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);

    const fileId = randomUUID();
    const queuedId = randomUUID();
    const queuedPrompt =
      "queued structured text\n\n" +
      "The user quoted this part of your reply:\n\n" +
      "> Queued quote\n\nRevise after the anchor completes";
    const userMessage: UserMessageInputDocument = {
      version: 1,
      parts: [
        {
          type: "file",
          fileId,
          filenameSnapshot: "ordered.txt",
          contentType: "text/plain",
        },
        { type: "text", text: "queued structured text" },
        {
          type: "feedback",
          quote: "Queued quote",
          note: [{ type: "text", text: "Revise after the anchor completes" }],
        },
      ],
    };
    chat.mockCompletedUploadObject(actor, fileId, "ordered.txt", 12);
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: queuedPrompt,
        userMessage,
        clientEventId: queuedId,
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
    await flushWaitUntilForTest();
    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === queuedId && message.runId !== undefined
          );
        });
      },
    );
    const promoted = userMessages(messages.events).find(
      (message): message is PromptMessage => {
        return (
          message.eventType === "input.prompt" &&
          message.revokesEventId === queuedId
        );
      },
    );
    if (!promoted?.runId) {
      throw new Error("Expected the structured queued message to auto-send");
    }
    expect(promoted.userMessage).toStrictEqual({
      version: 1,
      parts: [
        ...userMessage.parts,
        {
          type: "model",
          selectedModel: "claude-sonnet-5",
        },
      ],
    });

    const run = await api.readRun(actor, promoted.runId);
    expect(run.prompt).toBe(
      [
        `[Web file] ordered.txt (text/plain)\n   [ID] ${fileId}`,
        queuedPrompt,
      ].join("\n\n"),
    );
    await cancelChatRun(actor, promoted.runId);
  }, 90_000);

  it("carries queued attachments into the auto-sent follow-up run", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "anchor before the queued attachment",
    });
    const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);

    const fileId = randomUUID();
    const secondFileId = randomUUID();
    const queuedId = randomUUID();
    chat.mockCompletedUploadObjects(actor, [
      { id: fileId, filename: "notes.txt", size: 12 },
      { id: secondFileId, filename: "details.json", size: 24 },
    ]);
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "queued with attachment",
        clientEventId: queuedId,
        realAgentInPreview: true,
        userMessage: {
          version: 1,
          parts: [
            {
              type: "file",
              fileId,
              filenameSnapshot: "notes.txt",
              contentType: "text/plain",
            },
            {
              type: "file",
              fileId: secondFileId,
              filenameSnapshot: "details.json",
              contentType: "application/json",
            },
            { type: "text", text: "queued with attachment" },
          ],
        },
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });
    // Completing the anchor run promotes the queued message into a fresh
    // run whose prompt carries the resolved attachment references.
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
    await flushWaitUntilForTest();
    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === queuedId && message.runId !== undefined
          );
        });
      },
    );
    const promoted = userMessages(messages.events).find(
      (message): message is PromptMessage => {
        return (
          message.eventType === "input.prompt" &&
          message.revokesEventId === queuedId
        );
      },
    );
    if (!promoted?.runId) {
      throw new Error("Expected the queued message to auto-send into a run");
    }
    expect(promoted.content).toBeNull();
    expect(chatEventDisplayText(promoted)).toBe("queued with attachment");
    expect(promoted.userMessage?.parts).toStrictEqual(
      expect.arrayContaining([
        {
          type: "file",
          fileId,
          filenameSnapshot: "notes.txt",
          contentType: "text/plain",
        },
        {
          type: "file",
          fileId: secondFileId,
          filenameSnapshot: "details.json",
          contentType: "application/json",
        },
      ]),
    );
    const original = userMessages(messages.events).find((message) => {
      return message.id === queuedId;
    });
    if (!original) {
      throw new Error("Expected the original queued message");
    }
    expect(original).toMatchObject({
      id: queuedId,
      content: null,
    });
    expect(chatEventDisplayText(original)).toBe("queued with attachment");
    expect(original.runId).toBeUndefined();

    const followUp = await api.readRun(actor, promoted.runId);
    expect(followUp.prompt).toContain("queued with attachment");
    expect(followUp.prompt).toContain("[Web file] notes.txt (text/plain)");
    expect(followUp.prompt).toContain(`[ID] ${fileId}`);
    expect(followUp.prompt).toContain(
      "[Web file] details.json (application/json)",
    );
    expect(followUp.prompt).toContain(`[ID] ${secondFileId}`);
    await cancelChatRun(actor, promoted.runId);
  }, 90_000);
});
