import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  chatEventsContract,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { composerDraftContract } from "@okouai/api-contracts/contracts/composer-draft";
import {
  userPreferencesContract,
  type UpdateUserPreferencesRequest,
  type UserPreferencesResponse,
} from "@okouai/api-contracts/contracts/user-preferences";
import { expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  createTestRuntime,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { findComposerEditor, THREAD_ID } from "./chat-composer-test-helpers.ts";
import { clickComposerAddMenuItem } from "./chat-composer-add-menu-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { createTemplateGalleryHelpers } from "./chat-composer-template-gallery-test-helpers.ts";

const context = testContext();
const { mockTemplateChat } = createTemplateGalleryHelpers(context);
const menuTitle = "Pick a default format to start";
const ownerAuth = Object.freeze({
  user: Object.freeze({
    id: "user_3EWY21Oe3f15kfs3yYmbGgDb3NV",
    fullName: "Presentation Owner",
    email: "presentation-owner@example.test",
  }),
});
const enabledFeatures = Object.freeze({
  [FeatureSwitchKey.PresentationOutputFormat]: true,
});

function button(name: string, container: ParentNode = document): HTMLElement {
  const result = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      (candidate.getAttribute("aria-label") ??
        candidate.textContent?.trim()) === name
    );
  });
  if (!result) {
    throw new Error(`Expected button ${name}`);
  }
  return result;
}

function formatItem(menu: HTMLElement, name: RegExp): HTMLElement {
  const result = queryAllByRoleFast("menuitem", menu).find((candidate) => {
    return name.test(candidate.textContent?.trim() ?? "");
  });
  if (!result) {
    throw new Error(`Expected format item ${name}`);
  }
  return result;
}

function setupMenu(): HTMLElement | null {
  return screen.queryByRole("menu", { name: menuTitle });
}

function mockPreferences({
  saveGate,
  failFirstSave = false,
  presentationFormat = null,
}: {
  readonly saveGate?: Promise<void>;
  readonly failFirstSave?: boolean;
  readonly presentationFormat?: UserPreferencesResponse["presentationFormat"];
} = {}) {
  let stored: UserPreferencesResponse = {
    timezone: "Etc/UTC",
    locale: "en-US",
    supportedLocales: ["en-US"],
    sendMode: "enter",
    cloudBrowserEnabledByDefault: false,
    chatResourcesEnabledByDefault: false,
    presentationFormat,
    forYouCoverId: null,
    theme: "system",
    colorTheme: null,
    captureNetworkBodiesRemaining: 0,
    memoryInitialized: true,
  };
  const writes: UpdateUserPreferencesRequest[] = [];
  const requested = context.mocks.deferred<UpdateUserPreferencesRequest>();
  context.mocks.data.userPreferences(stored);
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    return respond(200, stored);
  });
  context.mocks.api(
    userPreferencesContract.update,
    async ({ body, respond, withSignal }) => {
      writes.push(body);
      if (!requested.settled()) {
        requested.resolve(body);
      }
      if (saveGate) {
        await withSignal(saveGate);
      }
      if (failFirstSave && writes.length === 1) {
        return respond(500, {
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Preference save failed",
          },
        });
      }
      stored = { ...stored, ...body };
      context.mocks.data.userPreferences(stored);
      return respond(200, stored);
    },
  );
  return { writes, requested };
}

async function openPresentation(): Promise<HTMLElement> {
  const discovery = await screen.findByRole("group", {
    name: "Explore Okou capabilities",
  });
  click(button("Presentation", discovery));
  return await screen.findByRole("combobox", { name: "Slide count" });
}

async function preparePresentation(editor: HTMLElement, prompt: string) {
  const slideCount = await openPresentation();
  await fill(editor, prompt);
  const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
  const shelf = screen.getByRole("group", { name: "Presentation templates" });
  click(button(template.title, shelf));
  await waitFor(() => {
    expect(editor).toHaveTextContent(template.title);
  });
  click(slideCount);
  click(await screen.findByRole("option", { name: "4–8 slides" }));
  await waitFor(() => {
    expect(slideCount).toHaveTextContent("4–8 slides");
  });
  return { slideCount, template };
}

async function send(): Promise<void> {
  await waitFor(() => {
    expect(button("Send")).toBeEnabled();
  });
  click(button("Send"));
}

