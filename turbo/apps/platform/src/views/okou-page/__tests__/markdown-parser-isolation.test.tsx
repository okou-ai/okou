import {
  agentInstructionsContract,
  agentsByIdContract,
} from "@okouai/api-contracts/contracts/agents";
import { logsByIdContract } from "@okouai/api-contracts/contracts/logs";
import { runAgentEventsContract } from "@okouai/api-contracts/contracts/run-routes";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createMarkdownChatFixture } from "./markdown-page-test-helpers.ts";

const context = testContext();
const AGENT_ID = "c0000000-0000-4000-a000-000000000071";
const RUN_ID = "a0000000-0000-4000-a000-000000000071";

function getLink(name: string): HTMLElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return (
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name
    );
  });
  if (!link) {
    throw new Error(`Expected link named "${name}"`);
  }
  return link;
}

function markdownFrameFor(element: Element): HTMLElement {
  const frame = element.closest<HTMLElement>(".wmde-markdown");
  if (!frame) {
    throw new Error("Expected content inside a Markdown frame");
  }
  return frame;
}

async function openInstructionsThenChat(): Promise<void> {
  context.mocks.api(agentsByIdContract.get, ({ respond }) => {
    return respond(200, {
      isDefaultAgent: false,
      agentId: AGENT_ID,
      avatarUrl: null,
      description: null,
      displayName: "Markdown Agent",
      modelProviderId: null,
      ownerId: "test-user-123",
      preferPersonalProvider: false,
      selectedModel: null,
      sound: null,
      visibility: "private",
    });
  });
  context.mocks.api(agentInstructionsContract.get, ({ respond }) => {
    return respond(200, {
      content: "++Editor underline++",
      filename: "AGENTS.md",
    });
  });

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}?tab=instructions`,
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });

  const editor = await screen.findByLabelText("Instructions editor");
  expect(editor.querySelector("u")).toHaveTextContent("Editor underline");
  const chatLink = await waitFor(() => {
    return getLink("Rich content");
  });
  click(chatLink);

  await screen.findByRole("textbox", { name: "Message" });
}

async function prepareLiteralPlusMarkdownChat() {
  const chat = createMarkdownChatFixture(context);
  const rows = [chat.outputMessage("++Plain message++", { seqId: 1 })];
  chat.install({
    rows: () => {
      return rows;
    },
  });
  await openInstructionsThenChat();
  return { chat, rows };
}

test("Opening Instructions preserves literal plus signs in the initial message", async () => {
  await prepareLiteralPlusMarkdownChat();
  await expect(screen.findByText("++Plain message++")).resolves.toBeVisible();
});

test("Opening Instructions preserves literal plus signs through streamed revisions", async () => {
  const { chat, rows } = await prepareLiteralPlusMarkdownChat();
  rows.push(
    chat.outputMessage("**Streaming:** ++Reply", {
      id: "streamed-markdown",
      runEventId: "streamed-markdown",
      seqId: 2,
    }),
  );
  context.mocks.ably.trigger(chat.realtimeTopic);
  const streaming = await screen.findByText("Streaming:");
  expect(streaming.tagName).toBe("STRONG");
  expect(markdownFrameFor(streaming)).toHaveTextContent("++Reply");
  rows[1] = chat.outputMessage("**Streaming:** ++Reply+", {
    id: "streamed-markdown",
    runEventId: "streamed-markdown",
    seqId: 3,
    sequenceNumber: 2,
  });
  context.mocks.ably.trigger(chat.realtimeTopic);
  await waitFor(() => {
    expect(markdownFrameFor(screen.getByText("Streaming:"))).toHaveTextContent(
      "++Reply+",
    );
  });
  rows[1] = chat.outputMessage(
    [
      "**Streaming:** ++Reply++",
      "",
      "`++Code++` and C++ / i++",
      "",
      "++[Reference](https://example.com/a++b)++",
      "",
      "3. Third item",
      "4. Fourth item",
      "",
      "- [x] Checked task",
    ].join("\n"),
    {
      id: "streamed-markdown",
      runEventId: "streamed-markdown",
      seqId: 4,
      sequenceNumber: 2,
    },
  );
  rows.push(chat.runCompleted({ seqId: 5, sequenceNumber: 3 }));
  context.mocks.ably.trigger(chat.realtimeTopic);
  await screen.findByText("Checked task");
  const frame = markdownFrameFor(screen.getByText("Streaming:"));
  expect(frame).toHaveTextContent("++Reply++");
  expect(frame).toHaveTextContent("C++ / i++");
  expect(frame).toHaveTextContent("++Reference++");
  expect(frame.querySelector("code")).toHaveTextContent("++Code++");
  expect(frame.querySelector("u")).toBeNull();
  expect(getLink("Reference")).toHaveAttribute(
    "href",
    "https://example.com/a++b",
  );
  expect(frame.querySelector("ol")).toHaveAttribute("start", "3");
  expect(frame.querySelector('input[type="checkbox"]')).toBeChecked();
  expect(screen.queryByText("Try again")).not.toBeInTheDocument();
});

test("Opening Instructions keeps rich Activity logs readable", async () => {
  const chat = createMarkdownChatFixture(context);
  const rows = [
    chat.outputMessage("Inspect the completed response", {
      seqId: 1,
      runId: RUN_ID,
    }),
    chat.runCompleted({ seqId: 2, runId: RUN_ID }),
  ];
  chat.install({
    rows: () => {
      return rows;
    },
  });
  context.mocks.api(logsByIdContract.getById, ({ respond }) => {
    return respond(200, {
      id: RUN_ID,
      sessionId: "markdown-isolation-session",
      agentId: AGENT_ID,
      displayName: "Markdown activity",
      framework: "claude-code",
      modelProvider: null,
      selectedModel: null,
      triggerSource: "web",
      status: "completed",
      prompt: "Inspect the response",
      appendSystemPrompt: null,
      error: null,
      createdAt: "2026-09-04T09:29:00Z",
      startedAt: "2026-09-04T09:29:01Z",
      completedAt: "2026-09-04T09:29:02Z",
      artifact: { name: null, version: null },
    });
  });
  context.mocks.api(runAgentEventsContract.getAgentEvents, ({ respond }) => {
    return respond(200, {
      events: [
        {
          sequenceNumber: 0,
          eventType: "assistant",
          eventData: {
            message: {
              content: [
                {
                  type: "text",
                  text: "**Activity:** ++Literal text++ and <u>HTML underline</u>",
                },
              ],
            },
          },
          createdAt: "2026-09-04T09:29:02Z",
        },
      ],
      hasMore: false,
      status: "completed",
      lastEventSequence: 0,
    });
  });

  await openInstructionsThenChat();

  await screen.findByText("Inspect the completed response");
  click(getLink("View run logs"));

  const activity = await screen.findByText("Activity:");
  expect(activity.tagName).toBe("STRONG");
  const frame = markdownFrameFor(activity);
  expect(frame).toHaveTextContent("++Literal text++");
  expect(frame.querySelector("u")).toHaveTextContent("HTML underline");
  expect(window.location.pathname).toBe(`/activities/${RUN_ID}`);
  expect(screen.queryByText("Try again")).not.toBeInTheDocument();
});
