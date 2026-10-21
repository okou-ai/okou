import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";
import {
  agentDraftContract,
  type AgentDraftRequest,
} from "@okouai/api-contracts/contracts/agent-draft";
import {
  AGENT_ID,
  expectInlineTemplate,
  openTemplatePicker,
  sendComposerMessage,
  templatePart,
  createTemplateGalleryHelpers,
} from "./chat-composer-template-gallery-test-helpers.ts";
import { CLAUDE_SUBSCRIPTION_PROVIDER_ID } from "./chat-composer-test-helpers.ts";
import { buildRunModel } from "./chat-model-builders.ts";

const context = testContext();
const { mockPresentationHtml, mockTemplateChat } =
  createTemplateGalleryHelpers(context);

function builtInTemplate(index = 0) {
  const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[index];
  if (!template) {
    throw new Error(`Presentation template ${index} not found`);
  }
  return template;
}

function detailGroup(title: string): HTMLElement {
  const preview = Array.from(
    document.querySelectorAll<HTMLElement>('[role="group"]'),
  ).find((group) => {
    return (
      group.getAttribute("aria-label") === `${title} slide preview` &&
      !group.closest('[aria-hidden="true"], [hidden], [inert]')
    );
  });
  if (!preview) {
    throw new Error(`Expected the ${title} slide preview`);
  }
  return preview;
}

function buttonByLabel(label: string, container: ParentNode): HTMLElement {
  const buttons = queryAllByRoleFast("button", container).filter((button) => {
    return button.getAttribute("aria-label") === label;
  });
  const [button] = buttons;
  if (buttons.length !== 1 || !button) {
    throw new Error(`Expected one button labelled ${label}`);
  }
  return button;
}

async function openPresentationThemePreview() {
  const capture = mockTemplateChat();
  context.mocks.data.userPreferences({ timezone: "UTC", locale: "en-US" });
  context.mocks.data.availableRunModels([
    buildRunModel({
      model: "claude-sonnet-5",
      modelProviderId: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
    }),
  ]);
  const template = builtInTemplate();
  const drafts = mockSavedThemeDraft(template.colorSystemId);
  mockPresentationHtml(template.embedUrl, ["Opening"]);
  const user = userEvent.setup({ delay: null });

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.okou.ai",
  });

  const inline = await expectInlineTemplate(template.title);
  const edit = queryAllByRoleFast("button", inline)[0];
  if (!edit) {
    throw new Error("The saved presentation template has no edit control");
  }
  click(edit);
  const preview = await waitFor(() => {
    return buttonByLabel(
      `Preview ${template.title} at current slide`,
      document.body,
    );
  });
  const dialog = preview.closest('[role="dialog"]');
  if (!(dialog instanceof HTMLElement)) {
    throw new Error("Expected the presentation template picker dialog");
  }
  click(preview);
  await waitFor(() => {
    expect(detailGroup(template.title)).toBeInTheDocument();
  });
  return {
    capture,
    template,
    user,
    drafts,
    dialog,
    detail: detailGroup(template.title),
  };
}

test("Select a presentation theme from its preview", async () => {
  const { capture, template, drafts, dialog } =
    await openPresentationThemePreview();
  click(buttonByLabel("Select style Deep dive", dialog));
  click(buttonByLabel(`Select template ${template.title}`, dialog));
  await expectInlineTemplate(template.title);
  await waitFor(() => {
    expect(drafts).toContainEqual(
      expect.objectContaining({
        draftUserMessage: {
          version: 1,
          parts: expect.arrayContaining([
            expect.objectContaining({
              type: "template",
              template: expect.objectContaining({
                type: "presentation",
                selection: expect.objectContaining({
                  templateId: template.templateId,
                  colorSystemId: "color-system:ocean-deep",
                }),
              }),
            }),
          ]),
        },
      }),
    );
  });
  expect(capture.sentMessages).toStrictEqual([]);
});

function mockSavedThemeDraft(colorSystemId: string) {
  const template = builtInTemplate();
  const drafts: AgentDraftRequest[] = [];
  context.mocks.api(agentDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: {
        version: 1,
        parts: [
          {
            type: "template",
            titleSnapshot: template.title,
            template: {
              type: "presentation",
              selection: {
                templateId: template.templateId,
                colorSystemId,
              },
            },
          },
        ],
      },
      draftAttachments: null,
    });
  });
  context.mocks.api(agentDraftContract.patch, ({ body, respond }) => {
    drafts.push(body);
    return respond(204);
  });
  return drafts;
}

test("Send a presentation theme restored from a saved draft", async () => {
  const capture = mockTemplateChat();
  const template = builtInTemplate();
  const user = userEvent.setup({ delay: null });
  mockSavedThemeDraft("color-system:ocean-deep");
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.okou.ai",
  });
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

function stagePreviewFrame(title: string): HTMLIFrameElement {
  const frame = screen.getByTitle(`${title} HTML preview`);
  if (!(frame instanceof HTMLIFrameElement)) {
    throw new Error("The stage preview is not a frame");
  }
  return frame;
}

function loadPreviewFrame(frame: HTMLIFrameElement): void {
  const frameDocument = frame.contentDocument;
  if (frameDocument === null) {
    throw new Error("Presentation preview frame has no document");
  }
  frameDocument.open();
  frameDocument.write(frame.srcdoc);
  frameDocument.close();
  fireEvent.load(frame);
}

/** The accent the slide on the stage is painted with right now. */
function stageAccent(title: string): string {
  const frameDocument = stagePreviewFrame(title).contentDocument;
  const frameWindow = frameDocument?.defaultView;
  if (!frameDocument || !frameWindow) {
    throw new Error("The stage preview has no rendered document");
  }
  return frameWindow
    .getComputedStyle(frameDocument.documentElement)
    .getPropertyValue("--accent")
    .trim();
}

test("A slide already on the stage takes a new theme as soon as it is picked", async () => {
  await openThreeSlidePreview();
  const template = builtInTemplate();
  loadPreviewFrame(stagePreviewFrame(template.title));
  expect(stageAccent(template.title)).toBe("#7257E6");

  click(
    within(screen.getByRole("dialog")).getByLabelText("Select style Deep dive"),
  );

  expect(stageAccent(template.title)).toBe("#38C7B4");
});
