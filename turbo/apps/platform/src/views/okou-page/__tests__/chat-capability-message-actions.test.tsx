import { logsByIdContract } from "@okouai/api-contracts/contracts/logs";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  parseChatClipboardPayload,
  readClipboardItemText,
  readSingleRichClipboardWrite,
} from "./chat-lifecycle-test-helpers.ts";
import { mockPrivateUrlSequence } from "./chat-attachment-test-helpers.ts";
import {
  CAPABILITY_AGENT_ID,
  completedConversation,
  context,
  FIRST_CAPABILITY_RUN_ID,
  installCapabilityChat,
  readyChat,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";
import { installRunChat, promptEvent } from "./chat-run-test-fixtures.ts";

const RESPONSE_TEXT = "The completed response contains reusable guidance.";
const STRUCTURED_FILE_ID = "structured-reference-file";
const STRUCTURED_FILE_URL =
  "https://cdn.vm7.io/chat-capability/structured-reference.pdf";
const REFERENCED_THREAD_ID = "b0000000-0000-4000-a000-000000000819";

function buttonIn(container: ParentNode, name: string): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.replace(/\s+/gu, " ").trim() === name
    );
  });
  if (!button) {
    throw new Error(`Button ${name} was not available`);
  }
  return button;
}

function findLink(
  container: ParentNode,
  name: string,
): HTMLElement | undefined {
  return queryAllByRoleFast("link", container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.replace(/\s+/gu, " ").trim() === name
    );
  });
}

function linkIn(container: ParentNode, name: string): HTMLElement {
  const link = findLink(container, name);
  if (!link) {
    throw new Error(`Link ${name} was not available`);
  }
  return link;
}

test("Hide the activity-log action outside debug mode", async () => {
  installCapabilityChat({
    events: completedConversation(RESPONSE_TEXT),
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  const response = await screen.findByText(RESPONSE_TEXT);
  const responseGroup = response.closest<HTMLElement>(
    '[data-role="assistant"]',
  );
  if (!responseGroup) {
    throw new Error("Assistant response group was not available");
  }

  expect(findLink(responseGroup, "View run logs")).toBeUndefined();
  expect(screen.queryByLabelText("View run logs")).not.toBeInTheDocument();
});

test("Open an active run's logs beside Copy before any assistant output", async () => {
  const prompt = "Check the connection";
  installRunChat({
    activeRunIds: [FIRST_CAPABILITY_RUN_ID],
    chatEvents: [
      promptEvent({
        id: "no-output-user-message",
        runId: FIRST_CAPABILITY_RUN_ID,
        seqId: 1,
        text: prompt,
      }),
    ],
  });
  context.mocks.api(logsByIdContract.getById, ({ params, respond }) => {
    return respond(200, {
      id: params.id,
      sessionId: "capability-session",
      agentId: CAPABILITY_AGENT_ID,
      displayName: "Run inspection",
      framework: "claude-code",
      modelProvider: "anthropic-api-key",
      selectedModel: "claude-sonnet-4-6",
      triggerSource: "web",
      status: "running",
      prompt,
      appendSystemPrompt: null,
      error: null,
      createdAt: "2026-08-01T10:00:00.000Z",
      startedAt: "2026-08-01T10:00:01.000Z",
      completedAt: null,
      artifact: { name: null, version: null },
    });
  });

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });
  await readyChat();

  const actions = screen
    .getByText(prompt)
    .closest('[data-role="user"]')
    ?.querySelector("[data-chat-user-message-actions]");
  if (!actions) {
    throw new Error("User message action row was not available");
  }
  const copy = buttonIn(actions, "Copy message");
  const logs = linkIn(actions, "View run logs");
  expect(
    copy.compareDocumentPosition(logs) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(logs).toHaveAttribute(
    "href",
    `/activities/${FIRST_CAPABILITY_RUN_ID}`,
  );
  expect(logs.querySelector("svg")).toBeInTheDocument();

  click(logs);
  await expect(
    screen.findByRole("heading", { name: "Run inspection" }),
  ).resolves.toBeVisible();
  expect(window.location.pathname).toBe(
    `/activities/${FIRST_CAPABILITY_RUN_ID}`,
  );
});

test("Do not show user run logs before a run ID is assigned", async () => {
  installCapabilityChat({
    events: [
      promptEvent({
        id: "pending-user-message",
        seqId: 1,
        text: "Wait for run creation",
      }),
    ],
  });

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });
  await readyChat();

  const actions = screen
    .getByText("Wait for run creation")
    .closest('[data-role="user"]')
    ?.querySelector("[data-chat-user-message-actions]");
  if (!actions) {
    throw new Error("User message action row was not available");
  }
  expect(findLink(actions, "View run logs")).toBeUndefined();
});

