import { Blob as NativeBlob, File as NativeFile } from "node:buffer";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { AUTO_RUN_MODEL } from "@okouai/core/auto-run-model";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import {
  chatEventsContract,
  chatThreadsContract,
  type ChatEventSendBody,
  type UserMessagePart,
} from "@okouai/api-contracts/contracts/chat-threads";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
  startPage,
} from "../../../__tests__/page-helper.ts";
import {
  createTestRuntime,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { hash, pathname, search } from "../../../signals/location.ts";
import { composerModelTrigger } from "./chat-composer-test-helpers.ts";
import {
  closeModelPanel,
  modelOption,
  openModelPanel,
} from "./chat-model-panel-test-helpers.ts";
import { findButton } from "./chat-run-test-fixtures.ts";
import { installConnectedPersonalSubscriptions } from "./personal-subscription-fixtures.ts";

const context = testContext();

const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const DESIGN_AGENT_ID = "c0000000-0000-4000-a000-000000000002";

interface PromptLaunchCapture {
  readonly createdThreads: {
    readonly connectorSelections: readonly unknown[] | undefined;
    readonly model: string | null | undefined;
    readonly reasoningEffort: string | undefined;
    readonly serviceTier: string | null | undefined;
  }[];
  readonly sends: ChatEventSendBody[];
}

function capturePromptLaunch(sendGate?: Promise<void>): PromptLaunchCapture {
  const capture: PromptLaunchCapture = { createdThreads: [], sends: [] };
  context.mocks.api(chatThreadsContract.create, ({ body, respond }) => {
    capture.createdThreads.push({
      connectorSelections: body.connectorSelections,
      model: body.model,
      reasoningEffort: body.reasoningEffort,
      serviceTier: body.serviceTier,
    });
    return respond(201, {
      id: body.clientThreadId ?? "b0000000-0000-4000-a000-000000000001",
      title: null,
      createdAt: "2026-03-10T00:00:00Z",
      // The response names the run model; an Auto thread runs on Auto's.
      selectedModel:
        body.model === undefined
          ? "claude-sonnet-5"
          : (body.model ?? AUTO_RUN_MODEL),
      serviceTier: body.serviceTier ?? null,
    });
  });
  context.mocks.api(chatEventsContract.send, async ({ body, respond }) => {
    if (body.prompt === undefined) {
      throw new Error("Expected a prompt launch request");
    }
    capture.sends.push(body);
    await sendGate;
    return respond(201, {
      threadId: body.threadId ?? "b0000000-0000-4000-a000-000000000001",
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

test("A prompt route starts a chat with its selected personal subscription model", async () => {
  context.mocks.data.personalModelProviders([
    {
      id: "00000000-0000-4000-a000-000000000701",
      type: "codex-oauth-token",
      framework: "codex",
      needsReconnect: false,
      lastRefreshErrorCode: null,
      createdAt: "2026-03-10T00:00:00Z",
      updatedAt: "2026-03-10T00:00:00Z",
    },
  ]);
  context.mocks.data.userModelPreference({
    selectedModel: "gpt-6-astra",
    serviceTier: "priority",
    modelSettings: { "gpt-6-astra": { effort: "low" } },
    selectedImageModel: null,
    updatedAt: null,
  });
  const capture = capturePromptLaunch();
  await setupPage({
    context,
    path: "/prompt?prompt=Compare%20the%20launch%20options&model=gpt-6-astra&connector=github",
  });

  const send = await waitForPromptLaunch("Compare the launch options", capture);
  const parts = userMessageParts(send);

  expect(capture.createdThreads[0]).toStrictEqual({
    connectorSelections: undefined,
    model: "gpt-6-astra",
    reasoningEffort: undefined,
    serviceTier: null,
  });
  expect(send.prompt).toBe("Compare the launch options");
  expect(parts).toContainEqual({
    type: "text",
    text: "Compare the launch options",
  });
  expect(parts).toContainEqual({
    type: "model",
    selectedModel: "gpt-6-astra",
  });
  expect(JSON.stringify(parts)).not.toContain("github");
  expect(send.runOptions?.codexServiceTier).toBeUndefined();
  expect(search()).toBe("");
});

test.each(["", "&model=unknown-model"])(
  "A prompt link uses the member default when its model is missing or invalid: %s",
  async (modelParam) => {
    installConnectedPersonalSubscriptions(context);
    context.mocks.data.userModelPreference({
      selectedModel: "gpt-6-astra",
      serviceTier: "priority",
      modelSettings: { "gpt-6-astra": { effort: "low" } },
      selectedImageModel: null,
      updatedAt: null,
    });
    const capture = capturePromptLaunch();
    await setupPage({
      context,
      path: `/prompt?prompt=Use%20my%20default%20model${modelParam}`,
    });

    const send = await waitForPromptLaunch("Use my default model", capture);

    expect(capture.createdThreads[0]).toMatchObject({
      model: "gpt-6-astra",
      reasoningEffort: "low",
      serviceTier: "priority",
    });
    expect(send.runOptions?.codexServiceTier).toBe("fast");
    expect(userMessageParts(send)).toContainEqual({
      type: "model",
      selectedModel: "gpt-6-astra",
      serviceTier: "priority",
    });
  },
);

test("Completing a prompt link preserves a model chosen in a later composer", async () => {
  installConnectedPersonalSubscriptions(context);
  context.mocks.data.userModelPreference({
    selectedModel: "gpt-6-astra",
    serviceTier: null,
    modelSettings: {},
    selectedImageModel: null,
    updatedAt: null,
  });
  const sendGate = context.mocks.deferred<void>();
  const capture = capturePromptLaunch(sendGate.promise);
  const page = await startPage({
    context,
    path: "/prompt?prompt=Finish%20the%20linked%20task&model=gpt-6-astra",
  });
  await waitForPromptLaunch("Finish the linked task", capture);

  act(() => {
    window.history.pushState(null, "", `/agents/${DEFAULT_AGENT_ID}/chat`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(
    screen.findByTestId("chat-greeting"),
  ).resolves.toBeInTheDocument();
  const panel = await openModelPanel("GPT 6 Astra");
  click(modelOption(/^Claude Sonnet 5\.5/u, panel));
  await expect(
    composerModelTrigger("Claude Sonnet 5.5"),
  ).resolves.toBeInTheDocument();
  await closeModelPanel();

  sendGate.resolve();
  await page.ready;

  await expect(
    composerModelTrigger("Claude Sonnet 5.5"),
  ).resolves.toBeInTheDocument();
  await fill(mountedComposer(), "Send my next task with this model");
  click(await findButton("Send"));
  await waitFor(() => {
    expect(capture.sends[1]?.prompt).toBe("Send my next task with this model");
  });
  expect(capture.createdThreads[1]?.model).toBe("claude-sonnet-5-5");
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
  expect(capture.createdThreads[0]?.model).toBeNull();
  expect(userMessageParts(send)).not.toContainEqual(
    expect.objectContaining({ type: "model" }),
  );
});

test("A retired video template link keeps its brief as an editable draft", async () => {
  const user = userEvent.setup();
  const capture = capturePromptLaunch();
  await setupPage({
    context,
    path: "/prompt?prompt=Create%20a%20cinematic%20product%20film&template=epic-grandeur",
  });

  const composer = await waitForDraft("Create a cinematic product film");
  await user.type(composer, " for launch");

  expect(composer).toHaveTextContent(
    "Create a cinematic product film for launch",
  );
  expect(pathname()).toBe(`/agents/${DEFAULT_AGENT_ID}/chat`);
  expect(search()).toBe("");
  expect(document.querySelector("[data-composer-inline-template]")).toBeNull();
  expect(capture.createdThreads).toHaveLength(0);
  expect(capture.sends).toHaveLength(0);
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
  context.mocks.data.availableRunModels([]);
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
});

const LANDING_DRAFT_ID = "f0000000-0000-4000-a000-000000000001";

function landingPath(
  source = "https://www.okou.ai/en/tools/pdf-to-ppt",
  preview?: unknown,
) {
  const path = `/onboarding?${new URLSearchParams({ prompt: "Turn this report into slides", landingFiles: LANDING_DRAFT_ID, landingSource: source })}`;
  return preview === undefined
    ? path
    : `${path}#${new URLSearchParams({ landingFilePreview: JSON.stringify(preview) })}`;
}

function mockLandingPopup() {
  const open = vi.spyOn(window, "open").mockReturnValue(window);
  const close = vi.spyOn(window, "close").mockImplementation(() => {});
  const post = vi.spyOn(window, "postMessage").mockImplementation(() => {});
  const deliver = async (
    files: File[] | null,
    origin = "https://www.okou.ai",
    id = LANDING_DRAFT_ID,
    overrides: { nonce?: string; source?: Window | null } = {},
  ) => {
    const address = open.mock.calls.at(-1)?.[0];
    if (!address) {
      throw new Error("Expected a user-initiated file transfer window");
    }
    const nonce = new URL(String(address)).hash.slice(1);
    await act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin,
          source: overrides.source === undefined ? window : overrides.source,
          data: {
            type: "okou:landing-files:result",
            nonce,
            id,
            files,
            ...overrides,
          },
        }),
      );
    });
  };
  const ready = async (origin = "https://www.okou.ai") => {
    const address = open.mock.calls.at(-1)?.[0];
    if (!address) {
      throw new Error("Expected a user-initiated file transfer window");
    }
    const nonce = new URL(String(address)).hash.slice(1);
    await act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin,
          source: window,
          data: { type: "okou:landing-files:ready", nonce },
        }),
      );
    });
  };
  return { open, close, post, deliver, ready };
}

