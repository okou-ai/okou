import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core";
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
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import {
  AGENT_ID,
  createTemplateGalleryHelpers,
} from "./chat-composer-template-gallery-test-helpers.ts";

const context = testContext();
const reloadedContext = createTestRuntime(context);
const { mockTemplateChat } = createTemplateGalleryHelpers(context);
const enabledFeatures = Object.freeze({
  [FeatureSwitchKey.HomeCapabilities]: true,
  [FeatureSwitchKey.PresentationOutputFormat]: true,
});

function button(name: string, container: ParentNode = document.body) {
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

async function openPresentation() {
  const discovery = await screen.findByRole("group", {
    name: "Explore Okou capabilities",
  });
  click(button("Presentation", discovery));
  return await screen.findByRole("group", { name: "Output format" });
}

async function openChart() {
  const types = screen.getByRole("radiogroup", { name: "Create" });
  const chart = queryAllByRoleFast("radio", types).find((candidate) => {
    return candidate.textContent?.trim() === "Chart";
  });
  if (!chart) {
    throw new Error("Expected Chart type");
  }
  click(chart);
  return await screen.findByRole("region", { name: "Visualization options" });
}

test.each(["HTML", "PPTX"] as const)(
  "Presentation defaults to HTML and submits %s as a preference without rewriting the user's prompt",
  async (format) => {
    const capture = mockTemplateChat();
    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: enabledFeatures,
    });
    const editor = await findComposerEditor();
    const formats = await openPresentation();
    expect(button("HTML", formats)).toHaveAttribute("aria-pressed", "true");
    expect(button("PPTX", formats)).toHaveAttribute("aria-pressed", "false");
    // A format is always selected, even when the selected option is clicked again.
    click(button("HTML", formats));
    expect(button("HTML", formats)).toHaveAttribute("aria-pressed", "true");
    if (format === "PPTX") {
      click(button("PPTX", formats));
    }
    expect(button(format, formats)).toHaveAttribute("aria-pressed", "true");
    await fill(editor, "Our launch deck; use PPTX for this one");
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    const shelf = screen.getByRole("group", { name: "Presentation templates" });
    click(button(template.title, shelf));
    click(button("Send"));
    await waitFor(() => {
      expect(capture.sentMessages).toHaveLength(1);
    });
    expect(capture.runPrompts).toStrictEqual([
      expect.stringContaining("Our launch deck; use PPTX for this one"),
    ]);
    expect(capture.selectedTemplates[0]).toMatchObject({
      type: "presentation",
    });
    expect(capture.sentMessages[0]?.parts).toContainEqual({
      type: "additional_info",
      text: expect.stringContaining(`- Output format: ${format} format`),
    });
    expect(capture.sentMessages[0]?.parts).toContainEqual({
      type: "additional_info",
      text: expect.stringContaining(
        "The output format is a preference. Where this run's message asks for a different output format or slide count, the message wins.",
      ),
    });
  },
);

test("A changed format survives a fresh page and is shared by Chart presentation output", async () => {
  mockTemplateChat();
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: enabledFeatures,
  });
  await findComposerEditor();
  const formats = await openPresentation();
  const user = userEvent.setup({ delay: null });
  button("PPTX", formats).focus();
  await user.keyboard("{Enter}");
  expect(button("PPTX", formats)).toHaveAttribute("aria-pressed", "true");

  // Replace the app graph, keeping browser storage as a page reload does.
  cleanup();
  vi.mocked(window.history.pushState).mockRestore();
  vi.mocked(window.history.replaceState).mockRestore();
  vi.mocked(window.history.back).mockRestore();
  vi.mocked(window.history.forward).mockRestore();
  const capture = mockTemplateChat();
  await setupPage({
    context: reloadedContext,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: enabledFeatures,
  });
  const editor = await findComposerEditor();
  const restored = await openPresentation();
  expect(button("PPTX", restored)).toHaveAttribute("aria-pressed", "true");
  const chart = await openChart();
  const outputs = within(chart).getByRole("group", { name: "Output format" });
  click(button("Presentation", outputs));
  const chartFormats = await within(chart).findByRole("group", {
    name: "Presentation format",
  });
  expect(button("PPTX", chartFormats)).toHaveAttribute("aria-pressed", "true");
  await fill(editor, "Explain our quarterly results");
  click(button("Send"));
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(capture.sentMessages[0]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining(
      "- Preferred output format: presentation (PPTX format)",
    ),
  });
  // Keep the structured selection compatible with message summaries.
  expect(capture.sentMessages[0]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining(
      "- User-selected output format: presentation",
    ),
  });
});

test("Chart presentation output uses HTML until the user changes the preference", async () => {
  const capture = mockTemplateChat();
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: enabledFeatures,
  });
  const editor = await findComposerEditor();
  await openPresentation();
  const chart = await openChart();
  const outputs = within(chart).getByRole("group", { name: "Output format" });
  click(button("Presentation", outputs));
  const formats = await within(chart).findByRole("group", {
    name: "Presentation format",
  });
  expect(button("HTML", formats)).toHaveAttribute("aria-pressed", "true");
  await fill(editor, "Visualize our results");
  click(button("Send"));
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(capture.sentMessages[0]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining(
      "- Preferred output format: presentation (HTML format)",
    ),
  });
});

test("A presentation format preference does not change another Chart output type", async () => {
  const capture = mockTemplateChat();
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: enabledFeatures,
  });
  const editor = await findComposerEditor();
  const formats = await openPresentation();
  click(button("PPTX", formats));
  const chart = await openChart();
  const outputs = within(chart).getByRole("group", { name: "Output format" });
  click(button("Website", outputs));
  expect(button("Website", outputs)).toHaveAttribute("aria-pressed", "true");
  await fill(editor, "Make a dashboard");
  click(button("Send"));
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  const instructions = capture.sentMessages[0]?.parts.find((part) => {
    return part.type === "additional_info";
  });
  expect(instructions).toMatchObject({
    type: "additional_info",
    text: expect.stringContaining("- Preferred output format: website"),
  });
  expect(instructions?.text).not.toContain("PPTX");
});

test.each([
  { home: true, format: false },
  { home: false, format: true },
])(
  "Presentation preserves its existing behavior when home=$home and format=$format",
  async ({ home, format }) => {
    const capture = mockTemplateChat();
    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: {
        [FeatureSwitchKey.HomeCapabilities]: home,
        [FeatureSwitchKey.PresentationOutputFormat]: format,
      },
    });
    const editor = await findComposerEditor();
    const tasks = screen.getByRole("group", {
      name: home ? "Explore Okou capabilities" : "Choose a task",
    });
    click(button("Presentation", tasks));
    await screen.findByRole("group", { name: "Presentation templates" });
    expect(screen.queryByRole("group", { name: "Output format" })).toBeNull();
    await fill(editor, "Prepare our deck");
    click(button("Send"));
    await waitFor(() => {
      expect(capture.sentMessages).toHaveLength(1);
    });
    expect(capture.sentMessages[0]?.parts).toContainEqual({
      type: "additional_info",
      text: [
        "Create a presentation.",
        "",
        "# Presentation Generation Defaults",
        "The user set these for presentations generated in this run:",
        "- Slide count: 8-12",
        "Where this run's message asks for a different slide count, the message wins.",
      ].join("\n"),
    });
  },
);
