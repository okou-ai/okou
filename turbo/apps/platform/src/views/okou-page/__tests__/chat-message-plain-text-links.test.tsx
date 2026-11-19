import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createMessageExperienceHelpers } from "./chat-message-experience-test-helpers.ts";

const context = testContext();
const { installMessageExperienceChat } =
  createMessageExperienceHelpers(context);

const CREATED_AT = "2026-08-20T12:00:00.000Z";
const RUN_ID = "d0000000-0000-4000-a000-000000000061";

function installPrompt(
  content: string,
  parts: UserMessageDocument["parts"] = [{ type: "text", text: content }],
): void {
  installMessageExperienceChat({
    threadId: context.resourceId,
    chatEvents: [
      {
        id: `message-${RUN_ID}`,
        role: "user",
        content,
        userMessage: { version: 1, parts },
        runId: RUN_ID,
        createdAt: CREATED_AT,
      },
    ],
  });
}

function requiredElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) {
    throw new Error(`${selector} not found`);
  }
  return element;
}

async function openMessage(prompt: string): Promise<HTMLElement> {
  await setupPage({ context, path: `/chats/${context.resourceId}` });
  return waitFor(() => {
    const message = requiredElement("[data-structured-user-message]");
    expect(message).toHaveTextContent(prompt);
    return message;
  });
}

function expectSafeLink(href: string, container: ParentNode): void {
  const link = queryAllByRoleFast("link", container).find((candidate) => {
    return candidate.getAttribute("href") === href;
  });
  expect(link).toHaveTextContent(href);
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
}

test("A link a user typed is clickable in the message and in its feedback note", async () => {
  const prompt =
    "Start from https://example.com/brief and keep **bold** as is.";
  const note = "Add https://example.com/sources?tab=1#refs to the list.";
  installPrompt(prompt, [
    { type: "text", text: prompt },
    {
      type: "feedback",
      quote: "The sources are missing.",
      note: [{ type: "text", text: note }],
    },
  ]);

  const message = await openMessage(prompt);

  const feedback = requiredElement("[data-structured-feedback-group]");
  expect(feedback).toHaveTextContent(note);
  expectSafeLink("https://example.com/brief", message);
  expectSafeLink("https://example.com/sources?tab=1#refs", feedback);
});

test("A link glued to a word or a digit stays plain text", async () => {
  const prompt =
    "ahttps://example.com/one and 3https://example.com/two stay text.";
  installPrompt(prompt);

  const message = await openMessage(prompt);

  expect(queryAllByRoleFast("link", message)).toHaveLength(0);
});

test("Text that only looks like a link stays plain text", async () => {
  const prompt = [
    "Bare example.com and mail user@example.com stay text,",
    "and so do javascript:alert(1), data:text/html,<b>x</b>",
    "and ftp://files.example.com/a.txt.",
  ].join(" ");
  installPrompt(prompt);

  const message = await openMessage(prompt);

  expect(queryAllByRoleFast("link", message)).toHaveLength(0);
});