test("A landing-page request waits for its files and sends them with the edited prompt after onboarding", async () => {
  const user = userEvent.setup();
  const popup = mockLandingPopup();
  const capture = capturePromptLaunch();
  context.mocks.upload.success({
    id: "a0000000-0000-4000-a000-000000000081",
    filename: "report.pdf",
    contentType: "application/pdf",
    size: 6,
    url: "https://cdn.vm7.io/artifacts/tests/report.pdf",
  });
  await setupPage({ context, path: landingPath(), host: "app.okou.ai" });
  await expect(
    screen.findByRole("heading", { name: "Start with your files" }),
  ).resolves.toBeInTheDocument();
  expect(capture.sends).toHaveLength(0);
  expect(popup.open).not.toHaveBeenCalled();
  await fill(
    screen.getByRole("textbox", { name: "Your request" }),
    "Create a board presentation",
  );
  await user.click(await findButton("Upload and start"));
  expect(popup.open).toHaveBeenCalledOnce();
  const file = new File(["report"], "report.pdf", { type: "application/pdf" });
  await popup.deliver([file], "https://attacker.example");
  expect(screen.queryByText("report.pdf")).not.toBeInTheDocument();
  await popup.deliver(
    [file],
    "https://www.okou.ai",
    "f0000000-0000-4000-a000-000000000002",
  );
  expect(screen.queryByText("report.pdf")).not.toBeInTheDocument();
  await popup.deliver([file], "https://www.okou.ai", LANDING_DRAFT_ID, {
    nonce: "wrong-nonce",
  });
  await popup.deliver([file], "https://www.okou.ai", LANDING_DRAFT_ID, {
    source: null,
  });
  expect(capture.sends).toHaveLength(0);
  await popup.deliver([file]);
  const send = await waitForPromptLaunch(
    "Create a board presentation",
    capture,
  );
  expect(JSON.stringify(userMessageParts(send))).toContain(
    "a0000000-0000-4000-a000-000000000081",
  );
  expect(JSON.stringify(userMessageParts(send))).toContain("report.pdf");
  expect(search()).not.toContain("landingFiles");
  expect(popup.close).toHaveBeenCalledOnce();
});

