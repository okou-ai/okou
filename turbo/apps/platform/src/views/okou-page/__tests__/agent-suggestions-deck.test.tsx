import {
  feedContract,
  type PlatformEvent,
  type Suggestion,
  type SuggestionFeedbackRequest,
} from "@okouai/api-contracts/contracts/feed";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const NOW = "2026-03-02T09:00:00.000Z";

type FeedItem = Suggestion | PlatformEvent;

interface FeedbackWrite extends SuggestionFeedbackRequest {
  readonly suggestionId: string;
}

function suggestion(title: string, order: number): Suggestion {
  const createdAt = new Date(Date.parse(NOW) - (10 - order) * 60_000);
  return {
    id: crypto.randomUUID(),
    type: "suggestion",
    priority: 0,
    createdAt: createdAt.toISOString(),
    updatedAt: createdAt.toISOString(),
    expiresAt: new Date(Date.parse(NOW) + 3_600_000).toISOString(),
    content: {
      title,
      rationale: `Why ${title} matters`,
      options: [
        {
          id: "start",
          label: `Start ${title}`,
          description: "",
          threadId: null,
          draft: {
            draftUserMessage: {
              version: 1,
              parts: [{ type: "text", text: `Please start ${title}` }],
            },
            draftAttachments: null,
          },
        },
      ],
      customOption: {
        id: "custom",
        threadId: null,
        draft: {
          draftUserMessage: {
            version: 1,
            parts: [
              { type: "feedback", quote: `${title} background`, note: [] },
            ],
          },
          draftAttachments: null,
        },
      },
    },
    state: { status: "active", selectedOptionId: null, feedbacks: [] },
  };
}

function automationPausedEvent(order: number): PlatformEvent {
  const createdAt = new Date(
    Date.parse(NOW) - (10 - order) * 60_000,
  ).toISOString();
  return {
    id: crypto.randomUUID(),
    type: "event",
    sourceType: "platform-event",
    priority: 0,
    createdAt,
    updatedAt: createdAt,
    expiresAt: null,
    content: {
      eventType: "automation-disabled",
      automationId: crypto.randomUUID(),
      workflowId: crypto.randomUUID(),
      workspaceId: "org_default",
      automationName: "Nightly invoice sync",
      disabledAt: createdAt,
      consecutiveFailures: 3,
      recoveryScheduled: false,
    },
    state: { status: "active" },
  };
}

/** The owner's feed with each feedback write the API received. */
function mockFeed(initial: readonly FeedItem[]) {
  const feed = {
    items: [...initial] as FeedItem[],
    listReads: 0,
    feedback: [] as FeedbackWrite[],
  };
  context.mocks.api(feedContract.list, ({ respond }) => {
    feed.listReads += 1;
    return respond(200, { items: [...feed.items] });
  });
  context.mocks.api(
    feedContract.feedback,
    ({ params, body: { snapshot: _snapshot, ...request }, respond }) => {
      feed.feedback.push({ suggestionId: params.id, ...request });
      return respond(200, { restored: request.kind === "undo" });
    },
  );
  return feed;
}

async function openForYou(path = "/for-you"): Promise<void> {
  await setupPage({
    context,
    path,
    featureSwitches: { [FeatureSwitchKey.AgentSuggestion]: true },
  });
}

function getAction(
  role: "button" | "link",
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const action = queryAllByRoleFast(role, container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.replace(/\s+/gu, " ").trim() === name
    );
  });
  if (!action) {
    throw new Error(`Expected ${role} named "${name}"`);
  }
  return action;
}

function forYouRow(): HTMLElement {
  const row = queryAllByRoleFast("link").find((candidate) => {
    return candidate.getAttribute("href") === "/for-you";
  });
  if (!row) {
    throw new Error("Expected the For you chat-list entry");
  }
  return row;
}

/** The foreground card is the only card exposed to assistive technology. */
async function activeCard(title: string): Promise<HTMLElement> {
  return await screen.findByRole("article", { name: title });
}

async function undoFrom(message: string): Promise<void> {
  const toast = (await screen.findByText(message)).closest("li");
  if (!toast) {
    throw new Error(`Expected a toast for "${message}"`);
  }
  const undo = getAction("button", "Undo", toast);
  click(undo);
  await waitFor(() => {
    expect(undo).not.toBeInTheDocument();
  });
}

test("For you preloads details when its sidebar shows an unread dot", async () => {
  mockNow(new Date(NOW), context.signal);
  const card = suggestion("Review the launch checklist", 1);
  context.mocks.api(feedContract.summary, ({ respond }) => {
    return respond(200, { hasUnread: true });
  });
  const preloaded = context.mocks.deferred<void>();
  const held = context.mocks.deferred<void>();
  let listReads = 0;
  context.mocks.api(feedContract.list, async ({ respond }) => {
    listReads += 1;
    if (listReads > 1) {
      await held.promise;
    } else {
      preloaded.resolve();
    }
    return respond(200, { items: [card] });
  });

  await openForYou("/");
  await waitFor(() => {
    expect(forYouRow()).toHaveTextContent("For you Unread");
  });
  await preloaded.promise;

  click(forYouRow());

  const opened = await activeCard("Review the launch checklist");
  expect(
    getAction("button", "Start Review the launch checklist", opened),
  ).toBeEnabled();
  expect(held.settled()).toBeFalsy();
  held.resolve();
});

