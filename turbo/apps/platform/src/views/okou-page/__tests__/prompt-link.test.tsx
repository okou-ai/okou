import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import {
  chatEventsContract,
  chatThreadsContract,
  type ChatEventSendBody,
  type UserMessagePart,
} from "@okouai/api-contracts/contracts/chat-threads";
import { expect, test } from "vitest";

import { setupPage, startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname, search } from "../../../signals/location.ts";

const context = testContext();

const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const DESIGN_AGENT_ID = "c0000000-0000-4000-a000-000000000002";

interface PromptLaunchCapture {
  readonly createdThreads: {
    readonly connectorSelections: readonly unknown[] | undefined;
    readonly model: string | undefined;
  }[];
  readonly sends: ChatEventSendBody[];
}

function capturePromptLaunch(): PromptLaunchCapture {
  const capture: PromptLaunchCapture = { createdThreads: [], sends: [] };
  context.mocks.api(chatThreadsContract.create, ({ body, respond }) => {
    capture.createdThreads.push({
      connectorSelections: body.connectorSelections,
      model: body.model,
    });
    return respond(201, {
      id: body.clientThreadId ?? "b0000000-0000-4000-a000-000000000001",
      title: null,
      createdAt: "2026-03-10T00:00:00Z",
      selectedModel: body.model ?? "claude-sonnet-4-6",
      serviceTier: body.serviceTier ?? null,
    });
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    if (body.prompt === undefined) {
      throw new Error("Expected a prompt launch request");
    }
    capture.sends.push(body);
    return respond(201, {
      runId: "a0000000-0000-4000-a000-000000000001",
      threadId: body.threadId ?? "b0000000-0000-4000-a000-000000000001",
      status: "completed",
      createdAt: "2026-03-10T00:00:00Z",
    });
  });
  return capture;
}

function mountedComposer(): HTMLElement {
  const composer = document.querySelector(
    '[data-slot="chat-composer-card"] [contenteditable="true"]',
  );
  if (!(composer instanceof HTMLElement)) {
    throw new Error("Message composer not found");
  }
  return composer;
}

async function waitForDraft(prompt: string): Promise<HTMLElement> {
  await waitFor(() => {
    expect(mountedComposer()).toHaveTextContent(prompt);
  });
  return mountedComposer();
}

async function waitForPromptLaunch(
  prompt: string,
  capture: PromptLaunchCapture,
): Promise<ChatEventSendBody> {
  await waitFor(() => {
    expect(screen.getByText(prompt)).toBeInTheDocument();
    expect(capture.createdThreads).toHaveLength(1);
    expect(capture.sends).toHaveLength(1);
  });
  const send = capture.sends[0];
  if (!send) {
    throw new Error("Prompt launch request was not captured");
  }
  return send;
}

function userMessageParts(send: ChatEventSendBody): readonly UserMessagePart[] {
  if (!send.userMessage) {
    throw new Error("Prompt launch did not include a structured user message");
  }
  return send.userMessage.parts;
}

function templatePart(send: ChatEventSendBody): UserMessagePart {
  const part = userMessageParts(send).find((candidate) => {
    return candidate.type === "template";
  });
  if (!part) {
    throw new Error("Prompt launch did not include a template snapshot");
  }
  return part;
}

test("A prompt link prefills a specific agent's chat", async () => {
  const user = userEvent.setup();
  const capture = capturePromptLaunch();
  context.mocks.data.agents([
    { agentId: DEFAULT_AGENT_ID, displayName: "General" },
    { agentId: DESIGN_AGENT_ID, displayName: "Design" },
  ]);
  await setupPage({
    context,
    path: `/agents/${DESIGN_AGENT_ID}/chat?prompt=Draft%20a%20launch%20brief`,
  });

  const composer = await waitForDraft("Draft a launch brief");
  await user.type(composer, " for Friday");

  expect(composer).toHaveTextContent("Draft a launch brief for Friday");
  expect(pathname()).toBe(`/agents/${DESIGN_AGENT_ID}/chat`);
  expect(search()).toBe("");
  expect(capture.createdThreads).toHaveLength(0);
  expect(capture.sends).toHaveLength(0);
});

test("A prompt link prefills a new chat from Home", async () => {
  const user = userEvent.setup();
  const capture = capturePromptLaunch();
  await setupPage({
    context,
    path: "/?prompt=Outline%20the%20customer%20interview",
  });

  const composer = await waitForDraft("Outline the customer interview");
  await user.type(composer, " questions");

  expect(composer).toHaveTextContent(
    "Outline the customer interview questions",
  );
  expect(pathname()).toBe(`/agents/${DEFAULT_AGENT_ID}/chat`);
  expect(search()).toBe("");
  expect(capture.createdThreads).toHaveLength(0);
  expect(capture.sends).toHaveLength(0);
});

