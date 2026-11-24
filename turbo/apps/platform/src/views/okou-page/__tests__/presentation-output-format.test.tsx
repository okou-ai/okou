import { cleanup, act, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core";
import { composerDraftContract } from "@okouai/api-contracts/contracts/composer-draft";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  createTestRuntime,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { findComposerEditor, THREAD_ID } from "./chat-composer-test-helpers.ts";
import { createTemplateGalleryHelpers } from "./chat-composer-template-gallery-test-helpers.ts";
import { clickComposerAddMenuItem } from "./chat-composer-add-menu-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const reloadedContext = createTestRuntime(context);
const { mockTemplateChat } = createTemplateGalleryHelpers(context);
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
  const found = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      (candidate.getAttribute("aria-label") ??
        candidate.textContent?.trim()) === name
    );
  });
  if (!found) {
    throw new Error(`Expected button ${name}`);
  }
  return found;
}

async function openPresentation(): Promise<void> {
  const discovery = await screen.findByRole("group", {
    name: "Explore Okou capabilities",
  });
  click(button("Presentation", discovery));
  await screen.findByRole("combobox", { name: "Slide count" });
}

async function openChart(): Promise<HTMLElement> {
  await clickComposerAddMenuItem("Create");
  const create = await screen.findByRole("radiogroup", { name: "Create" });
  const chart = queryAllByRoleFast("radio", create).find((candidate) => {
    return candidate.textContent?.trim() === "Chart";
  });
  if (!chart) {
    throw new Error("Expected Chart creation option");
  }
  click(chart);
  return await screen.findByRole("region", { name: "Visualization options" });
}

test.each(["html", "pptx"] as const)(
  "Presentation submits the saved %s default without rewriting the user's explicit format",
  async (format) => {
    context.mocks.data.userPreferences({ presentationFormat: format });
    const capture = mockTemplateChat();
    await setupPage({
      context,
      path: "/",
      auth: ownerAuth,
      featureSwitches: enabledFeatures,
    });
    const editor = await findComposerEditor();
    await openPresentation();
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    const request = `Please deliver ${format === "pptx" ? "HTML" : "PPTX"} this time`;
    await fill(editor, request);
    const shelf = screen.getByRole("group", { name: "Presentation templates" });
    click(button(template.title, shelf));
    click(screen.getByRole("combobox", { name: "Slide count" }));
    click(await screen.findByRole("option", { name: "4–8 slides" }));
    click(button("Send"));
    await waitFor(() => {
      expect(capture.sentMessages).toHaveLength(1);
    });
    expect(capture.runPrompts).toStrictEqual([
      expect.stringContaining(request),
    ]);
    expect(capture.selectedTemplates[0]).toMatchObject({
      type: "presentation",
      selection: { templateId: template.templateId, outputFormat: format },
    });
    expect(capture.sentMessages[0]?.parts).toContainEqual({
      type: "additional_info",
      text: expect.stringContaining(
        `- Output format: ${format.toUpperCase()} format`,
      ),
    });
    expect(capture.sentMessages[0]?.parts).toContainEqual({
      type: "additional_info",
      text: expect.stringContaining("- Slide count: 4-8"),
    });
    expect(capture.sentMessages[0]?.parts).toContainEqual({
      type: "additional_info",
      text: expect.stringContaining(
        "unless the message explicitly requests another format",
      ),
    });
  },
);

test.each(["html", "pptx"] as const)(
  "An untagged message carries the saved %s default without requesting a presentation",
  async (format) => {
    context.mocks.data.userPreferences({ presentationFormat: format });
    const capture = mockTemplateChat();
    await setupPage({
      context,
      path: "/",
      auth: ownerAuth,
      featureSwitches: enabledFeatures,
    });
    const editor = await findComposerEditor();
    const prompt = "Summarize our launch plan";
    await fill(editor, prompt);
    click(button("Send"));
    await waitFor(() => {
      expect(capture.sentMessages).toHaveLength(1);
    });
    expect(capture.runPrompts).toStrictEqual([prompt]);
    expect(capture.sentMessages[0]?.parts).toContainEqual({
      type: "text",
      text: prompt,
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
        "This preference does not request a presentation or change another artifact's output type.",
      ),
    });
  },
);

