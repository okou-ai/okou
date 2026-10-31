import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { AUTO_RUN_MODEL } from "@okouai/core/auto-run-model";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import {
  chatEventsContract,
  chatThreadsContract,
  type ChatEventSendBody,
  type UserMessagePart,
} from "@okouai/api-contracts/contracts/chat-threads";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
  startPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname, search } from "../../../signals/location.ts";
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

function landingPath(source = "https://www.okou.ai/en/tools/pdf-to-ppt") {
  return `/onboarding?${new URLSearchParams({ prompt: "Turn this report into slides", landingFiles: LANDING_DRAFT_ID, landingSource: source })}`;
}

async function deliverLandingFiles(
  files: File[] | null,
  origin = "https://www.okou.ai",
  id = LANDING_DRAFT_ID,
) {
  let frame: HTMLIFrameElement | null = null;
  await waitFor(() => {
    frame = document.querySelector<HTMLIFrameElement>(
      'iframe[src$="/file-handoff"]',
    );
    expect(frame).toBeInTheDocument();
  });
  const loadedFrame = document.querySelector<HTMLIFrameElement>(
    'iframe[src$="/file-handoff"]',
  );
  if (!loadedFrame) {
    throw new Error("Missing file transfer frame");
  }
  // happy-dom disables iframe page loading; provide only its Window boundary.
  vi.spyOn(loadedFrame, "contentWindow", "get").mockReturnValue(window);
  const source = loadedFrame.contentWindow;
  await act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin,
        source,
        data: { type: "okou:landing-files:result", id, files },
      }),
    );
  });
}

test("A landing-page request waits for its files and sends them with the edited prompt after onboarding", async () => {
  const user = userEvent.setup();
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
  ).resolves.toBeVisible();
  expect(capture.sends).toHaveLength(0);
  const file = new File(["report"], "report.pdf", { type: "application/pdf" });
  await deliverLandingFiles([file], "https://attacker.example");
  expect(screen.queryByText("report.pdf")).not.toBeInTheDocument();
  await deliverLandingFiles(
    [file],
    "https://www.okou.ai",
    "f0000000-0000-4000-a000-000000000002",
  );
  expect(screen.queryByText("report.pdf")).not.toBeInTheDocument();
  await deliverLandingFiles([file]);
  await expect(screen.findByText("report.pdf")).resolves.toBeVisible();
  await fill(
    screen.getByRole("textbox", { name: "Your request" }),
    "Create a board presentation",
  );
  await user.click(await findButton("Upload and start"));
  const send = await waitForPromptLaunch(
    "Create a board presentation",
    capture,
  );
  expect(JSON.stringify(userMessageParts(send))).toContain(
    "a0000000-0000-4000-a000-000000000081",
  );
  expect(JSON.stringify(userMessageParts(send))).toContain("report.pdf");
  expect(search()).not.toContain("landingFiles");
  expect(document.querySelector('iframe[src$="/file-handoff"]')).toBeNull();
});

test("Missing landing files do not silently start a text-only task", async () => {
  const capture = capturePromptLaunch();
  await setupPage({ context, path: landingPath(), host: "app.okou.ai" });
  await deliverLandingFiles(null);
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Your files are unavailable",
  );
  await expect(findButton("Upload and start")).resolves.toBeDisabled();
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

test("An untrusted landing source is rejected without loading its frame or starting a task", async () => {
  const capture = capturePromptLaunch();
  await setupPage({
    context,
    path: landingPath("https://attacker.example/files"),
    host: "app.okou.ai",
  });
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Your files are unavailable",
  );
  expect(document.querySelector('iframe[src$="/file-handoff"]')).toBeNull();
  expect(
    queryAllByRoleFast("link").find((link) => {
      return link.textContent === "Back to files";
    }),
  ).toBeUndefined();
  expect(capture.sends).toHaveLength(0);
});

test("A new user keeps the landing file handoff while completing onboarding", async () => {
  const capture = capturePromptLaunch();
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  await setupPage({ context, path: landingPath(), host: "app.okou.ai" });
  const input = await screen.findByRole("textbox", {
    name: "Onboarding prompt",
  });
  await fill(input, "Create slides for our board");
  expect(document.querySelector('iframe[src$="/file-handoff"]')).toBeNull();
  click(await findButton("Next"));
  await expect(
    screen.findByRole("heading", { name: "Start with your files" }),
  ).resolves.toBeVisible();
  await deliverLandingFiles([
    new File(["report"], "report.pdf", { type: "application/pdf" }),
  ]);
  await expect(screen.findByText("report.pdf")).resolves.toBeVisible();
  const requestInput = screen.getByRole("textbox", { name: "Your request" });
  if (!(requestInput instanceof HTMLTextAreaElement)) {
    throw new Error("Expected request input");
  }
  expect(requestInput.value).toContain("Create slides for our board");
  expect(capture.sends).toHaveLength(0);
});

test("A failed upload stops launch and retries only the failed file", async () => {
  const user = userEvent.setup();
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
  await deliverLandingFiles([
    new File(["report"], report.filename, { type: report.contentType }),
    new File(["notes"], notes.filename, { type: notes.contentType }),
  ]);
  await user.click(await findButton("Upload and start"));
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
});
