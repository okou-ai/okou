import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "./chat-lifecycle-test-helpers.ts";
import {
  assistantEvent,
  completedEvent,
  createChatRunFixtures,
  promptEvent,
  readyChat,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);

const RUN_ID = "a0000000-0000-4000-a000-000000000621";
const PLAN_THREAD_ID = "b0000000-0000-4000-a000-000000000622";
const FILES_THREAD_ID = "b0000000-0000-4000-a000-000000000623";
const LAUNCH_THREAD_ID = "b0000000-0000-4000-a000-000000000624";
const CODE_THREAD_ID = "b0000000-0000-4000-a000-000000000625";

const PLAN_URL = `https://app.okou.ai/chats/${PLAN_THREAD_ID}`;
const FILES_DEEP_LINK = `https://app.okou.ai/chats/${FILES_THREAD_ID}?view=files#run-42`;
const REPORT_URL = "https://example.com/report?quarter=3";
const DOCS_URL = "https://docs.example.com/guide";
const CODE_URL = `https://app.okou.ai/chats/${CODE_THREAD_ID}`;

/**
 * The user message holding `marker`: the widest ancestor that does not also
 * hold the reply's `exclude` text.
 */
function messageScope(marker: string, exclude: string): HTMLElement {
  const matches = screen.getAllByText((_content, node) => {
    return (
      node instanceof HTMLElement &&
      node.textContent?.startsWith(marker) === true
    );
  });
  let scope = matches[matches.length - 1];
  if (!scope) {
    throw new Error(`Missing message ${marker}`);
  }
  while (
    scope.parentElement &&
    scope.parentElement.textContent?.includes(exclude) !== true
  ) {
    scope = scope.parentElement;
  }
  return scope;
}

function chatChip(title: string, container: ParentNode): HTMLElement {
  const chip = queryAllByRoleFast("link", container).find((link) => {
    return link.getAttribute("aria-label") === `Open chat ${title}`;
  });
  if (!chip) {
    throw new Error(`Missing chat chip ${title}`);
  }
  return chip;
}

function externalLink(href: string, container: ParentNode): HTMLElement {
  const link = queryAllByRoleFast("link", container).find((candidate) => {
    return candidate.getAttribute("href") === href;
  });
  if (!link) {
    throw new Error(`Missing external link ${href}`);
  }
  return link;
}

test("Links to App chats read as chat chips in messages and replies", async () => {
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "chip-request",
        runId: RUN_ID,
        seqId: 1,
        text: `Compare ${PLAN_URL} with ${FILES_DEEP_LINK} and ${REPORT_URL}`,
      }),
      assistantEvent({
        id: "chip-reply",
        runId: RUN_ID,
        seqId: 2,
        text: [
          `Start from [the launch plan](https://app.okou.ai/chats/${LAUNCH_THREAD_ID}),`,
          `then revisit ${PLAN_URL} and read the [guide](${DOCS_URL}).`,
          `Leave \`${CODE_URL}\` as written.`,
        ].join(" "),
      }),
      completedEvent({ id: "chip-complete", runId: RUN_ID, seqId: 3 }),
    ],
  });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();

  const request = messageScope("Compare", "Leave");
  const requestPlanChip = chatChip(PLAN_URL, request);
  expect(requestPlanChip).toHaveAttribute("href", `/chats/${PLAN_THREAD_ID}`);
  expect(requestPlanChip).toHaveTextContent(PLAN_URL);
  const deepLinkChip = chatChip(FILES_DEEP_LINK, request);
  expect(deepLinkChip).toHaveAttribute(
    "href",
    `/chats/${FILES_THREAD_ID}?view=files#run-42`,
  );
  const report = externalLink(REPORT_URL, request);
  expect(report).toHaveAttribute("target", "_blank");
  expect(report).toHaveAttribute("rel", "noopener noreferrer");

  const codeUrl = await screen.findByText((_content, node) => {
    return (
      node instanceof HTMLElement &&
      node.tagName === "CODE" &&
      node.textContent === CODE_URL
    );
  });
  const replyBody = codeUrl.closest("p");
  if (!(replyBody instanceof HTMLElement)) {
    throw new Error("Reply paragraph is not rendered");
  }
  const launchChip = chatChip("the launch plan", replyBody);
  expect(launchChip).toHaveAttribute("href", `/chats/${LAUNCH_THREAD_ID}`);
  expect(launchChip).toHaveTextContent("the launch plan");
  expect(chatChip(PLAN_URL, replyBody)).toHaveAttribute(
    "href",
    `/chats/${PLAN_THREAD_ID}`,
  );
  const docs = externalLink(DOCS_URL, replyBody);
  expect(docs).toHaveAttribute("target", "_blank");
  expect(docs.getAttribute("rel")).toContain("noopener");
  expect(docs.getAttribute("rel")).toContain("noreferrer");
  expect(codeUrl.closest("a")).toBeNull();
  expect(queryAllByRoleFast("link", replyBody)).toHaveLength(3);
});
