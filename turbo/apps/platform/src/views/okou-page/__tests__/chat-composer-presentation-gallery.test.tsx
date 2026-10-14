import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";
import {
  AGENT_ID,
  context,
  expectInlineTemplate,
  mockPresentationHtml,
  mockTemplateChat,
  openTemplatePicker,
  sendComposerMessage,
  templatePart,
} from "./chat-composer-template-gallery-test-helpers.ts";

function builtInTemplate(index = 0) {
  const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[index];
  if (!template) {
    throw new Error(`Presentation template ${index} not found`);
  }
  return template;
}

function detailGroup(title: string): HTMLElement {
  return screen.getByRole("group", { name: `${title} slide preview` });
}

async function openPresentationThemePreview() {
  const capture = mockTemplateChat();
  const template = builtInTemplate();
  mockPresentationHtml(template.embedUrl, ["Opening"]);
  const user = userEvent.setup();

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.okou.ai",
  });

  await openTemplatePicker(user, "Presentation");
  click(screen.getByLabelText(`Preview ${template.title} at current slide`));
  await waitFor(() => {
    expect(detailGroup(template.title)).toBeVisible();
  });
  return { capture, template, user, detail: detailGroup(template.title) };
}

test("Send the selected presentation theme from its preview", async () => {
  const { capture, template, user } = await openPresentationThemePreview();
  click(screen.getByLabelText("Select style Deep dive"));
  click(
    within(screen.getByRole("dialog")).getByLabelText(
      `Select template ${template.title}`,
    ),
  );
  await expectInlineTemplate(template.title);
  await sendComposerMessage(user, "Create the quarterly presentation");
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(templatePart(capture.sentMessages[0]!).template).toMatchObject({
    type: "presentation",
    selection: {
      templateId: template.templateId,
      colorSystemId: "color-system:ocean-deep",
    },
  });
});

test("Use a presentation template's default theme", async () => {
  const capture = mockTemplateChat();
  const template = builtInTemplate();
  const defaultTheme = template.colorSystemId;
  const user = userEvent.setup();

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.okou.ai",
  });

  await openTemplatePicker(user, "Presentation");
  click(screen.getByLabelText(`Select template ${template.title}`));
  await expectInlineTemplate(template.title);
  await sendComposerMessage(user, "Create a presentation with this template");
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(templatePart(capture.sentMessages[0]!).template).toMatchObject({
    type: "presentation",
    selection: {
      templateId: template.templateId,
      colorSystemId: defaultTheme,
    },
  });
});

test("Navigate every slide in a presentation template", async () => {
  mockTemplateChat();
  const template = builtInTemplate();
  mockPresentationHtml(template.embedUrl, ["One", "Two", "Three", "Four"]);
  const user = userEvent.setup();

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.okou.ai",
  });

  await openTemplatePicker(user, "Presentation");
  await user.click(
    screen.getByLabelText(`Preview ${template.title} at current slide`),
  );
  const preview = await waitFor(() => {
    return detailGroup(template.title);
  });
  expect(screen.getByLabelText("Preview previous slide")).toBeDisabled();
  await user.click(screen.getByLabelText("Preview next slide"));
  expect(screen.getByLabelText("Preview slide 2")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  preview.focus();
  await user.keyboard("{ArrowRight}");
  expect(screen.getByLabelText("Preview slide 3")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await user.click(screen.getByLabelText("Preview slide 4"));
  expect(screen.getByLabelText("Preview slide 4")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByLabelText("Preview next slide")).toBeDisabled();
  await user.keyboard("{ArrowRight}");
  expect(screen.getByLabelText("Preview slide 4")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await user.click(screen.getByLabelText("Preview previous slide"));
  expect(screen.getByLabelText("Preview slide 3")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByLabelText("Preview slide 3")).toBeVisible();
});

async function openThreeSlidePreview() {
  mockTemplateChat();
  const template = builtInTemplate();
  mockPresentationHtml(template.embedUrl, ["One", "Two", "Three"]);
  const user = userEvent.setup();

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.okou.ai",
  });

  await openTemplatePicker(user, "Presentation");
  click(screen.getByLabelText(`Preview ${template.title} at current slide`));
  const preview = await waitFor(() => {
    return detailGroup(template.title);
  });
  await expect(
    within(preview).findByText("1 / 3"),
  ).resolves.toBeInTheDocument();
  return { preview, user };
}

test("Count slides and pick a theme by name in a presentation template preview", async () => {
  const { preview } = await openThreeSlidePreview();

  click(screen.getByLabelText("Preview next slide"));
  expect(within(preview).getByText("2 / 3")).toBeInTheDocument();

  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("Candy party")).toBeInTheDocument();
  click(within(dialog).getByText("Deep dive"));
  expect(screen.getByLabelText("Select style Deep dive")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(within(preview).getByText("2 / 3")).toBeInTheDocument();
});

test("Step back through a presentation template from its filmstrip", async () => {
  const { preview, user } = await openThreeSlidePreview();

  const lastSlide = screen.getByLabelText("Preview slide 3");
  click(lastSlide);
  expect(within(preview).getByText("3 / 3")).toBeInTheDocument();

  lastSlide.focus();
  await user.keyboard("{ArrowLeft}");
  expect(screen.getByLabelText("Preview slide 2")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(within(preview).getByText("2 / 3")).toBeInTheDocument();
});

function loadPreviewFrame(frame: HTMLIFrameElement): Document {
  const frameDocument = frame.contentDocument;
  if (frameDocument === null) {
    throw new Error("Presentation preview frame has no document");
  }
  frameDocument.open();
  frameDocument.write(frame.srcdoc);
  frameDocument.close();
  fireEvent.load(frame);
  return frameDocument;
}

function previewThemeStyle(frameDocument: Document): string {
  return (
    frameDocument.querySelector("style[data-okou-preview-theme]")
      ?.textContent ?? ""
  );
}

test("Repaint a loaded presentation slide in place when its theme changes", async () => {
  await openThreeSlidePreview();
  const template = builtInTemplate();
  const frame = screen.getByTitle(`${template.title} HTML preview`);
  if (!(frame instanceof HTMLIFrameElement)) {
    throw new Error("The stage preview is not a frame");
  }
  const frameDocument = loadPreviewFrame(frame);
  expect(previewThemeStyle(frameDocument)).toContain("#7257E6");

  click(
    within(screen.getByRole("dialog")).getByLabelText("Select style Deep dive"),
  );

  expect(previewThemeStyle(frameDocument)).toContain("#38C7B4");
  expect(frame.srcdoc).not.toContain("#38C7B4");
  expect(frame).toHaveAttribute("data-loaded", "true");
});