test("Keep run logs under the user message when a run fails without output", async () => {
  const prompt = "Check the connection";
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "failed-no-output-user-message",
        runId: FIRST_CAPABILITY_RUN_ID,
        seqId: 1,
        text: prompt,
      }),
      {
        id: "failed-no-output-terminal",
        eventType: "run.failed",
        content: null,
        error: "Connection failed",
        runId: FIRST_CAPABILITY_RUN_ID,
        seqId: 2,
        createdAt: "2026-08-01T10:00:02.000Z",
      },
    ],
  });

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });
  await readyChat();

  const actions = screen
    .getByText(prompt)
    .closest('[data-role="user"]')
    ?.querySelector("[data-chat-user-message-actions]");
  if (!actions) {
    throw new Error("User message action row was not available");
  }
  expect(linkIn(actions, "View run logs")).toHaveAttribute(
    "href",
    `/activities/${FIRST_CAPABILITY_RUN_ID}`,
  );
  expect(screen.getByText("Connection failed")).toBeInTheDocument();
  expect(screen.queryByTestId("chat-event-actions")).toBeNull();
});

test("Inspect a response from its prompt or copy it from history", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  installCapabilityChat({
    events: completedConversation(RESPONSE_TEXT),
    threadTitle: "Capability conversation",
  });
  context.mocks.api(logsByIdContract.getById, ({ params, respond }) => {
    return respond(200, {
      id: params.id,
      sessionId: "capability-session",
      agentId: CAPABILITY_AGENT_ID,
      displayName: "Response inspection",
      framework: "claude-code",
      modelProvider: "anthropic-api-key",
      selectedModel: "claude-sonnet-4-6",
      triggerSource: "web",
      status: "completed",
      prompt: "Prepare the response",
      appendSystemPrompt: null,
      error: null,
      createdAt: "2026-08-01T10:00:00.000Z",
      startedAt: "2026-08-01T10:00:01.000Z",
      completedAt: "2026-08-01T10:00:02.000Z",
      artifact: { name: null, version: null },
    });
  });

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });

  await readyChat();
  const response = await screen.findByText(RESPONSE_TEXT);
  const responseGroup = response.closest<HTMLElement>(
    '[data-role="assistant"]',
  );
  if (!responseGroup) {
    throw new Error("Assistant response group was not available");
  }

  expect(findLink(responseGroup, "View run logs")).toBeUndefined();
  const promptActions = screen
    .getByText("Prepare the first response")
    .closest('[data-role="user"]')
    ?.querySelector("[data-chat-user-message-actions]");
  if (!promptActions) {
    throw new Error("User message action row was not available");
  }
  click(linkIn(promptActions, "View run logs"));

  const inspectionHeading = await screen.findByRole("heading", {
    name: "Response inspection",
  });
  expect(inspectionHeading).toBeVisible();
  expect(window.location.pathname).toBe(
    `/activities/${FIRST_CAPABILITY_RUN_ID}`,
  );

  const sourceThreadLink = await waitFor(() => {
    return linkIn(document.body, "Capability conversation");
  });
  click(sourceThreadLink);

  await readyChat();
  const restoredResponse = await screen.findByText(RESPONSE_TEXT);
  const restoredGroup = restoredResponse.closest<HTMLElement>(
    '[data-role="assistant"]',
  );
  if (!restoredGroup) {
    throw new Error("Restored assistant response group was not available");
  }
  click(buttonIn(restoredGroup, "Copy message"));

  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([RESPONSE_TEXT]);
  });
});

