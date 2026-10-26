import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { state } from "ccstate";
import {
  walletUserContract,
  type WalletConnectionStatus,
  type WalletPaymentMethod,
} from "@okouai/api-contracts/contracts/wallet";
import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const everyday = Object.freeze<WalletPaymentMethod>({
  id: "pm_everyday",
  type: "CARD",
  name: "Visa",
  nickname: "Everyday",
  isDefault: true,
  card: { brand: "visa", last4: "4242", expMonth: 2, expYear: 2028 },
});
const business = Object.freeze<WalletPaymentMethod>({
  id: "pm_business",
  type: "CARD",
  name: "Mastercard",
  nickname: "Business",
  isDefault: false,
  card: { brand: "mastercard", last4: "4444", expMonth: 8, expYear: 2029 },
});
const bank = Object.freeze<WalletPaymentMethod>({
  id: "pm_bank",
  type: "BANK_ACCOUNT",
  name: "Checking account",
  isDefault: false,
  bankAccount: { last4: "9876", bankName: "Example Bank" },
});

function connection(): WalletConnectionStatus {
  return {
    connected: true,
    revocationPending: false,
    connectionStatus: "connected",
    scopeChange: null,
    nextAction: "create_spend",
    authorization: {
      known: true,
      scopes: ["payment_methods.agentic"],
      sourceActions: [],
      capabilities: {
        payments: true,
        spendHistory: true,
        paymentMethods: true,
        userInfo: false,
        transactions: false,
      },
      missingPermissions: ["userinfo:read", "read_link_transactions"],
    },
    checkoutAvailable: false,
  };
}

async function openWallet() {
  context.mocks.data.org({ id: "org_1", name: "Test Org", role: "member" });
  await setupPage({
    context,
    path: "/?settings=wallet",
    auth: {
      user: { id: "test-user-123", fullName: "Test User" },
      organization: {
        activeOrg: { id: "org_1", name: "Test Org" },
        memberships: [{ id: "org_1" }],
      },
    },
  });
}

function manageCards(region: HTMLElement) {
  const link = queryAllByRoleFast("link", region).find((element) => {
    return element.textContent?.trim() === "Manage cards";
  });
  if (!link) {
    throw new Error("Missing card management link");
  }
  return link;
}

beforeEach(() => {
  context.mocks.api(walletUserContract.status, ({ respond }) => {
    return respond(200, connection());
  });
  context.mocks.api(walletUserContract.transactions, ({ respond }) => {
    return respond(200, { transactions: [], nextCursor: null });
  });
});

test("shows Link CARD methods with the default first and one management action in a new tab", async () => {
  context.mocks.api(walletUserContract.paymentMethods, ({ respond }) => {
    return respond(200, { data: [business, bank, everyday] });
  });
  await openWallet();
  const region = await screen.findByRole("region", {
    name: "Your cards in Link",
  });
  await within(region).findByText("Everyday");
  const rows = within(region).getAllByRole("listitem");
  expect(rows).toHaveLength(2);
  expect(within(rows[0]!).getByText("Everyday")).toBeInTheDocument();
  expect(within(rows[0]!).getByText("Default")).toBeInTheDocument();
  expect(within(rows[0]!).getByText("Expires 02/2028")).toBeInTheDocument();
  expect(within(rows[0]!).getByRole("presentation")).toHaveAttribute(
    "src",
    expect.stringMatching(/\/card-brands\/visa-[a-f0-9]+\.svg$/u),
  );
  expect(within(rows[1]!).getByText("Business")).toBeInTheDocument();
  expect(within(rows[1]!).getByRole("presentation")).toHaveAttribute(
    "src",
    expect.stringMatching(/\/card-brands\/mastercard-[a-f0-9]+\.svg$/u),
  );
  expect(within(rows[1]!).queryByText("Default")).not.toBeInTheDocument();
  expect(
    within(region).queryByText("Checking account"),
  ).not.toBeInTheDocument();
  expect(queryAllByRoleFast("link", region)).toHaveLength(1);
  expect(queryAllByRoleFast("button", region)).toHaveLength(0);
  expect(manageCards(region)).toHaveAttribute(
    "href",
    "https://app.link.com/wallet",
  );
  expect(manageCards(region)).toHaveAttribute("target", "_blank");
  expect(manageCards(region)).toHaveAttribute("rel", "noopener noreferrer");
});