test("Missing landing files do not silently start a text-only task", async () => {
  const popup = mockLandingPopup();
  const capture = capturePromptLaunch();
  await setupPage({ context, path: landingPath(), host: "app.okou.ai" });
  click(await findButton("Upload and start"));
  await popup.deliver(null);
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Your files are unavailable",
  );
  await expect(findButton("Retry")).resolves.toBeEnabled();
  expect(popup.close).toHaveBeenCalledOnce();
  const back = new URL(
    queryAllByRoleFast("link")
      .find((link) => {
        return link.textContent === "Back to files";
      })!
      .getAttribute("href") ?? "",
  );
  expect(back.origin).toBe("https://www.okou.ai");
  expect(back.pathname).toBe("/en/tools/pdf-to-ppt");
  expect(back.searchParams.get("fileDraft")).toBe(LANDING_DRAFT_ID);
  expect(capture.sends).toHaveLength(0);
});

test.each([
  "https://attacker.example/files",
  "https://pr-848-www.omby.ai/en/tools/pdf-to-ppt",
  "https://www.okou.ai.evil.example/files",
  "https://user@www.okou.ai/files",
  "http://www.okou.ai/files",
  "https://www.okou.ai/files?redirect=evil",
  "https://www.okou.ai/files#fragment",
  "https://www.okou.ai:444/files",
])(
  "An untrusted landing source %s cannot open a window or start a task",
  async (source) => {
    const popup = mockLandingPopup();
    const capture = capturePromptLaunch();
    await setupPage({
      context,
      path: landingPath(source),
      host: "app.okou.ai",
    });
    await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
      "Your files are unavailable",
    );
    expect(popup.open).not.toHaveBeenCalled();
    expect(
      queryAllByRoleFast("link").find((link) => {
        return link.textContent === "Back to files";
      }),
    ).toBeUndefined();
    expect(capture.sends).toHaveLength(0);
  },
);