async function openSetup(): Promise<HTMLElement> {
  await send();
  return await screen.findByRole("menu", { name: menuTitle });
}

function messageText(message: UserMessageDocument | undefined): string {
  return (
    message?.parts
      .flatMap((part) => {
        return part.type === "text" ? [part.text] : [];
      })
      .join("")
      .trim() ?? ""
  );
}

const formatLabels = { html: "Web slides", pptx: "PowerPoint" } as const;

test.each(["html", "pptx"] as const)(
  "A tagged first send waits for a chosen %s default without rewriting an explicit opposite request",
  async (format) => {
    const preferences = mockPreferences();
    const capture = mockTemplateChat();
    await setupPage({
      context,
      path: "/",
      auth: ownerAuth,
      featureSwitches: enabledFeatures,
    });
    const editor = await findComposerEditor();
    const prompt = `Please deliver ${format === "html" ? "PPTX" : "HTML"} for the launch briefing`;
    const { slideCount, template } = await preparePresentation(editor, prompt);
    const menu = await openSetup();
    expect(formatItem(menu, /^Web slides/u)).toHaveTextContent(
      "A link that opens in any browser",
    );
    expect(formatItem(menu, /^PowerPoint/u)).toHaveTextContent(
      "An editable .pptx file",
    );
    expect(menu).toHaveTextContent(
      "Used for every new deck. You can change it in Settings.",
    );
    expect(editor).toHaveTextContent(prompt);
    expect(editor).toHaveTextContent(template.title);
    expect(slideCount).toHaveTextContent("4–8 slides");
    expect(preferences.writes).toStrictEqual([]);
    expect(capture.threadCreates).toStrictEqual([]);
    expect(capture.runPrompts).toStrictEqual([]);
    expect(capture.sentMessages).toStrictEqual([]);

    // Choosing a format is the confirmation: it saves and sends once.
    click(formatItem(menu, new RegExp(`^${formatLabels[format]}`, "u")));
    await waitFor(() => {
      expect(capture.sentMessages).toHaveLength(1);
    });
    expect(preferences.writes).toStrictEqual([{ presentationFormat: format }]);
    expect(capture.runPrompts).toStrictEqual([expect.stringContaining(prompt)]);
    expect(messageText(capture.sentMessages[0])).toBe(prompt);
    expect(capture.selectedTemplates).toHaveLength(1);
    expect(capture.selectedTemplates[0]).toMatchObject({
      type: "presentation",
      selection: { templateId: template.templateId, outputFormat: format },
    });
    expect(capture.sentMessages[0]?.parts).toContainEqual({
      type: "additional_info",
      text: expect.stringContaining("- Slide count: 4-8"),
    });
    expect(capture.sentMessages[0]?.parts).toContainEqual({
      type: "additional_info",
      text: expect.stringContaining(
        `- Output format: ${format.toUpperCase()} format`,
      ),
    });
    expect(capture.sentMessages[0]?.parts).toContainEqual({
      type: "additional_info",
      text: expect.stringContaining(
        "When this saved default decides the format",
      ),
    });
    await screen.findByText(
      `${formatLabels[format]} is now your default for decks`,
    );
    await waitFor(() => {
      expect(setupMenu()).toBeNull();
    });
  },
);

test("Open settings in the saved-default toast opens Chat settings on the saved format", async () => {
  mockPreferences();
  const capture = mockTemplateChat();
  await setupPage({
    context,
    path: "/",
    auth: ownerAuth,
    featureSwitches: enabledFeatures,
  });
  const editor = await findComposerEditor();
  await openPresentation();
  await fill(editor, "Draft the quarterly review deck");
  click(formatItem(await openSetup(), /^PowerPoint/u));
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  await screen.findByText("PowerPoint is now your default for decks");
  await waitFor(() => {
    expect(button("Open settings")).toBeInTheDocument();
  });
  click(button("Open settings"));
  const formats = await screen.findByRole("group", {
    name: "Default presentation format",
  });
  expect(button("PowerPoint", formats)).toHaveAttribute("aria-pressed", "true");
  expect(
    screen.getByText("New decks arrive as a .pptx file you can edit"),
  ).toBeInTheDocument();
});

