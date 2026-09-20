import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { waitFor } from "@testing-library/react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  context,
  installMessageExperienceChat,
} from "./chat-message-experience-test-helpers.ts";

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

function userMessage(): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    "[data-structured-user-message]",
  );
  if (!element) {
    throw new Error("Structured user message not found");
  }
  return element;
}

function feedbackGroup(): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    "[data-structured-feedback-group]",
  );
  if (!element) {
    throw new Error("Structured feedback group not found");
  }
  return element;
}

function linkTo(href: string, container: ParentNode): HTMLElement {
  const link = queryAllByRoleFast("link", container).find((candidate) => {
    return candidate.getAttribute("href") === href;
  });
  if (!link) {
    throw new Error(`Expected a link to ${href}`);
  }
  return link;
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

  await setupPage({
    context,
    path: `/chats/${context.resourceId}`,
    featureSwitches: { [FeatureSwitchKey.UserMessageLinks]: true },
  });

  const message = await waitFor(() => {
    const element = userMessage();
    // The prompt is not Markdown, so `**bold**` has to survive linking.
    expect(element).toHaveTextContent(prompt);
    return element;
  });
  expect(feedbackGroup()).toHaveTextContent(note);
  for (const href of [
    "https://example.com/brief",
    "https://example.com/sources?tab=1#refs",
  ]) {
    const link = linkTo(href, message);
    expect(link).toHaveTextContent(href);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  }
});

test("A sentence typed onto the end of a link stays outside it", async () => {
  const url = "https://example.com/chats/8635508a-9285-4833-bd9f-88cf83157546";
  const prompt = `${url}二额，另见 https://zh.example.com/wiki/中文 和 https://example.com/搜索?q=中文`;
  installPrompt(prompt);

  await setupPage({
    context,
    path: `/chats/${context.resourceId}`,
    featureSwitches: { [FeatureSwitchKey.UserMessageLinks]: true },
  });

  const message = await waitFor(() => {
    const element = userMessage();
    expect(element).toHaveTextContent(prompt);
    return element;
  });
  // Prose glued to the link is dropped, but a path that is genuinely Chinese
  // stays part of the destination.
  expect(linkTo(url, message)).toHaveTextContent(url);
  for (const chinese of [
    "https://zh.example.com/wiki/中文",
    "https://example.com/搜索?q=中文",
  ]) {
    expect(linkTo(chinese, message)).toHaveTextContent(chinese);
  }
});

test("Text that only looks like a link stays plain text", async () => {
  const prompt = [
    "Bare example.com and mail user@example.com stay text,",
    "and so do javascript:alert(1), data:text/html,<b>x</b>",
    "and ftp://files.example.com/a.txt.",
  ].join(" ");
  installPrompt(prompt);

  await setupPage({
    context,
    path: `/chats/${context.resourceId}`,
    featureSwitches: { [FeatureSwitchKey.UserMessageLinks]: true },
  });

  const message = await waitFor(() => {
    const element = userMessage();
    expect(element).toHaveTextContent(prompt);
    return element;
  });
  expect(queryAllByRoleFast("link", message)).toHaveLength(0);
});

test("With the switch off a link stays plain text", async () => {
  const prompt = "Start from https://example.com/brief and keep reading.";
  installPrompt(prompt);

  await setupPage({
    context,
    path: `/chats/${context.resourceId}`,
    featureSwitches: { [FeatureSwitchKey.UserMessageLinks]: false },
  });

  const message = await waitFor(() => {
    const element = userMessage();
    expect(element).toHaveTextContent(prompt);
    return element;
  });
  expect(queryAllByRoleFast("link", message)).toHaveLength(0);
});
