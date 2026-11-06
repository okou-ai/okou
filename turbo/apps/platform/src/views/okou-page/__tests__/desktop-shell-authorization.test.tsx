import {
  desktopShellAuthorizationContract as contract,
  type DesktopShellAuthorization,
} from "@okouai/api-contracts/contracts/desktop-shell-authorization";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockNow, now } from "../../../lib/time.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const ID = "10000000-0000-4000-8000-000000000001";
const THREAD_ID = "20000000-0000-4000-8000-000000000001";
const PATH = `/computer-use/shell/authorize/${ID}`;
const URL = `https://app.okou.ai${PATH}`;
const SHELL_TOPIC = "desktopShellAuthorizationChanged";
const USER_CHANNEL = "user:test-user-123";

function findButton(card: HTMLElement, name: string) {
  return queryAllByRoleFast("button", card).find((element) => {
    return (
      element.textContent?.trim() === name ||
      element.getAttribute("aria-label") === name
    );
  });
}

function button(card: HTMLElement, name: string) {
  const element = findButton(card, name);
  if (!element) {
    throw new Error(`Missing button: ${name}`);
  }
  return element;
}

function authorization(
  overrides: Partial<DesktopShellAuthorization> = {},
): DesktopShellAuthorization {
  return {
    id: ID,
    chatThreadId: THREAD_ID,
    computerUseHostId: "30000000-0000-4000-8000-000000000001",
    requestedByRunId: "40000000-0000-4000-8000-000000000001",
    computerName: "Work Mac",
    reason: "Run the project tests",
    status: "pending",
    requestExpiresAt: new Date(now() + 60 * 60 * 1000).toISOString(),
    approvedAt: null,
    grantExpiresAt: null,
    approvalBlockedReason: null,
    authorizationUrl: URL,
    ...overrides,
  };
}

async function setupChat(
  content: string,
  sharedWorkerTestTransport?: "message-port",
) {
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "Shell approval",
    chatEvents: [
      {
        id: "shell-access-request",
        role: "assistant",
        runId: "request-run",
        content,
        createdAt: "2026-10-20T10:00:00.000Z",
      },
    ],
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
    sharedWorkerTestTransport,
  });
}

function approvedAuthorization() {
  return authorization({
    status: "approved",
    approvedAt: new Date(now()).toISOString(),
    grantExpiresAt: new Date(now() + 60 * 60 * 1000).toISOString(),
  });
}

test("A user approves and revokes directly from the card", async () => {
  let current = authorization();
  let approvals = 0;
  context.mocks.api(contract.get, ({ respond }) => {
    return respond(200, current);
  });
  context.mocks.api(contract.approve, ({ respond }) => {
    approvals++;
    current = approvedAuthorization();
    context.mocks.ably.trigger(SHELL_TOPIC);
    return respond(200, current);
  });
  context.mocks.api(contract.revoke, ({ respond }) => {
    current = { ...current, status: "revoked" };
    context.mocks.ably.trigger(SHELL_TOPIC);
    return respond(200, current);
  });
  await setupChat(`[Allow Shell access](${URL})`);
  const card = await screen.findByTestId("desktop-shell-authorization-card");
  await waitFor(() => {
    expect(button(card, "Allow for 1 hour")).toBeEnabled();
  });
  expect(card).toHaveTextContent("Work Mac · 1 hour");
  expect(within(card).getByText("Run the project tests")).toBeInTheDocument();
  click(button(card, "Allow for 1 hour"));
  await within(card).findByText("Shell access allowed");
  expect(card).toHaveTextContent("Work Mac · This chat");
  expect(approvals).toBe(1);
  click(button(card, "Revoke"));
  await within(card).findByText("Shell access revoked");
  expect(findButton(card, "Revoke")).toBeUndefined();
});