test("Dismissing preserves the draft, asks again on the next send, and removing the tag permits a plain send", async () => {
  const preferences = mockPreferences();
  const capture = mockTemplateChat();
  await setupPage({
    context,
    path: "/",
    auth: ownerAuth,
    featureSwitches: enabledFeatures,
  });
  const user = userEvent.setup();
  const editor = await findComposerEditor();
  const prompt = "Keep my original launch draft";
  const { slideCount, template } = await preparePresentation(editor, prompt);
  await openSetup();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(setupMenu()).toBeNull();
  });
  expect(editor).toHaveTextContent(prompt);
  expect(editor).toHaveTextContent(template.title);
  expect(slideCount).toHaveTextContent("4–8 slides");
  expect(preferences.writes).toStrictEqual([]);
  expect(capture.threadCreates).toStrictEqual([]);
  expect(capture.runPrompts).toStrictEqual([]);

  await openSetup();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(setupMenu()).toBeNull();
  });
  click(button("Remove Presentation"));
  await screen.findByRole("group", { name: "Explore Okou capabilities" });
  await fill(editor, prompt);
  await send();
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(capture.sentMessages[0]?.parts).toStrictEqual([
    { type: "text", text: prompt },
  ]);
  expect(preferences.writes).toStrictEqual([]);
  expect(setupMenu()).toBeNull();
});

test("Presentation wording without the actual tag sends normally without choosing a default", async () => {
  const preferences = mockPreferences();
  const capture = mockTemplateChat();
  await setupPage({
    context,
    path: "/",
    auth: ownerAuth,
    featureSwitches: enabledFeatures,
  });
  const prompt = "Please create a presentation for the launch";
  await fill(await findComposerEditor(), prompt);
  await send();
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(capture.runPrompts).toStrictEqual([prompt]);
  expect(capture.sentMessages[0]?.parts).toStrictEqual([
    { type: "text", text: prompt },
  ]);
  expect(preferences.writes).toStrictEqual([]);
  expect(setupMenu()).toBeNull();
});

test("The actual Presentation tag does not ask for a default while the feature is off", async () => {
  const preferences = mockPreferences();
  const capture = mockTemplateChat();
  await setupPage({
    context,
    path: "/",
    auth: ownerAuth,
    featureSwitches: { [FeatureSwitchKey.PresentationOutputFormat]: false },
  });
  const editor = await findComposerEditor();
  await openPresentation();
  const prompt = "Prepare our launch presentation";
  await fill(editor, prompt);
  await send();
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(messageText(capture.sentMessages[0])).toBe(prompt);
  expect(capture.sentMessages[0]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("Create a presentation."),
  });
  expect(preferences.writes).toStrictEqual([]);
  expect(setupMenu()).toBeNull();
});

test("A saved default names itself in the Presentation placeholder and skips the first-use menu", async () => {
  const preferences = mockPreferences({ presentationFormat: "pptx" });
  const capture = mockTemplateChat();
  await setupPage({
    context,
    path: "/",
    auth: ownerAuth,
    featureSwitches: enabledFeatures,
  });
  const editor = await findComposerEditor();
  await openPresentation();
  await screen.findByText(
    "What is your presentation about? (PowerPoint by default)",
  );
  const prompt = "Summarize the board update";
  await fill(editor, prompt);
  await send();
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(setupMenu()).toBeNull();
  expect(preferences.writes).toStrictEqual([]);
  expect(capture.sentMessages[0]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("- Output format: PPTX format"),
  });
});

test("A failed preference save keeps the menu and original composer until an explicit retry", async () => {
  const preferences = mockPreferences({ failFirstSave: true });
  const capture = mockTemplateChat();
  await setupPage({
    context,
    path: "/",
    auth: ownerAuth,
    featureSwitches: enabledFeatures,
  });
  const editor = await findComposerEditor();
  const prompt = "Retain this briefing while saving fails";
  const { slideCount, template } = await preparePresentation(editor, prompt);
  const menu = await openSetup();
  click(formatItem(menu, /^PowerPoint/u));
  const error = await within(menu).findByRole("alert");
  expect(error).toHaveTextContent(
    "Couldn't save the default format. Try again.",
  );
  expect(formatItem(menu, /^PowerPoint/u)).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(editor).toHaveTextContent(prompt);
  expect(editor).toHaveTextContent(template.title);
  expect(slideCount).toHaveTextContent("4–8 slides");
  expect(preferences.writes).toStrictEqual([{ presentationFormat: "pptx" }]);
  expect(capture.threadCreates).toStrictEqual([]);
  expect(capture.runPrompts).toStrictEqual([]);

  click(formatItem(menu, /^PowerPoint/u));
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(preferences.writes).toStrictEqual([
    { presentationFormat: "pptx" },
    { presentationFormat: "pptx" },
  ]);
  expect(messageText(capture.sentMessages[0])).toBe(prompt);
  expect(capture.runPrompts).toHaveLength(1);
  expect(capture.selectedTemplates[0]).toMatchObject({
    type: "presentation",
    selection: { templateId: template.templateId, outputFormat: "pptx" },
  });
  expect(capture.sentMessages[0]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("- Slide count: 4-8"),
  });
});

