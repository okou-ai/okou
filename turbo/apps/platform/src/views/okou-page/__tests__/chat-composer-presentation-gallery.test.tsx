import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";
import { VIDEO_TEMPLATE_ITEMS } from "@okouai/core/video-template-items";
import { WEBSITE_TEMPLATE_ITEMS } from "@okouai/core/website-template-items";
import { tabByText } from "./chat-composer-test-helpers.ts";
import {
  AGENT_ID,
  context,
  expectInlineTemplate,
  mockPresentationHtml,
  mockTemplateChat,
  mockTemplateObjectUrls,
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

function installImmediateAnimationFrames(): void {
  const frame = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => {
      callback(performance.now());
      return 1;
    });
  context.signal.addEventListener(
    "abort",
    () => {
      return frame.mockRestore();
    },
    {
      once: true,
    },
  );
}

async function openPresentationThemePreview() {
  const capture = mockTemplateChat();
  const template = builtInTemplate();
  mockTemplateObjectUrls();
  mockPresentationHtml(template.embedUrl, ["Opening"]);
  installImmediateAnimationFrames();
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

test("Changing a presentation theme refreshes its visible preview", async () => {
  const { template, detail } = await openPresentationThemePreview();
  const firstFrame = await waitFor(() => {
    return within(detail).getByTitle(`${template.title} HTML preview`);
  });
  const firstFrameUrl = firstFrame.getAttribute("src");

  click(screen.getByLabelText("Select style Deep dive"));
  const themedFrame = await waitFor(() => {
    const frame = within(detail).getByTitle(`${template.title} HTML preview`);
    expect(frame.getAttribute("src")).not.toBe(firstFrameUrl);
    return frame;
  });
  expect(themedFrame).toBeVisible();
});

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
  const defaultTheme = template.colorSystemId ?? "color-system:warm-sand";
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
  mockTemplateObjectUrls();
  mockPresentationHtml(template.embedUrl, ["One", "Two", "Three", "Four"]);
  installImmediateAnimationFrames();
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

test("Navigate template categories on different screen sizes", async () => {
  mockTemplateChat();
  const user = userEvent.setup();

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.okou.ai",
  });

  await openTemplatePicker(user);
  const presentation = tabByText("Presentation");
  presentation.focus();
  await user.keyboard("{ArrowDown}");
  expect(tabByText("Website")).toHaveAttribute("aria-selected", "true");
  expect(
    screen.getByLabelText(
      `Preview website template ${WEBSITE_TEMPLATE_ITEMS[0]!.title}`,
    ),
  ).toBeVisible();

  await user.keyboard("{End}");
  expect(tabByText("Workflow")).toHaveAttribute("aria-selected", "true");
  expect(
    document.querySelector("[data-workflow-template-grid-scroll]"),
  ).toBeInTheDocument();
  await user.keyboard("{Home}");
  expect(tabByText("Presentation")).toHaveAttribute("aria-selected", "true");
  expect(
    screen.getByLabelText(`Select template ${builtInTemplate().title}`),
  ).toBeVisible();
});

test("Navigate template categories on a narrow screen", async () => {
  mockTemplateChat();
  context.mocks.browser.matchMedia(false);
  const user = userEvent.setup();

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.okou.ai",
  });

  await openTemplatePicker(user);
  const category = screen.getByLabelText("Template category");
  await user.click(category);
  await user.click(screen.getByRole("option", { name: "Video" }));
  await waitFor(() => {
    expect(category).toHaveTextContent("Video");
    expect(
      screen.getByLabelText(
        `Select video template ${VIDEO_TEMPLATE_ITEMS[0]!.title}`,
      ),
    ).toBeVisible();
  });
});