test("A new user keeps the landing file handoff while completing onboarding", async () => {
  const user = userEvent.setup();
  const popup = mockLandingPopup();
  const capture = capturePromptLaunch();
  const report = {
    id: "a0000000-0000-4000-a000-000000000081",
    filename: "report.pdf",
    contentType: "application/pdf",
    size: 6,
    url: "https://cdn.vm7.io/artifacts/tests/report.pdf",
  };
  const notes = {
    id: "a0000000-0000-4000-a000-000000000082",
    filename: "董事会笔记.txt",
    contentType: "text/plain",
    size: 5,
    url: "https://cdn.vm7.io/artifacts/tests/notes.txt",
  };
  context.mocks.upload.success(report);
  context.mocks.upload.success(notes);
  context.mocks.api(uploadsContract.prepare, ({ body, respond }) => {
    const result = body.filename === notes.filename ? notes : report;
    return respond(200, {
      ...result,
      uploadUrl: `https://mock-upload.r2.test/${result.id}`,
      uploadHeaders: {},
    });
  });
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  await setupPage({
    context,
    path: landingPath(undefined, [
      { name: "report.pdf", size: 6, type: "application/pdf" },
      { name: "董事会笔记.txt", size: 5, type: "text/plain" },
    ]),
    host: "app.okou.ai",
  });
  const selected = await screen.findByRole("region", {
    name: "Selected files",
  });
  expect(within(selected).getByText("report.pdf")).toBeInTheDocument();
  expect(within(selected).getByText("董事会笔记.txt")).toBeInTheDocument();
  expect(
    within(selected).getByLabelText("report.pdf · 6B"),
  ).toBeInTheDocument();
  expect(
    within(selected).getByLabelText("董事会笔记.txt · 5B"),
  ).toBeInTheDocument();
  await user.hover(within(selected).getByLabelText("report.pdf · 6B"));
  await expect(
    screen.findByText("report.pdf · 6B"),
  ).resolves.toBeInTheDocument();
  await user.unhover(within(selected).getByLabelText("report.pdf · 6B"));
  expect(
    within(selected).getByLabelText("Attach", { selector: "input" }),
  ).toBeInTheDocument();
  expect(hash()).toBe("");
  expect(search()).not.toContain("report.pdf");
  const input = await screen.findByRole("textbox", {
    name: "Onboarding prompt",
  });
  await fill(input, "Create slides for our board");
  expect(popup.open).not.toHaveBeenCalled();
  click(await findButton("Next"));
  await expect(
    screen.findByRole("heading", { name: "Start with your files" }),
  ).resolves.toBeInTheDocument();
  await expect(
    screen.findByText("董事会笔记.txt"),
  ).resolves.toBeInTheDocument();
  const requestInput = screen.getByRole("textbox", { name: "Your request" });
  if (!(requestInput instanceof HTMLTextAreaElement)) {
    throw new Error("Expected request input");
  }
  expect(requestInput.value).toContain("Create slides for our board");
  expect(capture.sends).toHaveLength(0);
  click(await findButton("Upload and start"));
  await popup.deliver([
    new File(["report"], "report.pdf", { type: "application/pdf" }),
    new File(["notes"], "董事会笔记.txt", { type: "text/plain" }),
  ]);
  await waitFor(() => {
    expect(capture.sends).toHaveLength(1);
  });
  expect(capture.sends[0].prompt).toContain("Create slides for our board");
  expect(JSON.stringify(capture.sends[0].userMessage)).toContain("report.pdf");
  expect(JSON.stringify(capture.sends[0].userMessage)).toContain(
    "董事会笔记.txt",
  );
});