test("For you opens the new owner's cards after an active workspace change", async () => {
  mockNow(new Date(NOW), context.signal);
  const cards = {
    org_first: suggestion("Close the first workspace's books", 1),
    org_second: suggestion("Plan the second workspace's launch", 2),
  };
  let workspace: keyof typeof cards = "org_first";
  context.mocks.api(feedContract.list, ({ respond }) => {
    return respond(200, { items: [cards[workspace]] });
  });
  await setupPage({
    context,
    path: "/for-you",
    featureSwitches: { [FeatureSwitchKey.AgentSuggestion]: true },
    auth: {
      user: { id: "user_workspaces", fullName: "Workspace Member" },
      organization: {
        activeOrg: { id: "org_first", name: "First workspace" },
        memberships: [{ id: "org_first" }, { id: "org_second" }],
      },
    },
  });
  await activeCard("Close the first workspace's books");
  click(getAction("link", "Agents"));
  await waitFor(() => {
    expect(window.location.pathname).toBe("/agents");
  });
  expect(
    screen.queryByText("Close the first workspace's books"),
  ).not.toBeInTheDocument();

  workspace = "org_second";
  const clerk = context.mocks.clerk();
  clerk.organization({
    activeOrg: { id: "org_second", name: "Second workspace" },
    memberships: [{ id: "org_first" }, { id: "org_second" }],
  });
  clerk.stateChanged();
  await waitFor(() => {
    expect(forYouRow()).toBeInTheDocument();
  });
  click(forYouRow());

  await activeCard("Plan the second workspace's launch");
  expect(
    screen.queryByText("Close the first workspace's books"),
  ).not.toBeInTheDocument();
});

test("Not planned advances to the next card and Undo restores the selected card", async () => {
  mockNow(new Date(NOW), context.signal);
  const [first, second, third] = [
    suggestion("Draft the hiring plan", 1),
    suggestion("Renew the office lease", 2),
    suggestion("Archive old invoices", 3),
  ];
  mockFeed([first, second, third]);
  await openForYou();
  await activeCard("Draft the hiring plan");
  // Paging controls belong to the whole stack, outside each card.
  click(getAction("link", "Next suggestion"));
  const selected = await activeCard("Renew the office lease");

  click(getAction("button", "Not planned", selected));

  await expect(activeCard("Archive old invoices")).resolves.toBeInTheDocument();
  await undoFrom("Noted — this is not planned");
  await expect(
    activeCard("Renew the office lease"),
  ).resolves.toBeInTheDocument();
});

