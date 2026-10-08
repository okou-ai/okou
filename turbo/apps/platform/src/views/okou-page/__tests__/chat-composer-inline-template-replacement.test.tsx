import { screen, waitFor } from "@testing-library/react";
import { workflowsCollectionContract } from "@okouai/api-contracts";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import {
  composerInlineTemplates,
  context,
  mockAgent,
  selectTemplate,
  THREAD_ID,
} from "./chat-composer-test-helpers.ts";

test("Replacing an inline template preserves a previously sent reference", async () => {
  const first = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
  const replacement = PRESENTATION_TEMPLATE_PICKER_ITEMS[2];
  if (!first || !replacement) {
    throw new Error("Expected presentation templates to insert and replace");
  }
  mockAgent();
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "My thread",
    // Sending and rendering the original reference is covered by the workflow
    // suite. Seed that sent message here so this test owns only replacement.
    chatEvents: [
      {
        id: "msg-sent-template",
        role: "user",
        content: null,
        runId: "d0000000-0000-4000-a000-000000000091",
        createdAt: "2026-09-20T10:00:00Z",
        userMessage: {
          version: 1,
          parts: [
            {
              type: "template",
              titleSnapshot: first.title,
              template: {
                type: "presentation",
                selection: { templateId: first.templateId },
              },
            },
          ],
        },
      },
    ],
  });
  context.mocks.api(workflowsCollectionContract.composer, ({ respond }) => {
    return respond(200, []);
  });

  await setupPage({ context, path: `/chats/${THREAD_ID}` });
  const sentReference = await waitFor(() => {
    const reference = document.querySelector<HTMLElement>(
      "[data-structured-template-reference]",
    );
    expect(reference).toHaveTextContent(first.title);
    return reference;
  });

  await selectTemplate(first);
  const inlineTemplate = composerInlineTemplates()[0];
  if (!inlineTemplate) {
    throw new Error("Expected an inline template to replace");
  }
  const inlineButton = queryAllByRoleFast("button", inlineTemplate)[0];
  if (!inlineButton) {
    throw new Error("Expected inline template button");
  }
  click(inlineButton);
  await expect(screen.findByRole("dialog")).resolves.toBeVisible();
  click(screen.getByLabelText(`Select template ${replacement.title}`));

  await waitFor(() => {
    const templates = composerInlineTemplates();
    expect(templates).toHaveLength(1);
    expect(templates[0]).toHaveTextContent(replacement.title);
  });
  expect(sentReference).toHaveTextContent(first.title);
});
