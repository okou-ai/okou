import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";
import { VIDEO_TEMPLATE_ITEMS } from "@okouai/core/video-template-items";
import { WEBSITE_TEMPLATE_ITEMS } from "@okouai/core/website-template-items";
import {
  buttonContainingText,
  tabByText,
} from "./chat-composer-test-helpers.ts";
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

test("Changing a presentation theme refreshes its visible preview", async () => {
  const { template, detail } = await openPresentationThemePreview();
  const firstFrame = await waitFor(() => {
    return within(detail).getByTitle(`${template.title} HTML preview`);
  });
  const firstFrameHtml = firstFrame.getAttribute("srcdoc");

  click(screen.getByLabelText("Select style Deep dive"));
  const themedFrame = await waitFor(() => {
    const frame = within(detail).getByTitle(`${template.title} HTML preview`);
    expect(frame.getAttribute("srcdoc")).not.toBe(firstFrameHtml);
    expect(frame.getAttribute("srcdoc")).toContain("Opening");
    return frame;
  });
  expect(screen.getByLabelText("Select style Deep dive")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  fireEvent.load(themedFrame);
  expect(themedFrame).toBeVisible();
});

test("Opening a hovered presentation keeps the currently previewed slide", async () => {
  mockTemplateChat();
  const template = builtInTemplate();
  const releaseHtml = context.mocks.deferred<void>();
  context.mocks.http.get(template.embedUrl, async () => {
    await releaseHtml.promise;
    return HttpResponse.html(`<!doctype html><html><body>
      <section data-okou-slide data-slide-id="opening"><h1>Opening overview</h1></section>
      <section data-okou-slide data-slide-id="middle"><h1>Supporting details</h1></section>
      <section data-okou-slide data-slide-id="closing"><h1>Closing recommendations</h1></section>
    </body></html>`);
  });
  const user = userEvent.setup();

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.okou.ai",
  });

  await openTemplatePicker(user, "Presentation");
  const previewControl = screen.getByLabelText(
    `Preview ${template.title} at current slide`,
  );
  const media = previewControl.parentElement;
  if (media === null) {
    throw new Error("Presentation preview media not found");
  }
  vi.spyOn(media, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 300, 169),
  );

  await user.hover(previewControl);
  await waitFor(() => {
    expect(media).toHaveAttribute("aria-busy", "true");
  });
  releaseHtml.resolve();
  await waitFor(() => {
    expect(media).toHaveAttribute("aria-busy", "false");
  });

  await user.pointer({
    target: previewControl,
    coords: { clientX: 299, clientY: 80 },
  });
  const cardFrame = await within(media).findByTitle(
    `${template.title} active HTML preview`,
  );
  expect(cardFrame.getAttribute("srcdoc")).toContain("Closing recommendations");
  fireEvent.load(cardFrame);
  expect(cardFrame).toBeVisible();

  click(previewControl);
  const detail = await screen.findByRole("group", {
    name: `${template.title} slide preview`,
  });
  const detailFrame = await within(detail).findByTitle(
    `${template.title} HTML preview`,
  );
  expect(detailFrame.getAttribute("srcdoc")).toContain(
    "Closing recommendations",
  );
  expect(screen.getByLabelText("Preview slide 3")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByLabelText("Preview next slide")).toBeDisabled();
});

test("A late presentation response preserves the template currently being previewed", async () => {
  mockTemplateChat();
  const slowTemplate = builtInTemplate();
  const currentTemplate = builtInTemplate(1);
  const slowStarted = context.mocks.deferred<void>();
  const releaseSlow = context.mocks.deferred<void>();
  const slowReturned = context.mocks.deferred<void>();
  context.mocks.http.get(slowTemplate.embedUrl, async () => {
    slowStarted.resolve();
    await releaseSlow.promise;
    const response = HttpResponse.html(`<!doctype html><html><body>
      <section data-okou-slide data-slide-id="old"><h1>Previous template</h1></section>
    </body></html>`);
    slowReturned.resolve();
    return response;
  });
  mockPresentationHtml(currentTemplate.embedUrl, [
    "Current opening",
    "Current closing",
  ]);
  const user = userEvent.setup();

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.okou.ai",
  });

  const picker = await openTemplatePicker(user, "Presentation");
  click(
    screen.getByLabelText(`Preview ${slowTemplate.title} at current slide`),
  );
  await expect(
    screen.findByRole("group", {
      name: `${slowTemplate.title} slide preview`,
    }),
  ).resolves.toBeInTheDocument();
  await slowStarted.promise;

  click(buttonContainingText("Template", picker));
  const openCurrent = await screen.findByLabelText(
    `Preview ${currentTemplate.title} at current slide`,
  );
  click(openCurrent);
  const preview = await screen.findByRole("group", {
    name: `${currentTemplate.title} slide preview`,
  });
  await expect(
    within(preview).findByTitle(`${currentTemplate.title} HTML preview`),
  ).resolves.toBeInTheDocument();
  click(screen.getByLabelText("Preview slide 2"));
  await waitFor(() => {
    expect(
      within(preview)
        .getByTitle(`${currentTemplate.title} HTML preview`)
        .getAttribute("srcdoc"),
    ).toContain("Current closing");
  });

  await act(async () => {
    releaseSlow.resolve();
    await slowReturned.promise;
  });

  expect(
    within(detailGroup(currentTemplate.title))
      .getByTitle(`${currentTemplate.title} HTML preview`)
      .getAttribute("srcdoc"),
  ).toContain("Current closing");
  expect(screen.getByLabelText("Preview slide 2")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByLabelText("Preview next slide")).toBeDisabled();
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
