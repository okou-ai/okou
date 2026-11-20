import {
  chatThreadDraftContract,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { userTemplatesContract } from "@okouai/api-contracts/contracts/user-templates";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import {
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  type PresentationTemplateItem,
} from "@okouai/core/presentation-template-items";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createChatComposerHelpers,
  THREAD_ID,
} from "./chat-composer-test-helpers.ts";
import { expectInlineTemplate } from "./chat-composer-template-gallery-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const { mockAgent, mockBillingCapabilities, mockPersonalModelRoutes } =
  createChatComposerHelpers(context);

function presentationTemplate(
  item: PresentationTemplateItem,
): Extract<UserMessageDocument["parts"][number], { type: "template" }> {
  return {
    type: "template",
    titleSnapshot: item.title,
    template: {
      type: "presentation",
      selection: {
        templateId: item.templateId,
        colorSystemId: item.colorSystemId,
      },
    },
  };
}

function composerTemplates(): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      '[data-slot="chat-composer-card"] [data-composer-inline-template]',
    ),
  ];
}

test("Replacing an inline template preserves a previously sent reference", async () => {
  const [first, , third] = PRESENTATION_TEMPLATE_PICKER_ITEMS;
  if (!first || !third) {
    throw new Error("Expected built-in presentation templates");
  }
  mockAgent();
  mockPersonalModelRoutes();
  mockBillingCapabilities({ restrictedBuiltInModels: false }, "pro");
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        code: "BROWSER_NOT_FOUND",
        message: "Managed browser not found",
      },
    });
  });
  context.mocks.api(userTemplatesContract.list, ({ respond }) => {
    return respond(200, []);
  });
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    selectedModel: "claude-sonnet-5",
    chatEvents: [
      {
        id: "board-deck-request",
        role: "user",
        content: "Draft the board update",
        runId: "d0000000-0000-4000-a000-000000000dc1",
        seqId: 1,
        createdAt: "2026-11-21T08:00:00.000Z",
        userMessage: {
          version: 1,
          parts: [
            presentationTemplate(first),
            { type: "text", text: "Draft the board update" },
          ],
        },
      },
    ],
  });
  context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: {
        version: 1,
        parts: [
          presentationTemplate(first),
          { type: "text", text: "Use the same layout" },
        ],
      },
      draftAttachments: [],
    });
  });
  await setupPage({ context, path: `/chats/${THREAD_ID}` });
  const sent = await screen.findByText("Draft the board update", {
    selector: "[data-role='user'] *",
  });
  const sentTurn = sent.closest<HTMLElement>("[data-role='user']");
  const inline = await expectInlineTemplate(first.title);

  click(inline.querySelector("button") as HTMLElement);

  const picker = await screen.findByRole("dialog");
  click(await within(picker).findByLabelText(`Select template ${third.title}`));

  await expectInlineTemplate(third.title);
  expect(
    composerTemplates().map((template) => {
      return template.textContent?.trim();
    }),
  ).toStrictEqual([third.title]);
  expect(sentTurn).toHaveTextContent(first.title);
});