test("A failed upload stops launch and retries only the failed file", async () => {
  const user = userEvent.setup();
  const popup = mockLandingPopup();
  const capture = capturePromptLaunch();
  const report = {
    id: "a0000000-0000-4000-a000-000000000081",
    filename: "report.pdf",
    contentType: "application/pdf",
    size: 6,
    url: "https://cdn.vm7.io/artifacts/tests/report.pdf",
  };
  const notes = {
    id: "a0000000-0000-4000-a000-000000000082",
    filename: "notes.txt",
    contentType: "text/plain",
    size: 5,
    url: "https://cdn.vm7.io/artifacts/tests/notes.txt",
  };
  context.mocks.upload.success(report);
  context.mocks.upload.success(notes);
  const attempts: string[] = [];
  let failNotes = true;
  context.mocks.api(uploadsContract.prepare, ({ body, respond }) => {
    attempts.push(body.filename);
    if (body.filename === notes.filename && failNotes) {
      return respond(500, {
        error: { message: "Upload unavailable", code: "INTERNAL_SERVER_ERROR" },
      });
    }
    const result = body.filename === notes.filename ? notes : report;
    return respond(200, {
      ...result,
      uploadUrl: `https://mock-upload.r2.test/${result.id}`,
      uploadHeaders: {},
    });
  });
  await setupPage({ context, path: landingPath(), host: "app.okou.ai" });
  await user.click(await findButton("Upload and start"));
  await popup.deliver([
    new File(["report"], report.filename, { type: report.contentType }),
    new File(["notes"], notes.filename, { type: notes.contentType }),
  ]);
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Your files and request are kept here",
  );
  expect(capture.sends).toHaveLength(0);
  expect(attempts).toStrictEqual([report.filename, notes.filename]);
  failNotes = false;
  await user.click(await findButton("Retry"));
  await waitFor(() => {
    expect(capture.sends).toHaveLength(1);
  });
  expect(attempts).toStrictEqual([
    report.filename,
    notes.filename,
    notes.filename,
  ]);
  const payload = JSON.stringify(capture.sends[0].userMessage);
  expect(payload).toContain(report.id);
  expect(payload).toContain(notes.id);
  expect(popup.open).toHaveBeenCalledOnce();
});

test("A blocked file popup can be retried without losing the edited request", async () => {
  const popup = mockLandingPopup();
  popup.open.mockReturnValueOnce(null);
  const capture = capturePromptLaunch();
  context.mocks.upload.success({
    id: "a0000000-0000-4000-a000-000000000081",
    filename: "report.pdf",
    contentType: "application/pdf",
    size: 6,
    url: "https://cdn.vm7.io/artifacts/tests/report.pdf",
  });
  await setupPage({ context, path: landingPath(), host: "app.okou.ai" });
  await fill(
    await screen.findByRole("textbox", { name: "Your request" }),
    "Summarize for the board",
  );
  click(await findButton("Upload and start"));
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Allow pop-ups",
  );
  expect(capture.sends).toHaveLength(0);
  click(await findButton("Retry"));
  await popup.deliver([
    new File(["report"], "report.pdf", { type: "application/pdf" }),
  ]);
  await waitFor(() => {
    expect(capture.sends).toHaveLength(1);
  });
  expect(capture.sends[0].prompt).toBe("Summarize for the board");
  expect(popup.open).toHaveBeenCalledTimes(2);
});

