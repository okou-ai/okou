import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
  chatThreadsContract,
  chatThreadEventsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { avatarComposerUrl } from "@okouai/core/agent-avatar";
import { expect, test } from "vitest";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ARCHIVED_AGENT_ID,
  RESEARCH_AGENT_ID,
  agentFixture,
  setupTeamPage,
} from "./team-page-test-helpers.ts";

const context = testContext();
const FIRST_THREAD_ID = "40000000-0000-4000-8000-000000000001";
const SECOND_THREAD_ID = "40000000-0000-4000-8000-000000000002";
const FIRST_EVENT_ID = "50000000-0000-4000-8000-000000000001";

function renderedAvatarSvgLayerSrcs(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll<HTMLImageElement>("img"), (img) => {
    return img.src;
  }).filter((src) => {
    return src.includes("/platform/views/zero-page/assets/avatar-svg");
  });
}

function labelledButton(name: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.getAttribute("aria-label") === name;
  });
  if (!button) {
    throw new Error(`Labelled button not found: ${name}`);
  }
  return button;
}

test("The agent chat shortcut opens the first available thread", async () => {
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      chatThreads: [
        {
          id: FIRST_THREAD_ID,
          agentId: RESEARCH_AGENT_ID,
          title: "First shortcut thread",
          sortAt: "2026-08-18T12:00:00.000Z",
          createdAt: "2026-08-18T10:00:00.000Z",
          updatedAt: "2026-08-18T12:00:00.000Z",
          pinnedAt: null,
          renamedAt: null,
          selectedModel: null,
          serviceTier: null,
          computerUseHostId: null,
          cloudBrowserEnabled: false,
          selectedVideoModel: null,
          selectedImageModel: null,
        },
        {
          id: SECOND_THREAD_ID,
          agentId: RESEARCH_AGENT_ID,
          title: "Second shortcut thread",
          sortAt: "2026-08-18T11:00:00.000Z",
          createdAt: "2026-08-18T09:00:00.000Z",
          updatedAt: "2026-08-18T11:00:00.000Z",
          pinnedAt: null,
          renamedAt: null,
          selectedModel: null,
          serviceTier: null,
          computerUseHostId: null,
          cloudBrowserEnabled: false,
          selectedVideoModel: null,
          selectedImageModel: null,
        },
      ],
      latestEventId: null,
      latestSeqId: null,
    });
  });
  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
  context.mocks.api(chatThreadEventsContract.rows, ({ params, respond }) => {
    if (params.threadId !== FIRST_THREAD_ID) {
      return respond(200, {
        rows: [],
        cursor: { lastEventId: null, lastSeqId: 0 },
        hasMore: false,
      });
    }
    return respond(200, {
      rows: [
        {
          id: FIRST_EVENT_ID,
          chatThreadId: FIRST_THREAD_ID,
          runId: null,
          revokesEventId: null,
          contextType: null,
          contextId: null,
          runEventSequenceNumber: null,
          runEventId: null,
          seqId: 1,
          createdAt: "2026-08-18T12:00:00.000Z",
          eventType: "input.prompt",
          payload: {
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: "First shortcut thread message." }],
            },
          },
        },
      ],
      cursor: { lastEventId: FIRST_EVENT_ID, lastSeqId: 1 },
      hasMore: false,
    });
  });
  context.mocks.data.userPreferences({ locale: "en-US" });
  await setupTeamPage({
    context,
    path: `/agents/${RESEARCH_AGENT_ID}/chat`,
  });

  const composerGuidance = await screen.findByText(
    "Ask me to automate workflows, manage tasks...",
  );
  expect(composerGuidance).toBeVisible();
  const firstThreads = await screen.findAllByText("First shortcut thread");
  expect(
    firstThreads.some((thread) => {
      return thread.checkVisibility();
    }),
  ).toBeTruthy();
  fireEvent.keyDown(document, {
    key: "ArrowDown",
    code: "ArrowDown",
    ctrlKey: true,
    shiftKey: true,
  });

  const thread = await screen.findByRole("region", { name: "Chat thread" });
  const message = await within(thread).findByText(
    "First shortcut thread message.",
  );
  expect(message).toBeVisible();
  expect(window.location.pathname).toBe(`/chats/${FIRST_THREAD_ID}`);
});