test.each([
  ["run_active", "Wait for the requesting Run to finish before approving."],
  [
    "run_unavailable",
    "The requesting Run is unavailable. Ask for a new request in this chat.",
  ],
  [
    "chat_busy",
    "Wait for the current Run in this chat to finish before approving.",
  ],
  ["computer_changed", "Select Work Mac again before approving."],
] as const)(
  "The direct page explains %s before allowing approval",
  async (approvalBlockedReason, message) => {
    let current = authorization({ approvalBlockedReason });
    context.mocks.api(contract.get, ({ respond }) => {
      return respond(200, current);
    });
    await setupPage({ context, path: PATH, host: "app.okou.ai" });
    const card = await screen.findByTestId("desktop-shell-authorization-card");
    await waitFor(() => {
      return expect(button(card, "Allow for 1 hour")).toBeDisabled();
    });
    expect(within(card).getByText(message)).toBeInTheDocument();
    expect(button(card, "Deny")).toBeEnabled();
    current = authorization();
    context.mocks.ably.trigger(SHELL_TOPIC);
    await waitFor(() => {
      return expect(button(card, "Allow for 1 hour")).toBeEnabled();
    });
  },
);

test("The complete authorization reason is readable directly in the card", async () => {
  const reason = "Inspect the project files and explain the results. ".repeat(
    10,
  );
  context.mocks.api(contract.get, ({ respond }) => {
    return respond(200, authorization({ reason }));
  });
  await setupChat(URL);
  const card = await screen.findByTestId("desktop-shell-authorization-card");
  const reasonRegion = await within(card).findByRole("region", {
    name: "Reason for access",
  });
  expect(within(reasonRegion).getByText(reason.trim())).toBeInTheDocument();
  await userEvent.click(reasonRegion);
  expect(reasonRegion).toHaveFocus();
  expect(button(card, "Allow for 1 hour")).toBeEnabled();
});

test("A blocked card shows the reason and approval blocker together", async () => {
  context.mocks.api(contract.get, ({ respond }) => {
    return respond(
      200,
      authorization({ approvalBlockedReason: "computer_changed" }),
    );
  });
  await setupChat(URL);
  const card = await screen.findByTestId("desktop-shell-authorization-card");
  await within(card).findByText("Select Work Mac again before approving.");
  expect(within(card).getByText("Run the project tests")).toBeInTheDocument();
  expect(button(card, "Allow for 1 hour")).toBeDisabled();
  expect(button(card, "Deny")).toBeEnabled();
});

test("A user denies directly from the card and can inspect the result", async () => {
  let current = authorization();
  context.mocks.api(contract.get, ({ respond }) => {
    return respond(200, current);
  });
  context.mocks.api(contract.deny, ({ respond }) => {
    current = { ...current, status: "denied" };
    context.mocks.ably.trigger(SHELL_TOPIC);
    return respond(200, current);
  });
  await setupChat(URL);
  const card = await screen.findByTestId("desktop-shell-authorization-card");
  await waitFor(() => {
    expect(button(card, "Deny")).toBeEnabled();
  });
  click(button(card, "Deny"));
  await within(card).findByText("Shell access denied");
  expect(within(card).getByText("Run the project tests")).toBeInTheDocument();
  expect(findButton(card, "Allow for 1 hour")).toBeUndefined();
});

test("The card disables both actions during approval and shows an approval failure", async () => {
  const started = context.mocks.deferred<void>();
  const response = context.mocks.deferred<void>();
  context.mocks.api(contract.get, ({ respond }) => {
    return respond(200, authorization());
  });
  context.mocks.api(contract.approve, async ({ respond }) => {
    started.resolve();
    await response.promise;
    return respond(500, {
      error: { code: "INTERNAL_SERVER_ERROR", message: "Approval failed" },
    });
  });
  await setupChat(URL);
  const card = await screen.findByTestId("desktop-shell-authorization-card");
  await waitFor(() => {
    expect(button(card, "Allow for 1 hour")).toBeEnabled();
  });
  click(button(card, "Allow for 1 hour"));
  await started.promise;
  expect(button(card, "Allow for 1 hour")).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(button(card, "Deny")).toBeDisabled();
  response.resolve();
  await within(card).findByText("Could not update authorization.");
  expect(button(card, "Allow for 1 hour")).toBeDisabled();
  expect(button(card, "Deny")).toBeDisabled();
});