test("A prompt route starts a chat with its selected model", async () => {
  const capture = capturePromptLaunch();
  await setupPage({
    context,
    path: "/prompt?prompt=Compare%20the%20launch%20options&model=gpt-5.6-luna&connector=github",
  });

  const send = await waitForPromptLaunch("Compare the launch options", capture);
  const parts = userMessageParts(send);

  expect(capture.createdThreads[0]).toStrictEqual({
    connectorSelections: undefined,
    model: "gpt-5.6-luna",
  });
  expect(send.prompt).toBe("Compare the launch options");
  expect(parts).toContainEqual({
    type: "text",
    text: "Compare the launch options",
  });
  expect(parts).toContainEqual({
    type: "model",
    selectedModel: "gpt-5.6-luna",
  });
  expect(JSON.stringify(parts)).not.toContain("github");
  expect(search()).toBe("");
});

test("A prompt link starts an illustration chat with its selected style", async () => {
  const capture = capturePromptLaunch();
  await setupPage({
    context,
    path: "/prompt?prompt=Illustrate%20a%20quiet%20reading%20room&template=cozy-parlor",
  });

  const send = await waitForPromptLaunch(
    "Illustrate a quiet reading room",
    capture,
  );

  expect(templatePart(send)).toStrictEqual({
    type: "template",
    titleSnapshot: "Cozy Parlor",
    template: {
      type: "illustration",
      selection: { illustrationStyleId: "image-style:cozy-parlor" },
    },
  });
});

test("A prompt link starts a presentation chat with its selected template", async () => {
  const capture = capturePromptLaunch();
  await setupPage({
    context,
    path: "/prompt?prompt=Create%20the%20launch%20deck&template=playful-launch-presentation",
  });

  const send = await waitForPromptLaunch("Create the launch deck", capture);

  expect(screen.getByText("Sunburst playroom")).toBeInTheDocument();
  expect(templatePart(send)).toStrictEqual({
    type: "template",
    titleSnapshot: "Sunburst playroom",
    template: {
      type: "presentation",
      selection: {
        templateId: "template:html-ppt-playful-launch",
        colorSystemId: "color-system:carnival",
        previewUrl:
          "https://static.vm0.io/vm0/artifact-templates/presentation/daf7c2d1-5195-4c09-ad4b-8d85778fc104/playful-launch-presentation.html",
      },
    },
  });
  expect(capture.createdThreads[0]?.model).toBe("deepseek-v4.1-flash");
  expect(userMessageParts(send)).toContainEqual({
    type: "model",
    selectedModel: "deepseek-v4.1-flash",
  });
});

test("A prompt link starts a video chat with its selected style", async () => {
  const capture = capturePromptLaunch();
  await setupPage({
    context,
    path: "/prompt?prompt=Create%20a%20cinematic%20product%20film&template=epic-grandeur",
  });

  const send = await waitForPromptLaunch(
    "Create a cinematic product film",
    capture,
  );

  expect(templatePart(send)).toStrictEqual({
    type: "template",
    titleSnapshot: "Epic Grandeur",
    template: {
      type: "video",
      selection: { stylePresetId: "video-template:epic-grandeur" },
    },
  });
});

test("A prompt link starts a website chat with its selected template", async () => {
  const capture = capturePromptLaunch();
  await setupPage({
    context,
    path: "/prompt?prompt=Build%20a%20high-contrast%20portfolio&template=black-slabs",
  });

  const send = await waitForPromptLaunch(
    "Build a high-contrast portfolio",
    capture,
  );

  expect(templatePart(send)).toStrictEqual({
    type: "template",
    titleSnapshot: "Black Slabs",
    template: {
      type: "website",
      selection: { websiteTemplateId: "website-template:black-slabs" },
    },
  });
});

test("An unavailable model leaves a prompt link recoverable", async () => {
  const capture = capturePromptLaunch();
  const savedDraft = {
    version: 1 as const,
    parts: [{ type: "text" as const, text: "Keep my unrelated draft" }],
  };
  const draftUpdates: unknown[] = [];
  context.mocks.data.orgModelPolicies([]);
  context.mocks.api(agentDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: savedDraft,
      draftAttachments: null,
    });
  });
  context.mocks.api(agentDraftContract.patch, ({ body, respond }) => {
    draftUpdates.push(body);
    return respond(204);
  });
  await startPage({
    context,
    path: "/prompt?prompt=Use%20the%20requested%20model&model=gpt-5.6-sol",
  });

  await waitFor(() => {
    expect(
      screen.getByText("The selected model is not available"),
    ).toBeInTheDocument();
  });

  expect(pathname()).toBe("/prompt");
  expect(new URLSearchParams(search()).get("prompt")).toBe(
    "Use the requested model",
  );
  expect(new URLSearchParams(search()).get("model")).toBe("gpt-5.6-sol");
  expect(capture.createdThreads).toHaveLength(0);
  expect(capture.sends).toHaveLength(0);
  expect(draftUpdates).toHaveLength(0);
  expect(savedDraft.parts[0]?.text).toBe("Keep my unrelated draft");
});
