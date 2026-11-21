import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  mockAttachmentChat,
  mockSplitAttachmentChats,
  ATTACHMENT_THREAD_ID,
  SECOND_ATTACHMENT_THREAD_ID,
} from "./chat-attachment-test-helpers.ts";
import { findLink, queryButton } from "./chat-run-test-fixtures.ts";

const context = testContext();
const createdAt = "2026-10-01T11:00:00Z";
const runId = "0f1b14c5-bb0c-4fff-b889-856c59166e46";

test("chat-capability-history-visibility-002 keeps the four saved template names readable in the sent message", async () => {
  const templates = [
    {
      type: "template",
      titleSnapshot: "Quarterly Storyboard",
      template: {
        type: "presentation",
        selection: { templateId: "storyboard" },
      },
    },
    {
      type: "template",
      titleSnapshot: "Warm Documentary",
      template: { type: "video", selection: { stylePresetId: "documentary" } },
    },
    {
      type: "template",
      titleSnapshot: "Paper Cutout",
      template: {
        type: "illustration",
        selection: { illustrationStyleId: "cutout" },
      },
    },
    {
      type: "template",
      titleSnapshot: "Editorial Landing Page",
      template: {
        type: "website",
        selection: { websiteTemplateId: "editorial" },
      },
    },
  ] satisfies UserMessageDocument["parts"];
  mockAttachmentChat(context, {
    chatEvents: [
      {
        role: "user",
        content: null,
        createdAt,
        runId,
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: "Use our launch templates" },
            ...templates,
          ],
        },
      },
    ],
  });
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  const prompt = await screen.findByText("Use our launch templates");
  const turn = within(prompt.closest<HTMLElement>('[data-role="user"]')!);
  for (const template of templates) {
    const label = turn.getByText(template.titleSnapshot);
    expect(
      label.closest("button, a, [role=button], [role=link], [tabindex='0']"),
    ).toBeNull();
  }
});

test("chat-capability-history-visibility-003 switches from an active run to the finished chat and its answer", async () => {
  const question = "Collect launch responses";
  mockSplitAttachmentChats(
    context,
    {
      threadId: ATTACHMENT_THREAD_ID,
      title: "Ongoing collection",
      events: [{ role: "user", content: question, createdAt, runId }],
    },
    {
      threadId: SECOND_ATTACHMENT_THREAD_ID,
      title: "Published report",
      events: [
        {
          role: "user",
          content: "Publish the summary",
          createdAt,
          runId: "690eb790-cd51-4501-82da-5ae78a51ac42",
        },
        {
          role: "assistant",
          content: "The summary is published",
          createdAt,
          runId: "690eb790-cd51-4501-82da-5ae78a51ac42",
          runLifecycleEvent: "completed",
        },
      ],
    },
  );
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  await screen.findByText(question);
  await screen.findByLabelText("Stop");
  click(await findLink("Published report"));
  await screen.findByText("The summary is published");
  expect(window.location.pathname).toBe(
    `/chats/${SECOND_ATTACHMENT_THREAD_ID}`,
  );
  expect(screen.queryByText(question)).not.toBeInTheDocument();
  expect(queryButton("Stop")).not.toBeInTheDocument();
});
