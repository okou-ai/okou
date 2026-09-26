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
const RUN_ID = "d0000000-0000-4000-a000-000000000071";
const LINKED_THREAD_ID = "b0000000-0000-4000-a000-000000000071";
const LINKED_URL = `https://app.okou.ai/chats/${LINKED_THREAD_ID}`;
const EXTERNAL_URL = `https://example.com/chats/${LINKED_THREAD_ID}`;
const RUN_URL = `${LINKED_URL}?tab=files#run-1`;

const PROMPT = `Compare ${LINKED_URL} with ${EXTERNAL_URL} and ${RUN_URL} please`;
const REPLY = [
  `Reply: see ${LINKED_URL}.`,
  "",
  `Also [Planning notes](/chats/${LINKED_THREAD_ID}) and ${EXTERNAL_URL}.`,
  "",
  `Code stays code: \`${LINKED_URL}\``,
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
  const replyText = await screen.findByText(/Reply: see/u);
  const reply = replyText.closest<HTMLElement>(".wmde-markdown");
  if (!reply) {
    throw new Error("Expected the reply inside a Markdown frame");
  }
  return { message, reply };
}

function linksIn(container: HTMLElement): HTMLElement[] {
  return queryAllByRoleFast("link", container);
}

function chipNamed(container: HTMLElement, title: string): HTMLElement[] {
  return linksIn(container).filter((link) => {
    return link.getAttribute("aria-label") === `Open chat ${title}`;
  });
}

function externalLinkTo(container: HTMLElement, href: string): HTMLElement {
  const link = linksIn(container).find((candidate) => {
    return candidate.getAttribute("href") === href;
  });
  if (!link) {
    throw new Error(`Expected a link to ${href}`);
  }
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  return link;
}

test("Links to App chats read as chat chips in messages and replies", async () => {
  const { message, reply } = await openChat(true);

  await waitFor(() => {
    expect(chipNamed(message, LINKED_URL)).toHaveLength(1);
  });
  // A bare URL keeps its own text, so the chip never waits on a title.
  const [messageChip] = chipNamed(message, LINKED_URL);
  expect(messageChip).toHaveAttribute("href", `/chats/${LINKED_THREAD_ID}`);
  expect(messageChip).not.toHaveAttribute("target");
  expect(messageChip).toHaveTextContent(LINKED_URL);
  // A deep link keeps its query and hash.
  const [runChip] = chipNamed(message, RUN_URL);
  expect(runChip).toHaveAttribute(
    "href",
    `/chats/${LINKED_THREAD_ID}?tab=files#run-1`,
  );
  expect(externalLinkTo(message, EXTERNAL_URL)).toHaveTextContent(EXTERNAL_URL);

  const [replyChip] = chipNamed(reply, LINKED_URL);
  expect(replyChip).toHaveAttribute("href", `/chats/${LINKED_THREAD_ID}`);
  expect(replyChip).toHaveTextContent(LINKED_URL);
  // An authored label, such as a serialized chat mention, is kept.
  const [labeledChip] = chipNamed(reply, "Planning notes");
  expect(labeledChip).toHaveAttribute("href", `/chats/${LINKED_THREAD_ID}`);
  expect(externalLinkTo(reply, EXTERNAL_URL)).toHaveTextContent(EXTERNAL_URL);
  expect(reply.querySelector("code")).toHaveTextContent(LINKED_URL);
  expect(linksIn(reply)).toHaveLength(3);
});

test("Without the switch, links to App chats stay ordinary links", async () => {
  const { message, reply } = await openChat(false);

  await waitFor(() => {
    expect(externalLinkTo(message, LINKED_URL)).toHaveTextContent(LINKED_URL);
  });
  expect(externalLinkTo(reply, LINKED_URL)).toHaveTextContent(LINKED_URL);
  expect(externalLinkTo(reply, `/chats/${LINKED_THREAD_ID}`)).toHaveTextContent(
    "Planning notes",
  );
  for (const container of [message, reply]) {
    expect(
      linksIn(container).filter((link) => {
        return link.hasAttribute("aria-label");
      }),
    ).toHaveLength(0);
  }
});