test.each([
  {
    name: "malformed metadata",
    source: "https://www.okou.ai/en/tools/pdf-to-ppt",
    preview: "not an array",
    enabled: true,
  },
  {
    name: "untrusted source",
    source: "https://attacker.example/files",
    preview: [{ name: "private.pdf", size: 2, type: "application/pdf" }],
    enabled: true,
  },
  {
    name: "too many files",
    source: "https://www.okou.ai/en/tools/pdf-to-ppt",
    preview: Array.from({ length: 11 }, (_, index) => {
      return { name: `${index}.pdf`, size: 2, type: "application/pdf" };
    }),
    enabled: true,
  },
  {
    name: "disabled handoff",
    source: "https://www.okou.ai/en/tools/pdf-to-ppt",
    preview: [{ name: "private.pdf", size: 2, type: "application/pdf" }],
    enabled: false,
  },
])(
  "Onboarding ignores $name and removes it from the URL",
  async ({ source, preview, enabled }) => {
    context.mocks.data.onboardingStatus({
      needsOnboarding: true,
      onboardingComplete: false,
    });
    await setupPage({
      context,
      host: "app.okou.ai",
      path: landingPath(source, preview),
      featureSwitches: { landingFileHandoff: enabled },
    });
    await expect(
      screen.findByRole("textbox", { name: "Onboarding prompt" }),
    ).resolves.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Selected files" }),
    ).not.toBeInTheDocument();
    expect(hash()).toBe("");
  },
);

test("File names are removed before the sign-in redirect", async () => {
  await startPage({
    context,
    host: "app.okou.ai",
    auth: null,
    path: landingPath(undefined, [
      { name: "private-board-report.pdf", size: 2, type: "application/pdf" },
    ]),
  });
  await waitFor(() => {
    expect(location.pathname).toBe("/sign-in");
  });
  const destination = new URL(location.href);
  expect(destination.pathname).toBe("/sign-in");
  expect(destination.href).not.toContain("private-board-report");
  expect(destination.href).not.toContain("landingFilePreview");
  expect(hash()).toBe("");
  expect(search()).not.toContain("private-board-report");
  expect(search()).not.toContain("landingFilePreview");
});

test("Onboarding submits only retained files and files added in that step", async () => {
  // fake-indexeddb uses Node structuredClone; happy-dom Blob is not cloneable.
  // Native blobs exercise actual byte preservation through that browser boundary.
  vi.stubGlobal("Blob", NativeBlob);
  vi.stubGlobal("File", NativeFile);
  const user = userEvent.setup();
  const popup = mockLandingPopup();
  const capture = capturePromptLaunch();
  const notes = {
    id: "a0000000-0000-4000-a000-000000000083",
    filename: "notes.txt",
    contentType: "text/plain",
    size: 5,
    url: "https://cdn.vm7.io/artifacts/tests/notes.txt",
  };
  const added = {
    id: "a0000000-0000-4000-a000-000000000084",
    filename: "extra.csv",
    contentType: "text/csv",
    size: 7,
    url: "https://cdn.vm7.io/artifacts/tests/extra.csv",
  };
  context.mocks.upload.success(notes);
  context.mocks.upload.success(added);
  const prepared: string[] = [];
  const preparedSizes: number[] = [];
  context.mocks.api(uploadsContract.prepare, ({ body, respond }) => {
    prepared.push(body.filename);
    preparedSizes.push(body.size);
    const result = body.filename === notes.filename ? notes : added;
    return respond(200, {
      ...result,
      uploadUrl: `https://mock-upload.r2.test/${result.id}`,
      uploadHeaders: {},
    });
  });
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  await setupPage({
    context,
    host: "app.okou.ai",
    path: landingPath(undefined, [
      { name: "report.pdf", size: 6, type: "application/pdf" },
      { name: "notes.txt", size: 5, type: "text/plain" },
    ]),
  });
  await user.click(
    await screen.findByLabelText("Remove report.pdf", { selector: "button" }),
  );
  await waitFor(() => {
    expect(screen.queryByText("report.pdf")).not.toBeInTheDocument();
  });
  await user.upload(
    screen.getByLabelText("Attach", { selector: "input" }),
    new File(["a,b\n1,2"], "extra.csv", { type: "text/csv" }),
  );
  await expect(screen.findByText("extra.csv")).resolves.toBeInTheDocument();
  await user.click(await findButton("Next"));
  await user.click(await findButton("Upload and start"));
  await popup.deliver([
    new File(["report"], "report.pdf", { type: "application/pdf" }),
    new File(["notes"], "notes.txt", { type: "text/plain" }),
  ]);
  await waitFor(() => {
    expect(capture.sends).toHaveLength(1);
  });
  expect(prepared).toStrictEqual(["notes.txt", "extra.csv"]);
  expect(preparedSizes).toStrictEqual([5, 7]);
  expect(JSON.stringify(capture.sends[0].userMessage)).toContain("extra.csv");
  expect(JSON.stringify(capture.sends[0].userMessage)).not.toContain(
    "report.pdf",
  );
});

