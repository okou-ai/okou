import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  userNotificationsContract,
  type UserNotification,
  type UserNotificationSummary,
} from "@okouai/api-contracts/contracts/user-notifications";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const path = "/agents/c0000000-0000-4000-a000-000000000001/chat";
const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";
const at = "2026-11-06T03:00:00.000Z";
const readAt = "2026-11-06T04:00:00.000Z";
const first = Object.freeze<UserNotificationSummary>({
  id: FIRST_ID,
  type: "rich_text",
  title: "Organize your work",
  summary: "Keep your work together.",
  createdAt: at,
  readAt: null,
});
const second = Object.freeze<UserNotificationSummary>({
  id: SECOND_ID,
  type: "rich_text",
  title: "A note from the team",
  summary: "A little inspiration.",
  createdAt: "2026-11-05T03:00:00.000Z",
  readAt: null,
});
const detail = Object.freeze<UserNotification>({
  id: "11111111-1111-4111-8111-111111111111",
  title: "Organize your work",
  summary: "Keep your work together.",
  createdAt: "2026-11-06T03:00:00.000Z",
  readAt: null,
  payload: {
    type: "rich_text",
    markdown:
      "## Everything in context\n\nBring your work together.\n\n![Projects overview](https://static.okou.io/notification-preview.png)\n\n<script>alert('unsafe')</script>",
  },
});
function button(
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const result = queryAllByRoleFast("button", container).find((node) => {
    return (
      node.getAttribute("aria-label") === name ||
      node.textContent?.trim() === name
    );
  });
  if (!result) {
    throw new Error(`Missing button: ${name}`);
  }
  return result;
}
function row(title: string): HTMLElement {
  const result = screen.getByText(title).closest("button");
  if (!result) {
    throw new Error(`Missing notification: ${title}`);
  }
  return result;
}
function mockInbox(
  items: UserNotificationSummary[] = [first, second],
  notification: UserNotification = detail,
) {
  let entries = structuredClone(items);
  context.mocks.api(userNotificationsContract.list, ({ respond }) => {
    return respond(200, { items: entries, nextCursor: null });
  });
  context.mocks.api(userNotificationsContract.get, ({ respond }) => {
    return respond(200, notification);
  });
  context.mocks.api(
    userNotificationsContract.markRead,
    ({ params, respond }) => {
      entries = entries.map((item) => {
        return item.id === params.id ? { ...item, readAt } : item;
      });
      return respond(200, { readAt });
    },
  );
  context.mocks.api(userNotificationsContract.markAllRead, ({ respond }) => {
    entries = entries.map((item) => {
      return {
        ...item,
        readAt: item.readAt ?? readAt,
      };
    });
    return respond(200, { readThrough: readAt });
  });
  context.mocks.api(userNotificationsContract.summary, ({ respond }) => {
    return respond(200, {
      unreadCount: entries.filter((item) => {
        return !item.readAt;
      }).length,
    });
  });
}
async function openInbox() {
  await setupPage({
    context,
    path,
    auth: {
      user: { id: "test-user-123", fullName: "Notification tester" },
      organization: {
        activeOrg: { id: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe", name: "Staff" },
        memberships: [{ id: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe" }],
      },
    },
    featureSwitches: { [FeatureSwitchKey.UserNotifications]: true },
  });
  await waitFor(() => {
    return expect(button("Notifications")).toBeInTheDocument();
  });
  click(button("Notifications"));
}

test("Opening the list preserves unread messages; displaying rich text records only that message and returns to the list", async () => {
  mockInbox();
  await openInbox();
  await screen.findByText(first.title);
  expect(within(row(first.title)).getByText("Unread")).toBeInTheDocument();
  expect(within(row(second.title)).getByText("Unread")).toBeInTheDocument();
  click(row(first.title));
  const dialog = await screen.findByRole("dialog", { name: first.title });
  await expect(
    within(dialog).findByText("Everything in context"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).getByAltText("Projects overview")).toHaveAttribute(
    "src",
    "https://static.okou.io/notification-preview.png",
  );
  expect(dialog.querySelector("script")).toBeNull();
  await screen.findByText("1 unread notification");
  click(button("Close", dialog));
  await screen.findByText(first.title);
  await waitFor(() => {
    expect(
      within(row(first.title)).queryByText("Unread"),
    ).not.toBeInTheDocument();
  });
  expect(within(row(second.title)).getByText("Unread")).toBeInTheDocument();
  await waitFor(() => {
    expect(row(first.title)).toHaveFocus();
  });
});

test("Mark all as read preserves messages and disables the batch action", async () => {
  mockInbox();
  await openInbox();
  await screen.findByText(first.title);
  await waitFor(() => {
    expect(button("Mark all as read")).toBeEnabled();
  });
  click(button("Mark all as read"));
  await waitFor(() => {
    return expect(button("Mark all as read")).toBeDisabled();
  });
  expect(screen.getByText(first.title)).toBeInTheDocument();
  expect(screen.getByText(second.title)).toBeInTheDocument();
  await waitFor(() => {
    expect(
      within(row(first.title)).queryByText("Unread"),
    ).not.toBeInTheDocument();
  });
  expect(
    within(row(second.title)).queryByText("Unread"),
  ).not.toBeInTheDocument();
});

test("A failed read receipt keeps the message unread and can be retried in the detail", async () => {
  mockInbox();
  let fail = true;
  context.mocks.api(userNotificationsContract.markRead, ({ respond }) => {
    if (fail) {
      return respond(500, {
        error: { code: "INTERNAL_ERROR", message: "Write failed" },
      });
    }
    return respond(200, { readAt });
  });
  await openInbox();
  await screen.findByText(first.title);
  click(row(first.title));
  const dialog = await screen.findByRole("dialog", { name: first.title });
  await within(dialog).findByText("Couldn’t mark as read");
  fail = false;
  click(button("Try again", dialog));
  await waitFor(() => {
    return expect(
      within(dialog).queryByText("Couldn’t mark as read"),
    ).not.toBeInTheDocument();
  });
  click(button("Close", dialog));
  await screen.findByText(first.title);
  await waitFor(() => {
    expect(
      within(row(first.title)).queryByText("Unread"),
    ).not.toBeInTheDocument();
  });
});

test("A failed bulk receipt keeps the rows unread and the original action retries", async () => {
  mockInbox();
  let fail = true;
  context.mocks.api(userNotificationsContract.markAllRead, ({ respond }) => {
    if (fail) {
      return respond(500, {
        error: { code: "INTERNAL_ERROR", message: "Write failed" },
      });
    }
    return respond(200, { readThrough: readAt });
  });
  await openInbox();
  await screen.findByText(first.title);
  await waitFor(() => {
    expect(button("Mark all as read")).toBeEnabled();
  });
  click(button("Mark all as read"));
  await screen.findByText("Couldn’t mark as read");
  expect(within(row(first.title)).getByText("Unread")).toBeInTheDocument();
  fail = false;
  await waitFor(() => {
    expect(button("Mark all as read")).toBeEnabled();
  });
  click(button("Mark all as read"));
  await waitFor(() => {
    return expect(
      screen.queryByText("Couldn’t mark as read"),
    ).not.toBeInTheDocument();
  });
  await waitFor(() => {
    expect(
      within(row(first.title)).queryByText("Unread"),
    ).not.toBeInTheDocument();
  });
});

test("An empty inbox preserves its entry and shows an empty state", async () => {
  await openInbox();
  await screen.findByText("No notifications yet");
  expect(button("Notifications")).toBeInTheDocument();
  expect(button("Mark all as read")).toBeDisabled();
});

test("List failures can be retried without being presented as an empty inbox", async () => {
  mockInbox();
  let fail = true;
  context.mocks.api(userNotificationsContract.list, ({ respond }) => {
    return fail
      ? respond(500, {
          error: { code: "INTERNAL_ERROR", message: "Read failed" },
        })
      : respond(200, { items: [first], nextCursor: null });
  });
  await openInbox();
  await screen.findByText("Couldn’t load notifications");
  expect(screen.queryByText("No notifications yet")).not.toBeInTheDocument();
  fail = false;
  click(button("Try again"));
  await screen.findByText(first.title);
});

test("Older pages append to the existing list", async () => {
  mockInbox();
  context.mocks.api(userNotificationsContract.list, ({ query, respond }) => {
    return query.beforeId
      ? respond(200, { items: [second], nextCursor: null })
      : respond(200, {
          items: [first],
          nextCursor: { id: first.id, createdAt: first.createdAt },
        });
  });
  await openInbox();
  await screen.findByText(first.title);
  click(button("Show older"));
  await screen.findByText(second.title);
  expect(screen.getByText(first.title)).toBeInTheDocument();
});

test("The notification entry is absent when its switch is off", async () => {
  await setupPage({
    context,
    path,
    auth: {
      user: { id: "test-user-123", fullName: "Notification tester" },
      organization: {
        activeOrg: { id: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe", name: "Staff" },
        memberships: [{ id: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe" }],
      },
    },
    featureSwitches: { [FeatureSwitchKey.UserNotifications]: false },
  });
  await screen.findByTestId("chat-tagline");
  expect(
    queryAllByRoleFast("button").some((node) => {
      return node.getAttribute("aria-label") === "Notifications";
    }),
  ).toBeFalsy();
});

test("A notification delivered after the bulk snapshot stays unread", async () => {
  mockInbox();
  const later = { ...second, createdAt: "2026-11-06T04:00:01.000Z" };
  let remaining = 2;
  context.mocks.api(userNotificationsContract.list, ({ respond }) => {
    return respond(200, { items: [first, later], nextCursor: null });
  });
  context.mocks.api(userNotificationsContract.summary, ({ respond }) => {
    return respond(200, { unreadCount: remaining });
  });
  context.mocks.api(userNotificationsContract.markAllRead, ({ respond }) => {
    remaining = 1;
    return respond(200, { readThrough: readAt });
  });
  await openInbox();
  await screen.findByText(first.title);
  await waitFor(() => {
    expect(button("Mark all as read")).toBeEnabled();
  });
  click(button("Mark all as read"));
  await screen.findByText("1 unread notification");
  await waitFor(() => {
    expect(
      within(row(first.title)).queryByText("Unread"),
    ).not.toBeInTheDocument();
  });
  expect(within(row(second.title)).getByText("Unread")).toBeInTheDocument();
});

const carouselEntry = Object.freeze<UserNotificationSummary>({
  ...first,
  type: "carousel",
  title: "A three-page walkthrough",
});
const carouselNotification = Object.freeze<UserNotification>({
  ...detail,
  title: carouselEntry.title,
  payload: {
    type: "carousel",
    pages: [
      {
        markdown:
          "## Start with an idea\n\nDescribe what you want to achieve.\n\n[Read the guide](https://example.com/guide)",
      },
      {
        markdown:
          "## Bring your context\n\n![Context overview](https://static.okou.io/notification-preview.png)",
      },
      { markdown: "## Make it happen\n\nKeep the next step in sight." },
    ],
  },
});

function swipe(
  target: Element,
  end: { readonly x: number; readonly y: number },
) {
  fireEvent.touchStart(target, {
    touches: [{ identifier: 0, clientX: 200, clientY: 100 }],
  });
  fireEvent.touchEnd(target, {
    touches: [],
    changedTouches: [{ identifier: 0, clientX: end.x, clientY: end.y }],
  });
}

test("Carousel arrows and dots cycle pages and reopening starts at page one", async () => {
  mockInbox([carouselEntry], carouselNotification);
  await openInbox();
  await screen.findByText(carouselEntry.title);
  click(row(carouselEntry.title));
  const dialog = await screen.findByRole("dialog", {
    name: carouselEntry.title,
  });
  await within(dialog).findByText("Start with an idea");
  const navigation = within(dialog).getByRole("group", {
    name: "Pages in this message",
  });
  expect(button("Page 1 of 3", navigation)).toHaveAttribute(
    "aria-current",
    "step",
  );
  click(button("Previous page", navigation));
  await within(dialog).findByText("Make it happen");
  click(button("Next page", navigation));
  await within(dialog).findByText("Start with an idea");
  click(button("Next page", navigation));
  await within(dialog).findByText("Bring your context");
  expect(within(dialog).getByAltText("Context overview")).toBeInTheDocument();
  expect(button("Page 2 of 3", navigation)).toHaveAttribute(
    "aria-current",
    "step",
  );
  click(button("Page 3 of 3", navigation));
  await within(dialog).findByText("Make it happen");
  click(button("Next page", navigation));
  await within(dialog).findByText("Start with an idea");
  await screen.findByText("0 unread notifications");
  click(button("Close", dialog));
  await screen.findByText(carouselEntry.title);
  await waitFor(() => {
    expect(row(carouselEntry.title)).toHaveFocus();
  });
  click(row(carouselEntry.title));
  const reopened = await screen.findByRole("dialog", {
    name: carouselEntry.title,
  });
  await within(reopened).findByText("Start with an idea");
  expect(button("Page 1 of 3", reopened)).toHaveAttribute(
    "aria-current",
    "step",
  );
});

test("Carousel swipes cycle pages without intercepting reading or links", async () => {
  mockInbox([carouselEntry], carouselNotification);
  await openInbox();
  await screen.findByText(carouselEntry.title);
  click(row(carouselEntry.title));
  const dialog = await screen.findByRole("dialog", {
    name: carouselEntry.title,
  });
  const firstPage = await within(dialog).findByText("Start with an idea");
  for (const end of [
    { x: 180, y: 105 },
    { x: 195, y: 240 },
    { x: 130, y: 170 },
  ]) {
    swipe(firstPage, end);
    expect(firstPage).toBeInTheDocument();
  }
  fireEvent.touchStart(firstPage, {
    touches: [
      { identifier: 0, clientX: 200, clientY: 100 },
      { identifier: 1, clientX: 250, clientY: 100 },
    ],
  });
  fireEvent.touchEnd(firstPage, {
    touches: [],
    changedTouches: [{ identifier: 0, clientX: 80, clientY: 100 }],
  });
  expect(firstPage).toBeInTheDocument();
  fireEvent.touchStart(firstPage, {
    touches: [{ identifier: 0, clientX: 200, clientY: 100 }],
  });
  fireEvent.touchCancel(firstPage, { touches: [], changedTouches: [] });
  fireEvent.touchEnd(firstPage, {
    touches: [],
    changedTouches: [{ identifier: 0, clientX: 80, clientY: 100 }],
  });
  expect(firstPage).toBeInTheDocument();
  const guideLink = queryAllByRoleFast("link", dialog).find((link) => {
    return link.textContent?.trim() === "Read the guide";
  });
  if (!guideLink) {
    throw new Error("Expected the notification guide link");
  }
  swipe(guideLink, {
    x: 80,
    y: 100,
  });
  expect(firstPage).toBeInTheDocument();
  swipe(firstPage, { x: 80, y: 105 });
  const secondPage = await within(dialog).findByText("Bring your context");
  swipe(secondPage, { x: 340, y: 105 });
  const returned = await within(dialog).findByText("Start with an idea");
  swipe(returned, { x: 340, y: 105 });
  await within(dialog).findByText("Make it happen");
});
