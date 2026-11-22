import {
  queryAllByRoleFast,
  setupPage,
  click,
} from "../../../__tests__/page-helper.ts";
import {
  queryFastControl,
  findFastControl,
} from "./chat-message-experience-test-helpers.ts";

import { HttpResponse } from "msw";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  walletUserContract,
  type WalletConnectStatus,
} from "@okouai/api-contracts/contracts/wallet";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_RUN_ID,
  ATTACHMENT_THREAD_ID,
} from "./chat-attachment-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
const context = testContext();
const authorization =
  "https://login.link.com/auth?scope=userinfo%3Aread&state=" +
  "demo".repeat(12) +
  "&lang=en";
const purchase =
  "https://app.link.com/activity/approve/sample-coffee?locale=en&screen=review";
const authorizationId = "e0d23750-71a7-472c-b466-247049759ff1";
const continuation =
  "Link wallet authorization is complete. Continue the previous task.";
type Approval =
  "pending" | "approved" | "continued" | "stopped" | "unavailable";
function wallet(
  initial: WalletConnectStatus = { status: "pending" },
  purchaseStatus: Approval = "unavailable",
) {
  const server = { authorization: initial, approval: purchaseStatus };
  context.mocks.api(walletUserContract.connectStatus, ({ body, respond }) => {
    return respond(
      200,
      body.state === new URL(authorization).searchParams.get("state")
        ? server.authorization
        : { status: "unavailable" },
    );
  });
  context.mocks.api(walletUserContract.spendStatus, ({ body, respond }) => {
    return respond(200, {
      status:
        body.threadId === ATTACHMENT_THREAD_ID && body.approvalUrl === purchase
          ? server.approval
          : "unavailable",
    });
  });
  return server;
}
async function readConversation(
  content: string,
  options: Pick<
    NonNullable<Parameters<typeof mockChatLifecycle>[1]>,
    "sendGate" | "onSendRequest"
  > = {},
  transport: "direct" | "message-port" = "direct",
) {
  context.mocks.http.get("https://login.link.com/auth", () => {
    return HttpResponse.text("Provider consent fixture");
  });
  mockChatLifecycle(context, {
    ...options,
    threadId: ATTACHMENT_THREAD_ID,
    threadTitle: "Checkout notes",
    chatEvents: [
      {
        role: "assistant",
        content,
        createdAt: "2026-08-12T08:30:00Z",
        runId: ATTACHMENT_RUN_ID,
        runEventId: "checkout-summary",
        sequenceNumber: 1,
      },
    ],
  });
  await setupPage({
    context,
    host: "app.okou.ai",
    path: "/chats/" + ATTACHMENT_THREAD_ID,
    sharedWorkerTestTransport: transport,
  });
}
function change(orgId: string, claimed?: string) {
  context.mocks.ably.trigger("wallet:changed", { orgId, status: claimed });
}
async function watching() {
  await waitFor(() => {
    return expect(
      context.mocks.ably.hasSubscription("wallet:changed"),
    ).toBeTruthy();
  });
}
function safeAction(link: HTMLElement, href: string) {
  expect(link).toHaveAttribute("href", href);
  expect(link).toHaveAttribute("target", "_blank");
  expect(link.getAttribute("rel")?.split(/\s+/u)).toStrictEqual(
    expect.arrayContaining(["noopener", "noreferrer"]),
  );
}
test("wallet-action-card-012 Consent and purchase cards preserve their URLs, domains and surrounding instructions", async () => {
  wallet();
  await readConversation(
    [
      "Before checkout, confirm the two steps.",
      authorization,
      "Then review the purchase.",
      purchase,
      "Keep the receipt.",
    ].join("\n\n"),
  );
  safeAction(
    await findFastControl("link", "Authorize Link wallet"),
    authorization,
  );
  safeAction(await findFastControl("link", "Review purchase"), purchase);
  for (const text of [
    "Before checkout, confirm the two steps.",
    "login.link.com",
    "Then review the purchase.",
    "app.link.com",
    "Keep the receipt.",
  ]) {
    expect(screen.getByText(text)).toBeVisible();
  }
});
test("wallet-action-card-015 Path and query approval URLs both retain their address and Review purchase action", async () => {
  wallet();
  const query = "https://app.link.com/approve?intent=lunch%2Ftwo&review=1";
  await readConversation(purchase + "\n\n" + query);
  await waitFor(() => {
    return expect(
      queryAllByRoleFast("link")
        .filter((el) => {
          return el.getAttribute("aria-label") === "Review purchase";
        })
        .map((el) => {
          return el.getAttribute("href");
        }),
    ).toStrictEqual([purchase, query]);
  });
});
test("wallet-action-card-017 Ordinary and untrusted provider destinations retain their original links", async () => {
  const links = [
    "https://login.link.com/help",
    "https://stripe.com/payments",
    "https://app.link.com.example.test/approve/fixture",
    "https://reader@app.link.com/approve/a",
    "https://app.link.com:8443/approve/b",
    "http://app.link.com/approve/c",
  ];
  await readConversation(
    links
      .map((url, index) => {
        return "[Reference " + String(index + 1) + "](" + url + ")";
      })
      .join("\n\n"),
  );
  for (const [index, url] of links.entries()) {
    await expect(
      findFastControl("link", "Reference " + String(index + 1)),
    ).resolves.toHaveAttribute("href", url);
  }
  expect(
    queryFastControl(
      "link",
      /Review purchase|Authorize Link wallet|Continue in Link/,
    ),
  ).toBeNull();
});
test("wallet-action-card-020 A stopped purchase replaces the approved waiting message and keeps the status control disabled", async () => {
  const remote = wallet({ status: "pending" }, "approved");
  await readConversation(purchase);
  await expect(
    screen.findByText("Approved; waiting to continue"),
  ).resolves.toBeVisible();
  expect(queryFastControl("button", "Status recorded")).toBeDisabled();
  await watching();
  remote.approval = "stopped";
  change("org_default");
  await expect(
    screen.findByText("Automatic waiting has ended."),
  ).resolves.toBeVisible();
  expect(queryFastControl("button", "Status recorded")).toBeDisabled();
});
test("wallet-action-card-009 An expired authorization gives no action or continuation", async () => {
  wallet({ status: "expired" });
  await readConversation(authorization);
  const terminal = await findFastControl("button", "Authorization expired");
  expect(terminal).toBeDisabled();
  expect(queryFastControl("link", "Authorize Link wallet")).toBeNull();
  expect(screen.queryByText(continuation)).toBeNull();
});
test("wallet-action-card-005 An authorized notification cannot override failed consent or send a continuation", async () => {
  const remote = wallet();
  await readConversation(authorization);
  click(await findFastControl("link", "Authorize Link wallet"));
  await screen.findByText("Waiting for authorization");
  await watching();
  remote.authorization = { status: "failed" };
  change("org_default", "authorized");
  await expect(
    findFastControl("button", "Authorization not completed"),
  ).resolves.toBeDisabled();
  expect(screen.queryByText("Waiting for authorization")).toBeNull();
  expect(screen.queryByText(continuation)).toBeNull();
});
test("wallet-action-card-007 A confirmed continuation remains busy until the owning chat accepts it", async () => {
  wallet({ status: "authorized", authorizationId });
  const received = context.mocks.deferred<void>(),
    release = context.mocks.deferred<void>();
  try {
    await readConversation(authorization, {
      sendGate: async () => {
        received.resolve();
        await release.promise;
      },
    });
    const action = await findFastControl("button", "Continue");
    click(action);
    await received.promise;
    expect(action).toBeDisabled();
    expect(queryFastControl("button", "Authorized")).toBeNull();
    release.resolve();
    await expect(
      findFastControl("button", "Authorized"),
    ).resolves.toBeDisabled();
  } finally {
    if (!release.settled()) {
      release.resolve();
    }
  }
});
test("wallet-action-card-002 Authorization alone leaves the conversation untouched until the user continues once", async () => {
  const remote = wallet();
  await readConversation(authorization);
  await findFastControl("link", "Authorize Link wallet");
  await watching();
  remote.authorization = { status: "authorized", authorizationId };
  change("org_default");
  const confirm = await findFastControl("button", "Continue");
  expect(screen.queryByText(continuation)).toBeNull();
  click(confirm);
  await expect(findFastControl("button", "Authorized")).resolves.toBeDisabled();
  await waitFor(() => {
    return expect(screen.getAllByText(continuation)).toHaveLength(1);
  });
  expect(location.pathname).toBe("/chats/" + ATTACHMENT_THREAD_ID);
});
test("wallet-action-card-001 Authorization that finishes during subscription attachment continues the owning chat once", async () => {
  const remote = wallet();
  const joining = context.mocks.ably.deferSubscribeOnChannel(
    "user:test-user-123",
    "wallet:changed",
  );
  let attached = false;
  try {
    await readConversation(authorization, {}, "message-port");
    const authorize = await findFastControl("link", "Authorize Link wallet");
    safeAction(authorize, authorization);
    click(authorize);
    await joining.started;
    remote.authorization = { status: "authorized", authorizationId };
    joining.attach();
    attached = true;
    await watching();
    change("another-organization");
    change("org_default");
    change("org_default");
    await expect(
      findFastControl("button", "Authorized"),
    ).resolves.toBeDisabled();
    await waitFor(() => {
      return expect(screen.getAllByText(continuation)).toHaveLength(1);
    });
    expect(location.pathname).toBe("/chats/" + ATTACHMENT_THREAD_ID);
  } finally {
    if (!attached) {
      joining.attach();
    }
  }
});
