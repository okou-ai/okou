import { screen, waitFor, within } from "@testing-library/react";
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
    action: { label: "Explore projects", url: "https://app.okou.ai/" },
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
  if (!result) throw new Error(`Missing button: ${name}`);
  return result;
}
function row(title: string): HTMLElement {
  const result = screen.getByText(title).closest("button");
  if (!result) throw new Error(`Missing notification: ${title}`);
  return result;
}
function mockInbox(items: UserNotificationSummary[] = [first, second]) {
  let entries = structuredClone(items);
  context.mocks.api(userNotificationsContract.list, ({ respond }) => {
    return respond(200, { items: entries, nextCursor: null });
  });
  context.mocks.api(userNotificationsContract.get, ({ respond }) => {
    return respond(200, detail);
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
  expect(
    await within(dialog).findByText("Everything in context"),
  ).toBeInTheDocument();
  expect(within(dialog).getByAltText("Projects overview")).toHaveAttribute(
    "src",
    "https://static.okou.io/notification-preview.png",
  );
  const action = queryAllByRoleFast("link", dialog).find((link) => {
    return link.textContent === "Explore projects";
  });
  expect(action).toHaveAttribute("href", "https://app.okou.ai/");
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
    if (fail)
      return respond(500, {
        error: { code: "INTERNAL_ERROR", message: "Write failed" },
      });
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
    if (fail)
      return respond(500, {
        error: { code: "INTERNAL_ERROR", message: "Write failed" },
      });
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
  ).toBe(false);
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