test("Attaching realtime does not refetch a shell card, but a shell event updates its status", async () => {
  let current = authorization();
  const attach = context.mocks.ably.deferSubscribeOnChannel(
    USER_CHANNEL,
    SHELL_TOPIC,
  );
  context.mocks.api(contract.get, ({ respond }) => {
    return respond(200, current);
  });
  await setupChat(URL, "message-port");
  const card = await screen.findByTestId("desktop-shell-authorization-card");
  await waitFor(() => {
    return expect(button(card, "Allow for 1 hour")).toBeEnabled();
  });
  await attach.started;
  current = approvedAuthorization();
  attach.attach();
  await waitFor(() => {
    return expect(
      context.mocks.ably.hasSubscriptionOnChannel(USER_CHANNEL, SHELL_TOPIC),
    ).toBeTruthy();
  });
  expect(button(card, "Allow for 1 hour")).toBeEnabled();
  expect(
    within(card).queryByText("Shell access allowed"),
  ).not.toBeInTheDocument();
  context.mocks.ably.triggerOnChannel(USER_CHANNEL, SHELL_TOPIC);
  await waitFor(() => {
    return expect(button(card, "Revoke")).toBeEnabled();
  });
  expect(within(card).getByText("Shell access allowed")).toBeInTheDocument();
  current = { ...current, status: "revoked" };
  context.mocks.ably.triggerOnChannel(USER_CHANNEL, SHELL_TOPIC);
  await within(card).findByText("Shell access revoked");
  expect(findButton(card, "Revoke")).toBeUndefined();
});

test("The direct page automatically removes and restores the approval blocker on shell events", async () => {
  let current = authorization({ approvalBlockedReason: "run_active" });
  const attach = context.mocks.ably.deferSubscribeOnChannel(
    USER_CHANNEL,
    SHELL_TOPIC,
  );
  context.mocks.api(contract.get, ({ respond }) => {
    return respond(200, current);
  });
  await setupPage({
    context,
    path: PATH,
    host: "app.okou.ai",
    sharedWorkerTestTransport: "message-port",
  });
  const card = await screen.findByTestId("desktop-shell-authorization-card");
  await waitFor(() => {
    expect(button(card, "Allow for 1 hour")).toBeDisabled();
  });
  await attach.started;
  attach.attach();
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscriptionOnChannel(USER_CHANNEL, SHELL_TOPIC),
    ).toBeTruthy();
  });

  current = authorization();
  context.mocks.ably.triggerOnChannel(USER_CHANNEL, SHELL_TOPIC);
  await waitFor(() => {
    expect(button(card, "Allow for 1 hour")).toBeEnabled();
  });

  current = authorization({ approvalBlockedReason: "run_active" });
  context.mocks.ably.triggerOnChannel(USER_CHANNEL, SHELL_TOPIC);
  await waitFor(() => {
    expect(button(card, "Allow for 1 hour")).toBeDisabled();
  });
});

test.each([
  ["pending", SHELL_TOPIC],
  ["approved", SHELL_TOPIC],
  ["pending", "computerUseHostsChanged"],
  ["approved", "computerUseHostsChanged"],
] as const)(
  "A shell card retains %s content and actions while %s refreshes",
  async (status, topic) => {
    const refreshStarted = context.mocks.deferred<void>();
    const refreshResponse = context.mocks.deferred<void>();
    let refreshing = false;
    let current =
      status === "approved" ? approvedAuthorization() : authorization();
    context.mocks.api(contract.get, async ({ respond }) => {
      if (refreshing) {
        refreshStarted.resolve();
        await refreshResponse.promise;
      }
      return respond(200, current);
    });
    await setupChat(URL, "message-port");
    const card = await screen.findByTestId("desktop-shell-authorization-card");
    const label = status === "approved" ? "Revoke" : "Allow for 1 hour";
    await waitFor(() => {
      return expect(button(card, label)).toBeEnabled();
    });
    await waitFor(() => {
      return expect(
        context.mocks.ably.hasSubscriptionOnChannel(USER_CHANNEL, topic),
      ).toBeTruthy();
    });
    refreshing = true;
    await act(async () => {
      context.mocks.ably.triggerOnChannel(USER_CHANNEL, topic);
      await refreshStarted.promise;
    });
    expect(card).toHaveTextContent("Work Mac");
    expect(button(card, label)).toBeEnabled();
    expect(within(card).getByText("Run the project tests")).toBeInTheDocument();
    current = {
      ...current,
      status: status === "approved" ? "revoked" : "denied",
    };
    refreshResponse.resolve();
    await within(card).findByText(
      status === "approved" ? "Shell access revoked" : "Shell access denied",
    );
    expect(findButton(card, "Allow for 1 hour")).toBeUndefined();
    expect(findButton(card, "Revoke")).toBeUndefined();
  },
);

