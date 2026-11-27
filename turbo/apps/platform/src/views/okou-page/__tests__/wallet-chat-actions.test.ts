import {
  bankingWorkspaceContract,
  type BankingWorkspaceStatus,
} from "@okouai/api-contracts/contracts/banking";
import { screen, within, waitFor } from "@testing-library/react";
import { test, expect, vi } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  setupPage,
  click,
  queryAllByRoleFast,
  fill,
} from "../../../__tests__/page-helper.ts";
import { bankingActionUrl } from "./chat-capability-connector-test-helpers.ts";
import {
  RUN_PATH,
  createChatCapabilityHelpers,
  completedConversation,
  type CapturedChatSend,
} from "./chat-capability-test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import { HttpResponse } from "msw";
import {
  walletUserContract,
  type WalletConnectStatus,
} from "@okouai/api-contracts/contracts/wallet";
import {
  ATTACHMENT_RUN_ID,
  ATTACHMENT_THREAD_ID,
} from "./chat-attachment-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

const reason = "Review recent cash-flow activity";
const resume = "Continue the cash-flow review";
const provider = "https://bank.example.test/member/sign-in";
const sessionId = "bf790000-0000-4000-a000-000000000001";
const accountId = "bf790000-0000-4000-a000-000000000002";
function connected(): BankingWorkspaceStatus["connection"] {
  return {
    id: "bf790000-0000-4000-a000-000000000003",
    status: "active",
    accounts: [
      {
        id: accountId,
        name: "Operating account",
        institutionName: "Example Bank",
        type: "checking",
        last4: "0284",
        repairRequired: false,
      },
    ],
    repairInstitutions: [],
  };
}
async function request(status: BankingWorkspaceStatus) {
  const sends: CapturedChatSend[] = [];
  const revocations: unknown[] = [];
  const link = bankingActionUrl({ reason, callbackPrompt: resume });
  createChatCapabilityHelpers(context).installCapabilityChat({
    events: completedConversation(
      "Please review this request. [Banking access](" + link + ")",
    ),
    onSend: (s) => {
      sends.push(s);
    },
  });
  context.mocks.api(
    bankingWorkspaceContract.accessRequestStatus,
    ({ respond }) => {
      return respond(200, status);
    },
  );
  context.mocks.api(
    bankingWorkspaceContract.createConnectSession,
    ({ body, respond }) => {
      status.session = {
        id: sessionId,
        mode: body.mode,
        status: "pending",
        institutionLoginId: null,
      };
      return respond(200, { sessionId, url: provider });
    },
  );
  context.mocks.api(
    bankingWorkspaceContract.revokeGrant,
    ({ body, respond }) => {
      revocations.push(body);
      status.grant = null;
      return respond(200, status);
    },
  );
  await setupPage({ context, path: RUN_PATH });
  const card = await screen.findByTestId("banking-action-card");
  click(await findFastControl("button", "View details", card));
  const dialog = await screen.findByRole("dialog", {
    name: "Banking access request",
  });
  return { dialog, sends, revocations };
}
test("chat-capability-connectors-001 Bank sign-in redirects the opened window and a completed connection exposes the operating account", async () => {
  const status: BankingWorkspaceStatus = {
    connection: null,
    session: null,
    grant: null,
  };
  const popup = context.mocks.browser.authWindow();
  const replace = vi.fn<(url: string) => void>();
  Object.defineProperty(popup, "location", { value: { replace } });
  const open = context.mocks.browser.open(popup);
  const { dialog } = await request(status);
  await within(dialog).findByText(reason);
  click(await findFastControl("button", "Connect a bank", dialog));
  await waitFor(() => {
    return expect(replace).toHaveBeenCalledWith(provider);
  });
  expect(open.calls).toStrictEqual([
    { url: "about:blank", target: "_blank", features: null },
  ]);
  await within(dialog).findByText(/Finish there, then return to Chat/);
  expect(
    within(dialog).queryByRole("checkbox", { name: /Operating account/ }),
  ).toBeNull();
  status.connection = connected();
  status.session = null;
  context.mocks.ably.trigger("bankingAccessChanged", {});
  await expect(
    within(dialog).findByRole("checkbox", { name: /Operating account/ }),
  ).resolves.toBeVisible();
});
test("chat-capability-connectors-003 Repeated continuations share both event identifiers and confirmed revocation reopens account selection", async () => {
  const status: BankingWorkspaceStatus = {
    connection: connected(),
    session: null,
    grant: {
      status: "active",
      accountIds: [accountId],
      purpose: reason,
      expiresAt: null,
    },
  };
  const { dialog, sends, revocations } = await request(status);
  const proceed = await findFastControl("button", "Continue", dialog);
  click(proceed);
  await waitFor(() => {
    return expect(sends[0]?.prompt).toBe(resume);
  });
  await waitFor(() => {
    return expect(proceed).toBeEnabled();
  });
  click(proceed);
  await waitFor(() => {
    return expect(sends[1]?.prompt).toBe(resume);
  });
  const first = sends[0];
  expect(first?.clientEventId).toStrictEqual(expect.any(String));
  expect(first?.chatThreadSortEventId).toStrictEqual(expect.any(String));
  expect(sends[1]?.clientEventId).toBe(first?.clientEventId);
  expect(sends[1]?.chatThreadSortEventId).toBe(first?.chatThreadSortEventId);
  click(await findFastControl("button", "Revoke", dialog));
  await within(dialog).findByText("Revoke banking access for this workspace?");
  click(await findFastControl("button", "Revoke", dialog));
  await expect(
    within(dialog).findByRole("checkbox", { name: /Operating account/ }),
  ).resolves.not.toBeChecked();
  await expect(
    findFastControl("button", "Grant access", dialog),
  ).resolves.toBeDisabled();
  expect(revocations).toStrictEqual([{}]);
});

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
    await readConversation(authorization);
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

test("wallet-action-card-019 A suspended purchase subscription reloads the continued purchase on reconnection", async () => {
  const provider = wallet({ status: "pending" }, "pending");
  await readConversation(purchase);
  await findFastControl("link", "Review purchase");
  await watching();
  provider.approval = "approved";
  change("other-organization");
  const editor = await screen.findByRole("textbox", { name: "Message" });
  await fill(editor, "Draft a note for the purchasing team");
  expect(editor).toHaveTextContent("Draft a note for the purchasing team");
  expect(screen.queryByText("Approved; waiting to continue")).toBeNull();
  expect(queryFastControl("link", "Review purchase")).toBeVisible();
  change("org_default");
  await screen.findByText("Approved; waiting to continue");
  expect(queryFastControl("button", "Status recorded")).toBeDisabled();
  context.mocks.ably.triggerConnectionState("suspended");
  provider.approval = "continued";
  context.mocks.ably.triggerConnectionState("connected");
  await screen.findByText("Purchase request continued");
  expect(queryFastControl("button", "Status recorded")).toBeDisabled();
});