test("Rapid choices write once and disable both formats until the server confirms the save", async () => {
  const release = context.mocks.deferred<void>();
  const preferences = mockPreferences({ saveGate: release.promise });
  const capture = mockTemplateChat();
  await setupPage({
    context,
    path: "/",
    auth: ownerAuth,
    featureSwitches: enabledFeatures,
  });
  const editor = await findComposerEditor();
  await openPresentation();
  const prompt = "Generate this request only once";
  await fill(editor, prompt);
  const menu = await openSetup();
  const html = formatItem(menu, /^Web slides/u);
  const pptx = formatItem(menu, /^PowerPoint/u);
  click(html);
  click(html);
  await expect(preferences.requested.promise).resolves.toStrictEqual({
    presentationFormat: "html",
  });
  await waitFor(() => {
    expect(html).toHaveAttribute("aria-disabled", "true");
    expect(pptx).toHaveAttribute("aria-disabled", "true");
  });
  expect(html).toHaveAttribute("aria-busy", "true");
  expect(editor).toHaveTextContent(prompt);
  expect(preferences.writes).toStrictEqual([{ presentationFormat: "html" }]);
  expect(capture.threadCreates).toStrictEqual([]);
  expect(capture.runPrompts).toStrictEqual([]);
  expect(capture.sentMessages).toStrictEqual([]);

  release.resolve();
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(preferences.writes).toStrictEqual([{ presentationFormat: "html" }]);
  expect(capture.runPrompts).toStrictEqual([prompt]);
  expect(messageText(capture.sentMessages[0])).toBe(prompt);
  await waitFor(() => {
    expect(setupMenu()).toBeNull();
  });
});

test("An accepted preference followed by a rejected normal send does not repeat either POST", async () => {
  const preferences = mockPreferences();
  mockTemplateChat();
  const sendRequested = context.mocks.deferred<void>();
  const releaseSend = context.mocks.deferred<void>();
  const prompts: (string | undefined)[] = [];
  context.mocks.api(
    chatEventsContract.send,
    async ({ body, respond, withSignal }) => {
      prompts.push(body.prompt);
      sendRequested.resolve();
      await withSignal(releaseSend.promise);
      return respond(400, {
        error: { code: "BAD_REQUEST", message: "Message was not accepted" },
      });
    },
  );
  await setupPage({
    context,
    path: "/",
    auth: ownerAuth,
    featureSwitches: enabledFeatures,
  });
  await openPresentation();
  const prompt = "Send my original briefing once";
  await fill(await findComposerEditor(), prompt);
  click(formatItem(await openSetup(), /^PowerPoint/u));
  await sendRequested.promise;
  expect(preferences.writes).toStrictEqual([{ presentationFormat: "pptx" }]);
  expect(prompts).toStrictEqual([prompt]);

  releaseSend.resolve();
  await screen.findByText("Message was not accepted");
  expect(prompts).toStrictEqual([prompt]);
  expect(preferences.writes).toStrictEqual([{ presentationFormat: "pptx" }]);
  expect(setupMenu()).toBeNull();
});

