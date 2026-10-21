import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  holdElementAnimations,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { WEBSITE_TEMPLATE_ITEMS } from "@okouai/core/website-template-items";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import {
  AGENT_ID,
  expectInlineTemplate,
  sendComposerMessage,
  templatePart,
  createTemplateGalleryHelpers,
} from "./chat-composer-template-gallery-test-helpers.ts";
import { CLAUDE_SUBSCRIPTION_PROVIDER_ID } from "./chat-composer-test-helpers.ts";
import { buildRunModel } from "./chat-model-builders.ts";

const context = testContext();
const { mockTemplateChat } = createTemplateGalleryHelpers(context);

function buttonNamed(name: string, container: ParentNode = document.body) {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.replace(/\s+/gu, " ").trim() === name
    );
  });
  if (!button) {
    throw new Error(`${name} button not found`);
  }
  return button;
}

test("Preview a website template and return to its picker", async () => {
  const template = WEBSITE_TEMPLATE_ITEMS[0];
  if (!template) {
    throw new Error("Website template fixture not found");
  }
  mockTemplateChat();
  // Category navigation has its own suite. Open this preview from a genuine
  // saved website draft instead of mounting and replacing another catalog.
  context.mocks.api(agentDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: {
        version: 1,
        parts: [
          {
            type: "template",
            titleSnapshot: template.title,
            template: {
              type: "website",
              selection: { websiteTemplateId: template.id },
            },
          },
        ],
      },
      draftAttachments: null,
    });
  });
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.okou.ai",
  });
  const inline = await expectInlineTemplate(template.title);
  click(buttonNamed(`Preview website template ${template.title}`, inline));
  const picker = await screen.findByRole("dialog");
  click(
    within(picker).getByLabelText(`Preview website template ${template.title}`),
  );
  const frame = await screen.findByTitle(
    `${template.title} website full preview`,
  );
  expect(frame).toHaveAttribute("src", template.previewUrl);
  const previewDialog = frame.closest<HTMLElement>('[role="dialog"]');
  if (!previewDialog) {
    throw new Error("Website preview dialog not found");
  }
  // The preview opens as a dialog inside the gallery, which is what lets the
  // gallery step out of view for as long as it is up. Moving it out of the
  // gallery's tree would leave the two panels overlapping again.
  expect(picker).toHaveAttribute("data-nested-dialog-open");
  const finishCloseTransition = holdElementAnimations(previewDialog);
  click(buttonNamed("Website", previewDialog));
  expect(previewDialog).toBeVisible();
  finishCloseTransition();
  await waitFor(() => {
    expect(previewDialog).not.toBeInTheDocument();
  });
  expect(picker).toBeVisible();
  expect(
    within(picker).getByLabelText(`Preview website template ${template.title}`),
  ).toBeInTheDocument();
});

test("Select and send a website template", async () => {
  const capture = mockTemplateChat();
  context.mocks.data.availableRunModels([
    buildRunModel({
      model: "claude-sonnet-5",
      modelProviderId: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
    }),
  ]);
  const template = WEBSITE_TEMPLATE_ITEMS[0];
  if (!template) {
    throw new Error("Website template fixture not found");
  }
  const user = userEvent.setup({ delay: null });
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat?templatePicker=website`,
    host: "app.okou.ai",
  });
  const picker = await screen.findByRole("dialog");
  click(
    within(picker).getByLabelText(`Select website template ${template.title}`),
  );
  await expectInlineTemplate(template.title);
  await sendComposerMessage(user, "Build this launch site");
  await waitFor(() => {
    return expect(capture.sentMessages).toHaveLength(1);
  });
  expect(templatePart(capture.sentMessages[0]!).template).toStrictEqual({
    type: "website",
    selection: { websiteTemplateId: template.id },
  });
});