test("Copy and paste a structured chat message from the keyboard without flattening it", async () => {
  const user = userEvent.setup({ delay: null });
  const clipboard = context.mocks.browser.clipboardWrite();
  mockPrivateUrlSequence(context, {
    [STRUCTURED_FILE_ID]: [STRUCTURED_FILE_URL],
  });
  installCapabilityChat({
    events: [
      {
        id: "structured-user-message",
        role: "user",
        runId: FIRST_CAPABILITY_RUN_ID,
        seqId: 1,
        content: "Legacy flattened content",
        createdAt: "2026-08-01T10:00:00.000Z",
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: "Reuse the current project briefing." },
            {
              type: "file",
              fileId: STRUCTURED_FILE_ID,
              filenameSnapshot: "structured-reference.pdf",
              contentType: "application/pdf",
            },
            {
              type: "template",
              titleSnapshot: "Paper cut",
              template: {
                type: "illustration",
                selection: { illustrationStyleId: "paper-cut" },
              },
            },
            {
              type: "chat_thread",
              threadId: REFERENCED_THREAD_ID,
              titleSnapshot: "Referenced planning chat",
            },
            {
              type: "feedback",
              quote: "The original recommendation",
              note: [{ type: "text", text: "Adapt this for the new launch." }],
            },
            { type: "model", selectedModel: "claude-sonnet-4-6" },
          ],
        },
      },
      {
        id: "structured-assistant-message",
        role: "assistant",
        runId: FIRST_CAPABILITY_RUN_ID,
        seqId: 2,
        content: "The structured message is ready to reuse.",
        createdAt: "2026-08-01T10:00:01.000Z",
      },
    ],
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  const currentText = await screen.findByText(
    "Reuse the current project briefing.",
  );
  const attachment = await screen.findByText("structured-reference.pdf");
  expect(attachment).toBeVisible();
  const userGroup = currentText.closest<HTMLElement>('[data-role="user"]');
  if (!userGroup) {
    throw new Error("Structured user message group was not available");
  }

  const copy = buttonIn(userGroup, "Copy message");
  copy.focus();
  expect(copy).toHaveFocus();
  expect(copy).toHaveAccessibleName("Copy message");
  await user.keyboard("{Enter}");

  const item = await readSingleRichClipboardWrite(clipboard);
  const plainText = await readClipboardItemText(item, "text/plain");
  const html = await readClipboardItemText(item, "text/html");
  const copied = parseChatClipboardPayload(html);
  expect(plainText).toContain("Reuse the current project briefing.");
  expect(plainText).not.toContain("Legacy flattened content");
  expect(copied.text).toContain("Reuse the current project briefing.");
  expect(copied.attachments).toHaveLength(1);
  const copiedAttachment = copied.attachments[0];
  if (!copiedAttachment) {
    throw new Error("Copied attachment was not available");
  }
  expect(copiedAttachment).toMatchObject({
    id: STRUCTURED_FILE_ID,
    filename: "structured-reference.pdf",
  });
  expect(new URL(copiedAttachment.url)).toMatchObject({
    pathname: "/api/web/download-file",
    search: `?file_id=${STRUCTURED_FILE_ID}`,
  });

  const composer = screen.getByRole("textbox", { name: "Message" });
  fireEvent.paste(composer, {
    clipboardData: {
      getData(type: string) {
        if (type === "text/html") {
          return html;
        }
        return type === "text/plain" ? plainText : "";
      },
      items: [],
      types: ["text/plain", "text/html"],
    },
  });

  await waitFor(() => {
    expect(composer).toHaveTextContent("Reuse the current project briefing.");
  });
  const feedback = await screen.findByRole("textbox", {
    name: "Ask or comment on this quote",
  });
  expect(feedback).toHaveTextContent("Adapt this for the new launch.");
  expect(buttonIn(document.body, "Preview template Paper cut")).toBeVisible();
});