test("uses the provider name when card details are absent and does not invent a default", async () => {
  context.mocks.api(walletUserContract.paymentMethods, ({ respond }) => {
    return respond(200, {
      data: [
        { ...bank, isDefault: true },
        {
          id: "pm_limited",
          type: "CARD",
          name: "Saved card",
          isDefault: false,
        },
      ],
    });
  });
  await openWallet();
  const region = await screen.findByRole("region", {
    name: "Your cards in Link",
  });
  await within(region).findByText("Saved card");
  expect(within(region).queryByText("Default")).not.toBeInTheDocument();
  expect(within(region).queryByText(/Expires/)).not.toBeInTheDocument();
  expect(within(region).queryByRole("presentation")).not.toBeInTheDocument();
  expect(within(region).getAllByRole("listitem")).toHaveLength(1);
  expect(manageCards(region)).toBeInTheDocument();
});

test("keeps cards usable when the brand is unknown or its artwork fails to load", async () => {
  context.mocks.api(walletUserContract.paymentMethods, ({ respond }) => {
    return respond(200, {
      data: [
        { ...everyday, card: { ...everyday.card!, brand: "VISA" } },
        {
          ...business,
          card: { ...business.card!, brand: "unknown" },
        },
      ],
    });
  });
  await openWallet();
  const region = await screen.findByRole("region", {
    name: "Your cards in Link",
  });
  await within(region).findByText("Everyday");
  const rows = within(region).getAllByRole("listitem");
  const icon = within(rows[0]!).getByRole("presentation");
  expect(icon).toHaveAttribute(
    "src",
    expect.stringMatching(/\/card-brands\/visa-[a-f0-9]+\.svg$/u),
  );
  fireEvent.error(icon);
  expect(icon).not.toBeVisible();
  expect(within(rows[0]!).getByText("Everyday")).toBeInTheDocument();
  expect(within(rows[0]!).getByText("Default")).toBeInTheDocument();
  expect(within(rows[0]!).getByText("Expires 02/2028")).toBeInTheDocument();
  expect(within(rows[1]!).queryByRole("presentation")).not.toBeInTheDocument();
  expect(within(rows[1]!).getByText("Business")).toBeInTheDocument();
  expect(within(rows[1]!).getByText("Expires 08/2029")).toBeInTheDocument();
  expect(manageCards(region)).toBeInTheDocument();
});

test("keeps management available while loading and when the wallet is empty", async () => {
  const pending = context.mocks.deferred<void>();
  context.mocks.api(walletUserContract.paymentMethods, async ({ respond }) => {
    await pending.promise;
    return respond(200, { data: [] });
  });
  await openWallet();
  const region = await screen.findByRole("region", {
    name: "Your cards in Link",
  });
  expect(within(region).getByText("Loading cards")).toBeInTheDocument();
  expect(manageCards(region)).toBeInTheDocument();
  pending.resolve();
  await within(region).findByText("No cards in your Link wallet yet");
  expect(manageCards(region)).toBeInTheDocument();
});

test("keeps cards and transactions on tab return and refreshes both after a wallet change", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const connectionRequested = context.mocks.deferred<void>();
  const connectionPending = context.mocks.deferred<void>();
  const cardsRequested = context.mocks.deferred<void>();
  const transactionsRequested = context.mocks.deferred<void>();
  const listsPending = context.mocks.deferred<void>();
  let refresh = false;
  let requestsAllowed = true;
  context.mocks.api(walletUserContract.status, async ({ respond, never }) => {
    if (!requestsAllowed) {
      return never();
    }
    if (refresh) {
      connectionRequested.resolve();
      await connectionPending.promise;
    }
    const status = connection();
    status.authorization!.capabilities.transactions = true;
    return respond(200, status);
  });
  context.mocks.api(
    walletUserContract.paymentMethods,
    async ({ respond, never }) => {
      if (!requestsAllowed) {
        return never();
      }
      if (refresh) {
        cardsRequested.resolve();
        await listsPending.promise;
      }
      return respond(200, {
        data: refresh ? [{ ...business, isDefault: true }] : [everyday],
      });
    },
  );
  context.mocks.api(walletUserContract.activity, async ({ respond, never }) => {
    if (!requestsAllowed) {
      return never();
    }
    if (refresh) {
      transactionsRequested.resolve();
      await listsPending.promise;
    }
    return respond(200, {
      data: [
        {
          id: "txn_wallet",
          sourceId: null,
          amount: -100,
          currency: "usd",
          date: "2026-10-19",
          description: refresh ? "Updated purchase" : "Recent purchase",
          origin: "link",
          category: null,
          status: "posted",
        },
      ],
      hasMore: false,
      nextCursor: null,
    });
  });
  await openWallet();
  await screen.findByText("Everyday");
  await screen.findByText("Recent purchase");
  requestsAllowed = false;
  await act(() => {
    visibility.changeTo("hidden");
    visibility.changeTo("visible");
    window.dispatchEvent(new Event("focus"));
    return Promise.resolve();
  });
  expect(screen.getByText("Everyday")).toBeInTheDocument();
  expect(screen.getByText("Recent purchase")).toBeInTheDocument();

  requestsAllowed = true;
  refresh = true;
  context.mocks.ably.trigger("wallet:changed", { orgId: "org_1" });
  await connectionRequested.promise;
  expect(screen.getByText("Everyday")).toBeInTheDocument();
  expect(screen.getByText("Recent purchase")).toBeInTheDocument();

  connectionPending.resolve();
  await Promise.all([cardsRequested.promise, transactionsRequested.promise]);
  expect(screen.getByText("Everyday")).toBeInTheDocument();
  expect(screen.getByText("Recent purchase")).toBeInTheDocument();
  listsPending.resolve();
  await screen.findByText("Business");
  await screen.findByText("Updated purchase");
  expect(screen.getByText("Default")).toBeInTheDocument();
  expect(screen.queryByText("Everyday")).not.toBeInTheDocument();
  expect(screen.queryByText("Recent purchase")).not.toBeInTheDocument();
});