test("Feedback on a card that left the pool refreshes the suggestions with a notice", async () => {
  mockNow(new Date(NOW), context.signal);
  const [first, second, third] = [
    suggestion("Reply to the auditor", 1),
    suggestion("Update the price sheet", 2),
    suggestion("Book the team offsite", 3),
  ];
  const offered = suggestion("Prepare the board memo", 4);
  const feed = mockFeed([first, second, third]);
  context.mocks.api(
    feedContract.feedback,
    ({ params, body: { snapshot: _snapshot, ...request }, respond }) => {
      feed.feedback.push({ suggestionId: params.id, ...request });
      return params.id === second.id
        ? respond(409, {
            error: { code: "CONFLICT", message: "Suggestion is not active" },
          })
        : respond(200, { restored: request.kind === "undo" });
    },
  );
  await openForYou();
  click(getAction("button", "Dismiss", await activeCard(first.content.title)));
  const secondCard = await activeCard("Update the price sheet");
  await screen.findByText("Suggestion dismissed");
  feed.items = [offered];

  click(getAction("button", "Already done", secondCard));

  await expect(
    screen.findByText(
      "That suggestion is no longer available. Suggestions have been refreshed.",
    ),
  ).resolves.toBeInTheDocument();
  await activeCard("Prepare the board memo");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("status", { name: "Loading suggestions" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText("Noted — this is already done"),
  ).not.toBeInTheDocument();

  await undoFrom("Suggestion dismissed");
  await activeCard("Reply to the auditor");
  const dismissal = feed.feedback.find((write) => {
    return write.suggestionId === first.id && write.kind === "dismissed";
  });
  await waitFor(() => {
    expect(feed.feedback.at(-1)).toMatchObject({
      suggestionId: first.id,
      kind: "undo",
      targetId: dismissal?.id,
    });
  });
});

test("Retrying feedback for a card that has since left the pool refreshes the suggestions", async () => {
  mockNow(new Date(NOW), context.signal);
  const [failed, next] = [
    suggestion("Send the renewal quote", 1),
    suggestion("Confirm the travel budget", 2),
  ];
  const feed = mockFeed([failed, next]);
  let left = false;
  context.mocks.api(
    feedContract.feedback,
    ({ params, body: { snapshot: _snapshot, ...request }, respond }) => {
      feed.feedback.push({ suggestionId: params.id, ...request });
      return left
        ? respond(409, {
            error: { code: "CONFLICT", message: "Suggestion is not active" },
          })
        : respond(500, {
            error: { code: "INTERNAL_SERVER_ERROR", message: "Save failed" },
          });
    },
  );
  await openForYou();
  click(
    getAction(
      "button",
      "Already done",
      await activeCard("Send the renewal quote"),
    ),
  );
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Send the renewal quote:");
  left = true;
  feed.items = [next];

  click(getAction("button", "Try again", alert));

  await expect(
    screen.findByText(
      "That suggestion is no longer available. Suggestions have been refreshed.",
    ),
  ).resolves.toBeInTheDocument();
  await activeCard("Confirm the travel budget");
  expect(alert).not.toBeInTheDocument();
  expect(
    screen.queryByText("Noted — this is already done"),
  ).not.toBeInTheDocument();
});

test("Slow feedback leaves other cards usable and Undo restores the original card in order", async () => {
  mockNow(new Date(NOW), context.signal);
  const [first, second, third] = [
    suggestion("Follow up with the supplier", 1),
    suggestion("Publish the release notes", 2),
    suggestion("Schedule the design review", 3),
  ];
  const feed = mockFeed([first, second, third]);
  const firstSaved = context.mocks.deferred<void>();
  context.mocks.api(
    feedContract.feedback,
    async ({ params, body: { snapshot: _snapshot, ...request }, respond }) => {
      feed.feedback.push({ suggestionId: params.id, ...request });
      if (params.id === first.id && request.kind === "not_planned") {
        await firstSaved.promise;
      }
      return respond(200, { restored: request.kind === "undo" });
    },
  );
  await openForYou();
  click(
    getAction(
      "button",
      "Not planned",
      await activeCard("Follow up with the supplier"),
    ),
  );
  const secondCard = await activeCard("Publish the release notes");

  click(getAction("button", "Already done", secondCard));

  await activeCard("Schedule the design review");
  await expect(
    screen.findByText("Noted — this is already done"),
  ).resolves.toBeInTheDocument();
  firstSaved.resolve();
  await undoFrom("Noted — this is not planned");
  await activeCard("Follow up with the supplier");
  const original = feed.feedback.find((write) => {
    return write.suggestionId === first.id && write.kind === "not_planned";
  });
  await waitFor(() => {
    expect(feed.feedback.at(-1)).toMatchObject({
      suggestionId: first.id,
      kind: "undo",
      targetId: original?.id,
    });
  });
});

test("An empty For you page stays accessible and reports zero suggestions", async () => {
  mockNow(new Date(NOW), context.signal);
  mockFeed([]);

  await openForYou();

  await expect(screen.findByText("All caught up")).resolves.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "For you" })).toBeInTheDocument();
  expect(screen.getByText("0 to go")).toHaveAttribute("role", "status");
  expect(window.location.pathname).toBe("/for-you");
});

test("For you handles a suggestion and a platform event in the same deck", async () => {
  mockNow(new Date(NOW), context.signal);
  const card = suggestion("Rotate the shared API key", 1);
  const event = automationPausedEvent(2);
  const feed = mockFeed([card, event]);
  const dismissed: string[] = [];
  context.mocks.api(feedContract.dismiss, ({ params, respond }) => {
    dismissed.push(params.id);
    feed.items = feed.items.filter((item) => {
      return item.id !== params.id;
    });
    return respond(204);
  });
  await openForYou();

  click(
    getAction(
      "button",
      "Dismiss",
      await activeCard("Rotate the shared API key"),
    ),
  );

  const eventCard = await activeCard("Automation paused");
  expect(within(eventCard).getByText("System update")).toBeInTheDocument();
  expect(getAction("link", "View automation", eventCard)).toHaveTextContent(
    "Nightly invoice sync",
  );

  click(getAction("button", "Dismiss", eventCard));

  await expect(screen.findByText("All caught up")).resolves.toBeInTheDocument();
  expect(dismissed).toStrictEqual([event.id]);
  expect(feed.feedback).toMatchObject([
    { suggestionId: card.id, kind: "dismissed" },
  ]);
});

test("Don't nudge records the no-repeat direction and Undo targets that feedback", async () => {
  mockNow(new Date(NOW), context.signal);
  const card = suggestion("Chase the overdue invoice", 1);
  const feed = mockFeed([card, suggestion("Refresh the sales deck", 2)]);
  await openForYou();

  click(
    getAction(
      "button",
      "Don’t nudge me",
      await activeCard("Chase the overdue invoice"),
    ),
  );

  await activeCard("Refresh the sales deck");
  await undoFrom("Noted — please don’t nudge me about this again");
  await activeCard("Chase the overdue invoice");
  const [recorded] = feed.feedback;
  expect(recorded).toMatchObject({
    suggestionId: card.id,
    kind: "not_planned",
    targetId: null,
    note: "Do not nudge me about this again.",
  });
  await waitFor(() => {
    expect(feed.feedback).toHaveLength(2);
  });
  expect(feed.feedback[1]).toMatchObject({
    suggestionId: card.id,
    kind: "undo",
    targetId: recorded?.id,
  });
});