test("An unselected default leaves an untagged message unchanged", async () => {
  const capture = mockTemplateChat();
  await setupPage({
    context,
    path: "/",
    auth: ownerAuth,
    featureSwitches: enabledFeatures,
  });
  const prompt = "Summarize our launch plan";
  await fill(await findComposerEditor(), prompt);
  click(button("Send"));
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(capture.sentMessages[0]?.parts).toStrictEqual([
    { type: "text", text: prompt },
  ]);
});

test("A queued untagged message freezes its saved presentation default", async () => {
  context.mocks.data.userPreferences({ presentationFormat: "pptx" });
  mockTemplateChat();
  const queued: UserMessageDocument[] = [];
  const runId = crypto.randomUUID();
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    activeRunIds: [runId],
    chatEvents: [
      {
        role: "user",
        content: "Review the launch brief",
        runId,
        createdAt: "2026-09-07T00:00:00.000Z",
      },
    ],
    onQueuedEventAppend: (body) => {
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
  await screen.findByText("Review the launch brief");
  await fill(await findComposerEditor(), "Prepare the next briefing");
  click(button("Send"));
  await waitFor(() => {
    expect(queued).toHaveLength(1);
  });
  expect(queued[0]?.parts).toContainEqual({
    type: "text",
    text: "Prepare the next briefing",
  });
  expect(queued[0]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("- Output format: PPTX format"),
  });
});

test("The saved default reaches presentation templates inside feedback without dropping their fields", async () => {
  context.mocks.data.userPreferences({ presentationFormat: "pptx" });
  const capture = mockTemplateChat();
  const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
  const feedback = {
    type: "feedback" as const,
    quote: "Revise the launch deck.",
    note: [
      { type: "text" as const, text: "Use " },
      {
        type: "template" as const,
        titleSnapshot: template.title,
        template: {
          type: "presentation" as const,
          selection: {
            templateId: template.templateId,
            outputFormat: "html" as const,
          },
        },
      },
      { type: "text" as const, text: " for this revision." },
    ],
  };
  context.mocks.api(composerDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: { version: 1, parts: [feedback] },
      draftAttachments: null,
    });
  });
  await setupPage({
    context,
    path: "/",
    auth: ownerAuth,
    featureSwitches: enabledFeatures,
  });
  const editor = await findComposerEditor();
  await waitFor(() => {
    expect(editor).toHaveTextContent(template.title);
    expect(editor).toHaveTextContent(feedback.quote);
  });
  click(button("Send"));
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  const sentFeedback = capture.sentMessages[0]?.parts.find((part) => {
    return part.type === "feedback";
  });
  expect(sentFeedback).toMatchObject({
    quote: feedback.quote,
    note: [
      feedback.note[0],
      {
        type: "template",
        titleSnapshot: template.title,
        template: {
          type: "presentation",
          selection: { templateId: template.templateId, outputFormat: "pptx" },
        },
      },
      feedback.note[2],
    ],
  });
});

test("A fresh page reads the server default again", async () => {
  context.mocks.data.userPreferences({ presentationFormat: "html" });
  mockTemplateChat();
  await setupPage({
    context,
    path: "/",
    auth: ownerAuth,
    featureSwitches: enabledFeatures,
  });
  await findComposerEditor();
  cleanup();
  vi.mocked(window.history.pushState).mockRestore();
  vi.mocked(window.history.replaceState).mockRestore();
  vi.mocked(window.history.back).mockRestore();
  vi.mocked(window.history.forward).mockRestore();
  context.mocks.data.userPreferences({ presentationFormat: "pptx" });
  const capture = mockTemplateChat();
  await setupPage({
    context: reloadedContext,
    path: "/",
    auth: ownerAuth,
    featureSwitches: enabledFeatures,
  });
  await fill(await findComposerEditor(), "Prepare the refreshed briefing");
  click(button("Send"));
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(capture.sentMessages[0]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("- Output format: PPTX format"),
  });
});

