import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
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
const RUN_ID = "d0000000-0000-4000-a000-000000000081";
const BROWSER_THREAD_ID = "d6bb3884-253f-462b-b3ef-aa9aaba5b201";
const BROWSER_PATH = `/browsers/${BROWSER_THREAD_ID}`;
const BROWSER_URL = `https://app.okou.ai${BROWSER_PATH}`;
const EXTERNAL_URL = `https://example.com${BROWSER_PATH}`;

const PROMPT = `Why is ${BROWSER_URL} not a card? Unlike ${EXTERNAL_URL}`;
const REPLY = [
  `Reply: the browser is at ${BROWSER_URL}.`,
  "",
  `Also [Research browser](${BROWSER_PATH}) and ${EXTERNAL_URL}.`,
].join("\n");

async function openChat(chipsEnabled: boolean): Promise<{
  message: HTMLElement;
  reply: HTMLElement;
}> {
  installMessageExperienceChat({
    threadId: context.resourceId,
    threadTitle: "Current chat",
    chatEvents: [
      {
        id: `message-${RUN_ID}`,
        role: "user",
        content: PROMPT,
        userMessage: { version: 1, parts: [{ type: "text", text: PROMPT }] },
        runId: RUN_ID,
        createdAt: CREATED_AT,
      },
      {
        id: `${RUN_ID}-assistant`,
        role: "assistant",
        content: REPLY,
        runId: RUN_ID,
        runLifecycleEvent: "completed",
        createdAt: "2026-08-20T12:00:05.000Z",
      },
    ],
  });
  await setupPage({
    context,
    path: `/chats/${context.resourceId}`,
    featureSwitches: { [FeatureSwitchKey.ChatThreadLinkChips]: chipsEnabled },
  });

  const message = await waitFor(() => {
    const element = document.querySelector<HTMLElement>(
      "[data-structured-user-message]",
    );
    if (!element) {
      throw new Error("Structured user message not found");
    }
    return element;
  });
  const replyText = await screen.findByText(/Reply: the browser/u);
  const reply = replyText.closest<HTMLElement>(".wmde-markdown");
  if (!reply) {
    throw new Error("Expected the reply inside a Markdown frame");
  }
  return { message, reply };
}

function linksTo(container: HTMLElement, href: string): HTMLElement[] {
  return queryAllByRoleFast("link", container).filter((link) => {
    return link.getAttribute("href") === href;
  });
}

function expectBrowserChip(link: HTMLElement | undefined, label: string) {
  expect(link).toBeDefined();
  expect(link).not.toHaveAttribute("target");
  expect(link).toHaveTextContent(label);
}

function expectExternalLink(container: HTMLElement, href: string) {
  const [link] = linksTo(container, href);
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveTextContent(href);
}

test("Links to another thread's cloud browser read as browser chips", async () => {
  const { message, reply } = await openChat(true);

  await waitFor(() => {
    expect(linksTo(message, BROWSER_PATH)).toHaveLength(1);
  });
  expectBrowserChip(linksTo(message, BROWSER_PATH)[0], "Cloud browser");
  expectExternalLink(message, EXTERNAL_URL);

  const [bareChip, labeledChip] = linksTo(reply, BROWSER_PATH);
  expectBrowserChip(bareChip, "Cloud browser");
  // An authored label is kept.
  expectBrowserChip(labeledChip, "Research browser");
  expectExternalLink(reply, EXTERNAL_URL);
});

test("Without the switch, cloud browser links stay ordinary links", async () => {
  const { message, reply } = await openChat(false);

  await waitFor(() => {
    expectExternalLink(message, BROWSER_URL);
  });
  expectExternalLink(reply, BROWSER_URL);
  expect(linksTo(message, BROWSER_PATH)).toHaveLength(0);
});
