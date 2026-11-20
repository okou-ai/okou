import { chatThreadDraftContract } from "@okouai/api-contracts/contracts/chat-threads";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { clickComposerAddMenuItem } from "./chat-composer-add-menu-test-helpers.ts";
import {
  createTemplateGalleryHelpers,
  expectInlineTemplate,
  THREAD_ID,
} from "./chat-composer-template-gallery-test-helpers.ts";

const context = testContext();

test("chat-composer-template-titles-002 dismisses the caption hint when the pointer leaves", async () => {
  const saved = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((item) => {
    return item.title === "Candy charts";
  })!;
  createTemplateGalleryHelpers(context).mockTemplateChat();
  context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftAttachments: [],
      draftUserMessage: {
        version: 1,
        parts: [
          {
            type: "template",
            titleSnapshot: saved.title,
            template: {
              type: "presentation",
              selection: {
                templateId: saved.templateId,
                colorSystemId: saved.colorSystemId,
              },
            },
          },
        ],
      },
    });
  });
  await setupPage({ context, path: `/chats/${THREAD_ID}` });
  await expectInlineTemplate(saved.title);
  await clickComposerAddMenuItem("Template");
  const picker = within(await screen.findByRole("dialog"));
  const caption = picker.getByText("Paper magazine", { selector: "p" });
  const user = userEvent.setup({ delay: null });
  await user.hover(caption);
  // The full title is a visual hint. The accessible preview control already names it.
  const hint = await screen.findByText("Paper magazine", {
    selector: '[data-slot="tooltip-content"]',
  });
  await waitFor(() => {
    expect(hint).toBeVisible();
  });
  await user.unhover(caption);
  await waitFor(() => {
    expect(hint).not.toBeVisible();
  });
});