test("Removing every landing file starts only the edited request without a transfer popup", async () => {
  const user = userEvent.setup();
  const popup = mockLandingPopup();
  const capture = capturePromptLaunch();
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  await setupPage({
    context,
    host: "app.okou.ai",
    path: landingPath(undefined, [
      { name: "report.pdf", size: 6, type: "application/pdf" },
    ]),
  });
  await user.click(
    await screen.findByLabelText("Remove report.pdf", { selector: "button" }),
  );
  await waitFor(() => {
    expect(screen.queryByText("report.pdf")).not.toBeInTheDocument();
  });
  await user.click(await findButton("Next"));
  await user.click(await findButton("Upload and start"));
  await waitFor(() => {
    expect(capture.sends).toHaveLength(1);
  });
  expect(popup.open).not.toHaveBeenCalled();
  expect(JSON.stringify(capture.sends[0].userMessage)).not.toContain(
    "report.pdf",
  );
});

test("Adding files beyond the combined limit leaves the existing selection intact", async () => {
  const user = userEvent.setup();
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  await setupPage({
    context,
    host: "app.okou.ai",
    path: landingPath(undefined, [
      { name: "report.pdf", size: 6, type: "application/pdf" },
      { name: "notes.txt", size: 5, type: "text/plain" },
    ]),
  });
  await findButton("Attach");
  await user.upload(
    screen.getByLabelText("Attach", { selector: "input" }),
    Array.from({ length: 9 }, (_, i) => {
      return new File(["extra"], `extra-${i}.txt`, { type: "text/plain" });
    }),
  );
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Add up to 10 files (1 GB total).",
  );
  expect(screen.getByText("report.pdf")).toBeInTheDocument();
  expect(screen.getByText("notes.txt")).toBeInTheDocument();
  expect(screen.queryByText("extra-0.txt")).not.toBeInTheDocument();
});

test("A preview file transfer returns to the same Marketing and App preview pair", async () => {
  const popup = mockLandingPopup();
  const source = "https://pr-848-www.omby.ai/en/tools/pdf-to-ppt";
  await setupPage({
    context,
    path: landingPath(source),
    host: "pr-44425-app-okou-app-preview.vm0.workers.dev",
  });
  click(await findButton("Upload and start"));
  await popup.deliver(null, "https://pr-848-www.omby.ai");
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Your files are unavailable",
  );
  const back = queryAllByRoleFast("link").find((link) => {
    return link.textContent === "Back to files";
  });
  expect(back).toHaveAttribute(
    "href",
    `${source}?fileDraft=${LANDING_DRAFT_ID}&appPreview=44425`,
  );
});

const closingApp = createTestRuntime(context);

test("Closing the App during transfer closes its file window and stops the handshake", async () => {
  const popup = mockLandingPopup();
  const capture = capturePromptLaunch();
  await setupPage({
    context: closingApp,
    path: landingPath(),
    host: "app.okou.ai",
  });
  click(await findButton("Upload and start"));
  await popup.ready();
  expect(popup.post).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      type: "okou:landing-files:read",
      id: LANDING_DRAFT_ID,
    }),
    "https://www.okou.ai",
  );
  await act(() => {
    closingApp.dispose();
  });
  await waitFor(() => {
    expect(popup.close).toHaveBeenCalledOnce();
  });
  await popup.ready();
  expect(popup.post).toHaveBeenCalledOnce();
  expect(capture.sends).toHaveLength(0);
});