test("shows a wallet refresh failure while keeping card management available", async () => {
  const unavailable$ = state(false);
  context.mocks.api(walletUserContract.paymentMethods, ({ respond }) => {
    return context.store.get(unavailable$)
      ? respond(502, {
          error: { code: "BAD_GATEWAY", message: "Link unavailable" },
        })
      : respond(200, { data: [everyday, business] });
  });
  await openWallet();
  const region = await screen.findByRole("region", {
    name: "Your cards in Link",
  });
  await within(region).findByText("Everyday");
  context.store.set(unavailable$, true);
  context.mocks.ably.trigger("wallet:changed", { orgId: "org_1" });
  await within(region).findByText("Couldn’t load your cards.");
  expect(within(region).queryByText("Everyday")).not.toBeInTheDocument();
  expect(manageCards(region)).toBeInTheDocument();
});

test.each(["disconnected", "missing permission", "revocation pending"])(
  "does not fetch or show cards when %s",
  async (reason) => {
    const status = connection();
    if (reason === "disconnected") {
      status.connected = false;
      status.connectionStatus = "not-connected";
    } else if (reason === "missing permission") {
      status.authorization!.capabilities.paymentMethods = false;
    } else {
      status.revocationPending = true;
    }
    context.mocks.api(walletUserContract.status, ({ respond }) => {
      return respond(200, status);
    });
    context.mocks.api(walletUserContract.paymentMethods, ({ never }) => {
      return never();
    });
    await openWallet();
    await screen.findByText("No purchase requests yet");
    expect(
      screen.queryByRole("region", { name: "Your cards in Link" }),
    ).not.toBeInTheDocument();
  },
);

test("hides cards after disconnect even when an earlier refresh completes later", async () => {
  let connected = true;
  let refresh = false;
  const requested = context.mocks.deferred<void>();
  const pending = context.mocks.deferred<void>();
  context.mocks.api(walletUserContract.status, ({ respond }) => {
    const status = connection();
    status.connected = connected;
    status.connectionStatus = connected ? "connected" : "not-connected";
    return respond(200, status);
  });
  context.mocks.api(walletUserContract.paymentMethods, async ({ respond }) => {
    if (refresh) {
      requested.resolve();
      await pending.promise;
    }
    return respond(200, { data: [everyday] });
  });
  await openWallet();
  await screen.findByText("Everyday");
  refresh = true;
  context.mocks.ably.trigger("wallet:changed", { orgId: "org_1" });
  await requested.promise;
  connected = false;
  context.mocks.ably.trigger("wallet:changed", { orgId: "org_1" });
  await waitFor(() => {
    expect(
      queryAllByRoleFast("button").some((element) => {
        return element.textContent?.trim() === "Connect";
      }),
    ).toBeTruthy();
  });
  await act(async () => {
    pending.resolve();
    await pending.promise;
  });
  expect(
    screen.queryByRole("region", { name: "Your cards in Link" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Everyday")).not.toBeInTheDocument();
});
