import {
  agentDraftContract,
  type AgentDraftRequest,
} from "@okouai/api-contracts/contracts/agent-draft";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  AGENT_ID,
  createTemplateGalleryHelpers,
  expectInlineTemplate,
  openTemplatePicker,
  sendComposerMessage,
  templatePart,
} from "./chat-composer-template-gallery-test-helpers.ts";
import { CLAUDE_SUBSCRIPTION_PROVIDER_ID } from "./chat-composer-test-helpers.ts";
import { buildRunModel } from "./chat-model-builders.ts";

const context = testContext();
const { mockPresentationHtml, mockTemplateChat } =
  createTemplateGalleryHelpers(context);

function builtInTemplate() {
  const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
  if (!template) {
    throw new Error("Presentation template 0 not found");
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

function mockSavedThemeDraft(colorSystemId: string): AgentDraftRequest[] {
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
              selection: { templateId: template.templateId, colorSystemId },
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

async function openNewChat(): Promise<void> {
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.okou.ai",
  });
}

function expectSlideSelected(slide: number): void {
  expect(screen.getByLabelText(`Preview slide ${slide}`)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
}

test("Select a presentation theme from its preview", async () => {
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
  await openNewChat();
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
  await expectInlineTemplate(template.title);
  expect(capture.sentMessages).toStrictEqual([]);
});

test("Send a presentation theme restored from a saved draft", async () => {
  const capture = mockTemplateChat();
  const template = builtInTemplate();
  const user = userEvent.setup({ delay: null });
  mockSavedThemeDraft("color-system:ocean-deep");
  await openNewChat();
  await expectInlineTemplate(template.title);

  await sendComposerMessage(user, "Create the quarterly presentation.");

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
  const user = userEvent.setup();
  await openNewChat();

  await openTemplatePicker(user, "Presentation");
  click(screen.getByLabelText(`Select template ${template.title}`));
  await expectInlineTemplate(template.title);
  await sendComposerMessage(user, "Create a presentation with this template.");

  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(templatePart(capture.sentMessages[0]!).template).toMatchObject({
    type: "presentation",
    selection: {
      templateId: template.templateId,
      colorSystemId: template.colorSystemId,
    },
  });
});

test("Navigate every slide in a presentation template", async () => {
  mockTemplateChat();
  const template = builtInTemplate();
  mockPresentationHtml(template.embedUrl, ["One", "Two", "Three", "Four"]);
  const user = userEvent.setup();
  await openNewChat();
  await openTemplatePicker(user, "Presentation");
  await user.click(
    screen.getByLabelText(`Preview ${template.title} at current slide`),
  );
  const preview = await waitFor(() => {
    return detailGroup(template.title);
  });
  expectSlideSelected(1);
  expect(screen.getByLabelText("Preview previous slide")).toBeDisabled();

  await user.click(screen.getByLabelText("Preview next slide"));
  expectSlideSelected(2);
  preview.focus();
  await user.keyboard("{ArrowRight}");
  expectSlideSelected(3);
  await user.click(screen.getByLabelText("Preview slide 4"));
  expectSlideSelected(4);
  await user.keyboard("{ArrowRight}");
  expectSlideSelected(4);
  await user.click(screen.getByLabelText("Preview previous slide"));

  expectSlideSelected(3);
  expect(screen.getByLabelText("Preview slide 3")).toBeVisible();
});
