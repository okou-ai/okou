import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  feedContract,
  type Suggestion,
} from "@okouai/api-contracts/contracts/feed";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";
import { nowDate } from "../../../lib/time.ts";
import {
  continuitySidebarLink,
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";

const context = testContext();

function suggestion(): Suggestion {
  const timestamp = nowDate().toISOString();
  return {
    id: "a0000000-0000-4000-a000-000000000901",
    priority: 20,
    createdAt: timestamp,
    updatedAt: timestamp,
    content: {
      title: "Review the pending decision",
      rationale: "A response is needed",
      customOption: {
        id: "custom",
        threadId: null,
        draft: {
          draftUserMessage: {
            version: 1,
            parts: [
              {
                type: "feedback",
                quote: "The decision is waiting for a response.",
                note: [],
              },
            ],
          },
          draftAttachments: null,
        },
      },
      options: [
        {
          id: "review",
          label: "Review decision",
          description: "Review the context and prepare the next step",
          threadId: null,
          draft: {
            draftUserMessage: {
              version: 1,
              parts: [{ type: "text", text: "Review the pending decision" }],
            },
            draftAttachments: null,
          },
        },
      ],
    },
    state: { feedbacks: [], status: "active", selectedOptionId: null },
    type: "suggestion",
    expiresAt: new Date(Date.parse(timestamp) + 86_400_000).toISOString(),
  };
}

function mockSuggestionPool(items: readonly Suggestion[]): void {
  context.mocks.api(feedContract.list, ({ respond }) => {
    return respond(200, { items: [...items] });
  });
}

async function setupEntryNavigation(
  caseId: number,
  options: { readonly suggestions: boolean; readonly sidePane?: boolean },
) {
  const older = continuityThread(caseId, 1, "Older chat");
  const middle = continuityThread(caseId, 2, "Middle chat");
  const newest = continuityThread(caseId, 3, "Newest chat");
  const workspace = installContinuityWorkspace(context, {
    caseId,
    threads: [older, middle, newest],
  });
  // My Okou's chat page at `/` chats with the default agent.
  context.mocks.data.onboardingStatus({ defaultAgentId: newest.agentId });
  mockSuggestionPool([suggestion()]);
  await setupPage({
    context,
    path: options.sidePane
      ? `/chats/${older.id}?sidebar=${newest.id}`
      : `/chats/${newest.id}`,
    ...workspace.pageOptions,
    featureSwitches: {
      [FeatureSwitchKey.SingleAgent]: true,
      [FeatureSwitchKey.AgentSuggestion]: options.suggestions,
    },
  });
  return { older, middle, newest };
}

function pressChatNavigation(direction: "ArrowUp" | "ArrowDown") {
  return userEvent
    .setup({ delay: null })
    .keyboard(`{Control>}{Shift>}{${direction}}{/Shift}{/Control}`);
}

function entryLink(href: "/" | "/for-you"): HTMLElement {
  const found = queryAllByRoleFast(
    "link",
    screen.getByTestId("chat-list-column"),
  ).find((element) => {
    return element.getAttribute("href") === href;
  });
  if (!found) {
    throw new Error(`Missing chat list entry: ${href}`);
  }
  return found;
}

function threadContainer(threadId: string): HTMLElement {
  const container = document.querySelector<HTMLElement>(
    `[data-chat-thread-container-id="${threadId}"]`,
  );
  if (!container) {
    throw new Error(`Expected chat pane ${threadId}`);
  }
  return container;
}

test("Chat navigation passes For you and New chat above the list without consuming a card", async () => {
  const { newest } = await setupEntryNavigation(301, {
    suggestions: true,
  });
  await waitFor(() => {
    expect(continuitySidebarLink(newest.id)).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
  (await screen.findByRole("textbox", { name: "Message" })).focus();

  // The first chat continues upward into the entries in their sidebar order.
  await pressChatNavigation("ArrowUp");
  await waitFor(() => {
    expect(pathname()).toBe("/for-you");
    expect(entryLink("/for-you")).toHaveAttribute("aria-current", "page");
  });
  await pressChatNavigation("ArrowUp");
  await waitFor(() => {
    expect(pathname()).toBe("/");
    expect(entryLink("/")).toHaveAttribute("aria-current", "page");
  });
  await screen.findByRole("textbox", { name: "Message" });

  // New chat is the first stop. Had the order wrapped to the last chat, one
  // step down could not reach For you.
  await pressChatNavigation("ArrowUp");
  await pressChatNavigation("ArrowDown");
  await waitFor(() => {
    expect(pathname()).toBe("/for-you");
  });
  await pressChatNavigation("ArrowDown");
  await waitFor(() => {
    expect(pathname()).toBe(`/chats/${newest.id}`);
    expect(continuitySidebarLink(newest.id)).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
  // Passing the For you page leaves its card available on the next visit.
  await pressChatNavigation("ArrowUp");
  await screen.findByRole("article", { name: "Review the pending decision" });
});

test("Without For you, the first chat moves up to New chat and New chat moves down into the list", async () => {
  const { newest } = await setupEntryNavigation(302, { suggestions: false });
  await waitFor(() => {
    expect(continuitySidebarLink(newest.id)).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
  await pressChatNavigation("ArrowUp");
  await waitFor(() => {
    expect(pathname()).toBe("/");
    expect(entryLink("/")).toHaveAttribute("aria-current", "page");
  });
  (await screen.findByRole("textbox", { name: "Message" })).focus();

  await pressChatNavigation("ArrowDown");
  await waitFor(() => {
    expect(pathname()).toBe(`/chats/${newest.id}`);
  });
});

test("The side pane moves only between chats and never onto the entries", async () => {
  const { older, middle, newest } = await setupEntryNavigation(303, {
    suggestions: true,
    sidePane: true,
  });
  const sideComposer = await waitFor(() => {
    const composer = threadContainer(newest.id).querySelector<HTMLElement>(
      '[role="textbox"][aria-label="Message"]',
    );
    if (!composer) {
      throw new Error("Expected the side pane composer");
    }
    return composer;
  });
  sideComposer.focus();

  // Only the entries stand above the side pane's chat.
  await pressChatNavigation("ArrowUp");
  await pressChatNavigation("ArrowDown");
  await waitFor(() => {
    expect(threadContainer(middle.id)).toBeInTheDocument();
  });
  expect(pathname()).toBe(`/chats/${older.id}`);
});