test("A fresh runtime still asks for a restored draft when no default was chosen", async () => {
  const preferences = mockPreferences();
  const capture = mockTemplateChat();
  const prompt = "Restore this persisted launch draft";
  context.mocks.api(composerDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: { version: 1, parts: [{ type: "text", text: prompt }] },
      draftAttachments: null,
    });
  });
  const originalPage = createTestRuntime(context);
  await setupPage({
    context: originalPage,
    path: "/",
    auth: ownerAuth,
    featureSwitches: enabledFeatures,
  });
  const editor = await findComposerEditor();
  await waitFor(() => {
    expect(editor).toHaveTextContent(prompt);
  });
  await openPresentation();
  await openSetup();
  expect(preferences.writes).toStrictEqual([]);

  await act(() => {
    originalPage.dispose();
  });
  cleanup();
  vi.mocked(window.history.pushState).mockRestore();
  vi.mocked(window.history.replaceState).mockRestore();
  vi.mocked(window.history.back).mockRestore();
  vi.mocked(window.history.forward).mockRestore();
  const freshPage = createTestRuntime(context);
  await setupPage({
    context: freshPage,
    path: "/",
    auth: ownerAuth,
    featureSwitches: enabledFeatures,
  });
  const restoredEditor = await findComposerEditor();
  await waitFor(() => {
    expect(restoredEditor).toHaveTextContent(prompt);
  });
  await openPresentation();
  const reopened = await openSetup();
  expect(formatItem(reopened, /^Web slides/u)).toBeInTheDocument();
  expect(formatItem(reopened, /^PowerPoint/u)).toBeInTheDocument();
  expect(restoredEditor).toHaveTextContent(prompt);
  expect(preferences.writes).toStrictEqual([]);
  expect(capture.threadCreates).toStrictEqual([]);
  expect(capture.runPrompts).toStrictEqual([]);
});

test("A tagged queued input waits for setup and enqueues the original message once", async () => {
  const preferences = mockPreferences();
  const queued: UserMessageDocument[] = [];
  const started: (string | undefined)[] = [];
  const created: (string | undefined)[] = [];
  const runId = crypto.randomUUID();
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    activeRunIds: [runId],
    chatEvents: [
      {
        role: "user",
        content: "Review the current launch brief",
        runId,
        createdAt: "2026-09-07T00:00:00.000Z",
      },
    ],
    onThreadCreate(body) {
      created.push(body.clientThreadId);
    },
    onRunCreate(body) {
      started.push(body.prompt);
    },
    onQueuedEventAppend(body) {
      if (body.userMessage) {
        queued.push(body.userMessage);
      }
    },
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    auth: ownerAuth,
    featureSwitches: enabledFeatures,
  });
  await screen.findByText("Review the current launch brief");
  const editor = await findComposerEditor();
  await clickComposerAddMenuItem("Create");
  const types = await screen.findByRole("radiogroup", { name: "Create" });
  const presentation = queryAllByRoleFast("radio", types).find((item) => {
    return item.textContent?.trim() === "Presentation";
  });
  if (!presentation) {
    throw new Error("Expected Presentation task");
  }
  click(presentation);
  await screen.findByRole("combobox", { name: "Slide count" });
  const prompt = "Prepare the next presentation after the current run";
  await fill(editor, prompt);
  const menu = await openSetup();
  expect(queued).toStrictEqual([]);
  expect(started).toStrictEqual([]);
  expect(preferences.writes).toStrictEqual([]);
  click(formatItem(menu, /^PowerPoint/u));
  await waitFor(() => {
    expect(queued).toHaveLength(1);
  });
  expect(messageText(queued[0])).toBe(prompt);
  expect(queued[0]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("- Output format: PPTX format"),
  });
  expect(preferences.writes).toStrictEqual([{ presentationFormat: "pptx" }]);
  expect(started).toStrictEqual([]);
  expect(created).toStrictEqual([]);
  expect(setupMenu()).toBeNull();
});

test("Enter opens the menu and Escape returns focus without saving or sending", async () => {
  const preferences = mockPreferences();
  const capture = mockTemplateChat();
  await setupPage({
    context,
    path: "/",
    auth: ownerAuth,
    featureSwitches: enabledFeatures,
  });
  const user = userEvent.setup();
  const editor = await findComposerEditor();
  await openPresentation();
  const prompt = "Keep this keyboard-submitted draft";
  await fill(editor, prompt);
  await user.click(editor);
  await user.keyboard("{Enter}");
  const menu = await screen.findByRole("menu", { name: menuTitle });
  await user.keyboard("{ArrowDown}");
  expect(queryAllByRoleFast("menuitem", menu)).toHaveLength(2);
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(setupMenu()).toBeNull();
    expect(editor).toHaveFocus();
  });
  expect(editor).toHaveTextContent(prompt);
  expect(preferences.writes).toStrictEqual([]);
  expect(capture.threadCreates).toStrictEqual([]);
  expect(capture.sentMessages).toStrictEqual([]);
});