test("A failed background read stops offering access and a later shell event recovers", async () => {
  let available = true;
  let current = approvedAuthorization();
  context.mocks.api(contract.get, ({ respond }) => {
    return available
      ? respond(200, current)
      : respond(500, {
          error: { code: "INTERNAL_SERVER_ERROR", message: "Read failed" },
        });
  });
  await setupChat(URL, "message-port");
  const card = await screen.findByTestId("desktop-shell-authorization-card");
  await waitFor(() => {
    expect(button(card, "Revoke")).toBeEnabled();
    expect(
      context.mocks.ably.hasSubscriptionOnChannel(USER_CHANNEL, SHELL_TOPIC),
    ).toBeTruthy();
  });
  available = false;
  context.mocks.ably.triggerOnChannel(USER_CHANNEL, SHELL_TOPIC);
  await within(card).findByText("Shell access unavailable");
  expect(button(card, "Authorization unavailable")).toBeDisabled();
  expect(findButton(card, "Revoke")).toBeUndefined();
  available = true;
  current = { ...current, status: "revoked" };
  context.mocks.ably.triggerOnChannel(USER_CHANNEL, SHELL_TOPIC);
  await within(card).findByText("Shell access revoked");
});

test("A host change makes an unavailable authorization stop offering approval", async () => {
  let available = true;
  context.mocks.api(contract.get, ({ respond }) => {
    return available
      ? respond(200, authorization())
      : respond(404, {
          error: { code: "NOT_FOUND", message: "Authorization unavailable" },
        });
  });
  await setupChat(URL, "message-port");
  const card = await screen.findByTestId("desktop-shell-authorization-card");
  await waitFor(() => {
    expect(button(card, "Allow for 1 hour")).toBeEnabled();
    expect(
      context.mocks.ably.hasSubscriptionOnChannel(
        USER_CHANNEL,
        "computerUseHostsChanged",
      ),
    ).toBeTruthy();
  });
  available = false;
  context.mocks.ably.triggerOnChannel(USER_CHANNEL, "computerUseHostsChanged");
  await within(card).findByText("Shell access unavailable");
  expect(findButton(card, "Allow for 1 hour")).toBeUndefined();
});

test("A request update rearms its deadline and expires it without another event", async () => {
  let current = authorization({ approvalBlockedReason: "run_active" });
  context.mocks.api(contract.get, ({ respond }) => {
    return respond(200, current);
  });
  await setupPage({ context, path: PATH, host: "app.okou.ai" });
  const card = await screen.findByTestId("desktop-shell-authorization-card");
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription(SHELL_TOPIC)).toBeTruthy();
  });
  current = authorization({
    reason: "This request is about to expire",
    requestExpiresAt: new Date(now() + 250).toISOString(),
  });
  context.mocks.ably.trigger(SHELL_TOPIC);
  await expect(
    within(card).findByText("This request is about to expire"),
  ).resolves.toBeInTheDocument();
  await expect(
    within(card).findByText("Request expired"),
  ).resolves.toBeInTheDocument();
  expect(findButton(card, "Allow for 1 hour")).toBeUndefined();
  expect(findButton(card, "Deny")).toBeUndefined();
});