test.each([null, "pptx"] as const)(
  "Chart presentation output keeps its category with a saved %s default",
  async (format) => {
    context.mocks.data.userPreferences({ presentationFormat: format });
    const capture = mockTemplateChat();
    await setupPage({
      context,
      path: "/",
      auth: ownerAuth,
      featureSwitches: enabledFeatures,
    });
    const editor = await findComposerEditor();
    const charts = await openChart();
    click(button("Presentation", charts));
    await fill(editor, "Visualize our results");
    click(button("Send"));
    await waitFor(() => {
      expect(capture.sentMessages).toHaveLength(1);
    });
    expect(capture.sentMessages[0]?.parts).toContainEqual({
      type: "additional_info",
      text: expect.stringContaining("- Preferred output format: presentation"),
    });
  },
);

test("A saved presentation default does not change Chart website output", async () => {
  context.mocks.data.userPreferences({ presentationFormat: "pptx" });
  const capture = mockTemplateChat();
  await setupPage({
    context,
    path: "/",
    auth: ownerAuth,
    featureSwitches: enabledFeatures,
  });
  const editor = await findComposerEditor();
  const charts = await openChart();
  click(button("Website", charts));
  await fill(editor, "Build a visual site");
  click(button("Send"));
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  const instructions = capture.sentMessages[0]?.parts.find((part) => {
    return part.type === "additional_info";
  });
  expect(instructions?.text).toContain("- Preferred output format: website");
  expect(instructions?.text).toContain("- Output format: PPTX format");
  expect(instructions?.text).toContain(
    "This preference does not request a presentation or change another artifact's output type.",
  );
});

test("An unavailable preference rejects submission instead of treating it as unselected", async () => {
  const capture = mockTemplateChat();
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    return respond(200, {
      timezone: "UTC",
      locale: "en-US",
      supportedLocales: ["en-US"],
      sendMode: "enter",
      cloudBrowserEnabledByDefault: true,
      chatResourcesEnabledByDefault: false,
      forYouCoverId: null,
      theme: "system",
      colorTheme: null,
      captureNetworkBodiesRemaining: 0,
      memoryInitialized: true,
    });
  });
  await setupPage({
    context,
    path: "/",
    auth: ownerAuth,
    featureSwitches: enabledFeatures,
  });
  const editor = await findComposerEditor();
  await fill(editor, "Retain this briefing request");
  await act(() => {
    click(button("Send"));
  });
  await waitFor(() => {
    expect(button("Send")).toBeEnabled();
  });
  expect(editor).toHaveTextContent("Retain this briefing request");
  expect(capture.sentMessages).toHaveLength(0);
});

test.each(["feature off", "ineligible audience"] as const)(
  "%s sends normally without presentation preference context",
  async (condition) => {
    context.mocks.data.userPreferences({ presentationFormat: "pptx" });
    const capture = mockTemplateChat();
    await setupPage({
      context,
      path: "/",
      ...(condition === "feature off" ? { auth: ownerAuth } : {}),
      featureSwitches: {
        [FeatureSwitchKey.PresentationOutputFormat]:
          condition === "ineligible audience",
      },
    });
    const editor = await findComposerEditor();
    await openPresentation();
    await fill(editor, "Prepare our launch deck");
    click(button("Send"));
    await waitFor(() => {
      expect(capture.sentMessages).toHaveLength(1);
    });
    expect(capture.sentMessages[0]?.parts).toContainEqual({
      type: "additional_info",
      text: expect.not.stringContaining("# Presentation Output Preference"),
    });
  },
);