test("Agent details that fail to load offer a direct retry", async () => {
  await setupTeamPage({
    context,
    path: `/agents/${ARCHIVED_AGENT_ID}`,
    agents: [agentFixture(ARCHIVED_AGENT_ID, "Archived Agent")],
    detailErrorByAgentId: {
      [ARCHIVED_AGENT_ID]: "Agent details are unavailable.",
    },
  });

  const failure = await screen.findByText("Agent details are unavailable.");
  expect(failure).toBeVisible();
  const retry = queryAllByRoleFast("link").find((candidate) => {
    return candidate.textContent?.trim() === "Retry";
  });
  expect(retry).toBeDefined();
  expect(retry).toHaveAttribute("href", `/agents/${ARCHIVED_AGENT_ID}`);
});

test("A user opens avatar customization from an agent", async () => {
  await setupTeamPage({
    context,
    path: `/agents/${RESEARCH_AGENT_ID}`,
  });

  const agentHeading = await screen.findByRole("heading", {
    name: "Research Agent",
  });
  expect(agentHeading).toBeVisible();
  const customize = labelledButton("Customize avatar");
  expect(customize).toBeVisible();
  click(customize);

  const dialog = await screen.findByRole("dialog", {
    name: "Give your agent a face",
  });
  expect(dialog).toBeVisible();
  expect(within(dialog).getByText("Face")).toBeVisible();
});

test("The agent header opens avatar customization on the current avatar", async () => {
  await setupTeamPage({
    context,
    path: `/agents/${RESEARCH_AGENT_ID}`,
    agents: [
      agentFixture(RESEARCH_AGENT_ID, "Research Agent", {
        avatarUrl: avatarComposerUrl({
          face: "oval",
          hair: "rounded-crop",
          expression: "neutral-smile",
          skin: "deep",
          hairColor: "green",
          sweater: "lime",
        }),
      }),
    ],
  });

  await screen.findByRole("heading", { name: "Research Agent" });
  click(labelledButton("Customize avatar"));

  const dialog = await screen.findByRole("dialog", { name: "Edit avatar" });
  expect(renderedAvatarSvgLayerSrcs(dialog).slice(0, 6)).toStrictEqual([
    expect.stringContaining("/neck/deep.svg"),
    expect.stringContaining("/hairs/oval/rounded-crop-green-rear.svg"),
    expect.stringContaining("/faces/oval-deep.svg"),
    expect.stringContaining("/hairs/oval/rounded-crop-green-front.svg"),
    expect.stringContaining("/expressions/neutral-smile-oval.svg"),
    expect.stringContaining("/sweater/lime.svg"),
  ]);
});

test("A member cannot customize another user's public agent avatar", async () => {
  context.mocks.data.org({
    id: "org_default",
    name: "Default Org",
    role: "member",
  });
  await setupTeamPage({
    context,
    path: `/agents/${RESEARCH_AGENT_ID}?tab=profile`,
    agents: [
      agentFixture(RESEARCH_AGENT_ID, "Research Agent", {
        ownerId: "agent-owner",
      }),
    ],
  });

  await screen.findByRole("heading", { name: "Research Agent" });
  expect(screen.queryByLabelText("Customize avatar")).not.toBeInTheDocument();
  expect(
    screen.queryByLabelText("Create custom avatar"),
  ).not.toBeInTheDocument();
});

test("An org admin cannot customize another user's private agent avatar", async () => {
  context.mocks.data.org({
    id: "org_default",
    name: "Default Org",
    role: "admin",
  });
  await setupTeamPage({
    context,
    path: `/agents/${RESEARCH_AGENT_ID}?tab=profile`,
    agents: [
      agentFixture(RESEARCH_AGENT_ID, "Private Agent", {
        ownerId: "agent-owner",
        visibility: "private",
      }),
    ],
  });

  await screen.findByRole("heading", { name: "Private Agent" });
  expect(screen.queryByLabelText("Customize avatar")).not.toBeInTheDocument();
  expect(
    screen.queryByLabelText("Create custom avatar"),
  ).not.toBeInTheDocument();
});

test("A user starts a chat from an agent's detail page", async () => {
  await setupTeamPage({
    context,
    path: `/agents/${RESEARCH_AGENT_ID}`,
  });

  await screen.findByRole("heading", { name: "Research Agent" });
  click(labelledButton("Chat with Research Agent"));

  await waitFor(() => {
    expect(window.location.pathname).toBe(`/agents/${RESEARCH_AGENT_ID}/chat`);
    expect(
      screen.getByText("Ask me to automate workflows, manage tasks..."),
    ).toBeVisible();
  });
});