test("Approving a request arms the grant deadline and removes revoke when access expires", async () => {
  let current = authorization();
  context.mocks.api(contract.get, ({ respond }) => {
    return respond(200, current);
  });
  context.mocks.api(contract.approve, ({ respond }) => {
    current = authorization({
      status: "approved",
      reason: "This grant is about to expire",
      approvedAt: new Date(now()).toISOString(),
      grantExpiresAt: new Date(now() + 250).toISOString(),
    });
    context.mocks.ably.trigger(SHELL_TOPIC);
    return respond(200, current);
  });
  await setupChat(URL);
  const card = await screen.findByTestId("desktop-shell-authorization-card");
  await waitFor(() => {
    expect(button(card, "Allow for 1 hour")).toBeEnabled();
  });
  click(button(card, "Allow for 1 hour"));
  await within(card).findByText("Shell access allowed");
  await within(card).findByText("Shell access expired");
  expect(findButton(card, "Revoke")).toBeUndefined();
  expect(findButton(card, "Allow for 1 hour")).toBeUndefined();
});

test("A shell event expires its grant when the timer elapses before the wall-clock deadline sample", async () => {
  const timestamp = Date.parse("2026-10-20T10:00:00.000Z");
  mockNow(timestamp, context.signal);
  let current = authorization();
  context.mocks.api(contract.get, ({ respond }) => {
    return respond(200, current);
  });
  await setupChat(URL);
  const card = await screen.findByTestId("desktop-shell-authorization-card");
  await waitFor(() => {
    expect(button(card, "Allow for 1 hour")).toBeEnabled();
    expect(context.mocks.ably.hasSubscription(SHELL_TOPIC)).toBeTruthy();
  });
  current = authorization({
    status: "approved",
    approvedAt: new Date(timestamp).toISOString(),
    grantExpiresAt: new Date(timestamp + 250).toISOString(),
  });
  // Timer delivery and the wall clock need not agree on the same millisecond.
  // Keep the application clock one millisecond short while the real timer fires.
  mockNow(timestamp + 249, context.signal);
  context.mocks.ably.trigger(SHELL_TOPIC);
  await within(card).findByText("Shell access expired");
  expect(findButton(card, "Revoke")).toBeUndefined();
});

test("A delayed approval event restores a later grant after the local request deadline elapsed", async () => {
  const timestamp = Date.parse("2026-10-20T10:00:00.000Z");
  mockNow(timestamp, context.signal);
  let current = authorization({
    requestExpiresAt: new Date(timestamp + 1).toISOString(),
  });
  context.mocks.api(contract.get, ({ respond }) => {
    return respond(200, current);
  });
  await setupChat(URL);
  const card = await screen.findByTestId("desktop-shell-authorization-card");
  await expect(
    within(card).findByText("Shell access expired"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription(SHELL_TOPIC)).toBeTruthy();
  });

  // Approval happened before expiry; its notification reaches this card later.
  current = {
    ...current,
    status: "approved",
    approvedAt: new Date(timestamp).toISOString(),
    grantExpiresAt: new Date(timestamp + 60 * 60 * 1000).toISOString(),
  };
  mockNow(timestamp + 2, context.signal);
  context.mocks.ably.trigger(SHELL_TOPIC);
  await waitFor(() => {
    expect(button(card, "Revoke")).toBeEnabled();
  });
  expect(within(card).getByText("Shell access allowed")).toBeInTheDocument();
  expect(
    within(card).queryByText("Shell access expired"),
  ).not.toBeInTheDocument();
});

test("A request for another chat stays unavailable in this transcript", async () => {
  context.mocks.api(contract.get, ({ respond }) => {
    return respond(
      200,
      authorization({ chatThreadId: "50000000-0000-4000-8000-000000000001" }),
    );
  });
  await setupChat(URL);
  const card = await screen.findByTestId("desktop-shell-authorization-card");
  await waitFor(() => {
    return expect(
      within(card).getByText("Authorization unavailable"),
    ).toBeVisible();
  });
  expect(findButton(card, "Allow for 1 hour")).toBeUndefined();
});

test("An external URL with the same path remains an ordinary link", async () => {
  await setupChat(`[Shell access](https://untrusted.example${PATH})`);
  await waitFor(() => {
    expect(
      queryAllByRoleFast("link").find((element) => {
        return element.textContent?.trim() === "Shell access";
      }),
    ).toHaveAttribute("href", `https://untrusted.example${PATH}`);
  });
  expect(screen.queryByTestId("desktop-shell-authorization-card")).toBeNull();
});
