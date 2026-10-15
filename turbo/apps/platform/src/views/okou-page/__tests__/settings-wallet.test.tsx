import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import {
  walletUserContract,
  type WalletConnectionStatus,
  type WalletPurchaseHistoryEntry,
} from "@okouai/api-contracts/contracts/wallet";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const authorizationUrl =
  "https://login.link.com/auth?state=wallet-settings-fixture";

async function button(text: string) {
  return await waitFor(() => {
    const result = queryAllByRoleFast("button").find((element) => {
      return element.textContent?.trim() === text;
    });
    if (!result) {
      throw new Error(`Missing button: ${text}`);
    }
    return result;
  });
}

async function menuItem(text: string) {
  const card = screen.getByRole("region", { name: "Link" });
  const trigger = queryAllByRoleFast("button", card).find((element) => {
    return element.getAttribute("aria-label") === "More options";
  });
  if (!trigger) {
    throw new Error("Missing wallet menu");
  }
  click(trigger);
  const menu = await screen.findByRole("menu");
  return await waitFor(() => {
    const item = queryAllByRoleFast("menuitem", menu).find((element) => {
      return element.textContent?.trim() === text;
    });
    if (!item) {
      throw new Error(`Missing menu item: ${text}`);
    }
    return item;
  });
}

beforeEach(() => {
  context.mocks.api(walletUserContract.transactions, ({ respond }) => {
    return respond(200, { transactions: [], nextCursor: null });
  });
});

async function openWallet(
  featureSwitches: Partial<Record<FeatureSwitchKey, boolean>> = {},
) {
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
    featureSwitches: {
      [FeatureSwitchKey.LinkWallet]: true,
      [FeatureSwitchKey.WalletSettings]: true,
      ...featureSwitches,
    },
  });
}

function connection(connected: boolean): WalletConnectionStatus {
  return {
    connected,
    revocationPending: false,
    connectionStatus: connected ? "connected" : "not-connected",
    scopeChange: null,
    nextAction: connected ? ("create_spend" as const) : ("connect" as const),
    checkoutAvailable: false as const,
  };
}

test("lets a member connect their workspace wallet and disconnect after consent completes", async () => {
  let connected = false;
  let disconnects = 0;
  const popup = context.mocks.browser.authWindow();
  Object.defineProperty(popup, "location", {
    configurable: true,
    value: { href: "" },
  });
  const opened = context.mocks.browser.open(popup);
  context.mocks.api(walletUserContract.status, ({ respond }) => {
    return respond(200, connection(connected));
  });
  context.mocks.api(walletUserContract.connect, ({ body, respond }) => {
    expect(body).toStrictEqual({});
    return respond(200, {
      url: authorizationUrl,
      expiresAt: "2026-10-15T10:00:00Z",
    });
  });
  context.mocks.api(walletUserContract.disconnect, ({ body, respond }) => {
    expect(body).toStrictEqual({});
    disconnects++;
    connected = false;
    return respond(200, { disconnected: true });
  });
  await openWallet();
  await expect(
    screen.findByText(
      "Your Link wallet, shared by your agents in this workspace.",
    ),
  ).resolves.toBeInTheDocument();
  click(await button("Connect"));
  await waitFor(() => {
    return expect(popup.location.href).toBe(authorizationUrl);
  });
  expect(opened.calls).toHaveLength(1);
  expect(popup.opener).toBeNull();
  connected = true;
  context.mocks.ably.trigger("wallet:changed", { orgId: "org_1" });
  await screen.findByText("Connected");
  expect(
    queryAllByRoleFast("button").some((element) => {
      return ["Reconnect", "Disconnect"].includes(
        element.textContent?.trim() ?? "",
      );
    }),
  ).toBeFalsy();
  click(await menuItem("Disconnect"));
  await waitFor(() => {
    return expect(disconnects).toBe(1);
  });
  await expect(button("Connect")).resolves.toBeEnabled();
});

test.each([FeatureSwitchKey.LinkWallet, FeatureSwitchKey.WalletSettings])(
  "hides Wallet and its deep link without fetching or subscribing when %s is disabled",
  async (feature) => {
    context.mocks.api(walletUserContract.status, ({ never }) => {
      return never();
    });
    context.mocks.api(walletUserContract.transactions, ({ never }) => {
      return never();
    });
    await openWallet({ [feature]: false });
    await screen.findByRole("dialog");
    expect(
      queryAllByRoleFast("button").some((element) => {
        return element.textContent?.trim() === "Wallet";
      }),
    ).toBeFalsy();
    expect(screen.queryByText("Link")).not.toBeInTheDocument();
    expect(context.mocks.ably.hasSubscription("wallet:changed")).toBeFalsy();
  },
);

test("updates the wallet after a workspace notification", async () => {
  let connected = false;
  context.mocks.api(walletUserContract.status, ({ respond }) => {
    return respond(200, connection(connected));
  });
  await openWallet();
  await expect(button("Connect")).resolves.toBeEnabled();
  context.mocks.ably.trigger("wallet:changed", { orgId: "org_other" });
  connected = true;
  context.mocks.ably.trigger("wallet:changed", { orgId: "org_1" });
  await screen.findByText("Connected");
  await expect(menuItem("Disconnect")).resolves.not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

test.each([false, true])(
  "shows authorization errors and keeps the existing connection when connected=%s",
  async (connected) => {
    context.mocks.browser.open(null);
    context.mocks.api(walletUserContract.status, ({ respond }) => {
      return respond(200, connection(connected));
    });
    context.mocks.api(walletUserContract.connect, ({ never }) => {
      return never();
    });
    await openWallet();
    const label = connected ? "Reconnect" : "Connect";
    click(await (connected ? menuItem(label) : button(label)));
    await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
      "Couldn’t complete the action.",
    );
    const retry = await (connected ? menuItem(label) : button(label));
    expect(retry).toBeEnabled();
    expect(retry).not.toHaveAttribute("aria-disabled", "true");
  },
);

test("reconnects an existing wallet without disconnecting it first", async () => {
  const popup = context.mocks.browser.authWindow();
  Object.defineProperty(popup, "location", {
    configurable: true,
    value: { href: "" },
  });
  context.mocks.browser.open(popup);
  context.mocks.api(walletUserContract.status, ({ respond }) => {
    return respond(200, connection(true));
  });
  context.mocks.api(walletUserContract.connect, ({ respond }) => {
    return respond(200, {
      url: authorizationUrl,
      expiresAt: "2026-10-15T10:00:00Z",
    });
  });
  context.mocks.api(walletUserContract.disconnect, ({ never }) => {
    return never();
  });
  await openWallet();
  click(await menuItem("Reconnect"));
  await waitFor(() => {
    expect(popup.location.href).toBe(authorizationUrl);
  });
  await expect(menuItem("Disconnect")).resolves.not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

test("reviews changed scopes and keeps the warning until new consent completes", async () => {
  let status: WalletConnectionStatus = {
    ...connection(true),
    connectionStatus: "scope-mismatch",
    scopeChange: {
      reason: "permissions_changed",
      addedScopes: ["userinfo:read"],
      removedScopes: ["legacy:read"],
      currentScopes: ["payment_methods.agentic", "userinfo:read"],
      storedScopes: ["payment_methods.agentic", "legacy:read"],
    },
  };
  const popup = context.mocks.browser.authWindow();
  Object.defineProperty(popup, "location", {
    configurable: true,
    value: { href: "" },
  });
  const opened = context.mocks.browser.open(popup);
  context.mocks.api(walletUserContract.status, ({ respond }) => {
    return respond(200, status);
  });
  context.mocks.api(walletUserContract.connect, ({ respond }) => {
    return respond(200, {
      url: authorizationUrl,
      expiresAt: "2026-10-15T10:00:00Z",
    });
  });
  context.mocks.api(walletUserContract.disconnect, ({ never }) => {
    return never();
  });
  await openWallet();
  await screen.findByText("Update permissions");
  click(await button("Review permissions"));
  await screen.findByRole("dialog", { name: "Link permissions update" });
  expect(screen.getByText("userinfo:read")).toBeVisible();
  expect(screen.getByText("legacy:read")).toBeVisible();
  click(await button("Close"));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Link permissions update" }),
    ).not.toBeInTheDocument();
  });
  expect(opened.calls).toHaveLength(0);
  click(await button("Review permissions"));
  click(await button("Reconnect"));
  await waitFor(() => {
    expect(popup.location.href).toBe(authorizationUrl);
  });
  expect(screen.getByText("Update permissions")).toBeVisible();
  status = connection(true);
  context.mocks.ably.trigger("wallet:changed", { orgId: "org_1" });
  await waitFor(() => {
    expect(screen.queryByText("Update permissions")).not.toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });
});

test.each([
  [
    "workspace_scope_changed",
    "Your Link wallet now works across your agents in this workspace. Reconnect to approve this change.",
  ],
  [
    "permissions_unknown",
    "Reconnect Link to review and confirm its current permissions.",
  ],
] as const)(
  "explains %s before requesting new consent",
  async (reason, description) => {
    context.mocks.api(walletUserContract.status, ({ respond }) => {
      return respond(200, {
        ...connection(false),
        connectionStatus: "scope-mismatch",
        scopeChange: {
          reason,
          addedScopes: [],
          removedScopes: [],
          currentScopes: ["payment_methods.agentic", "userinfo:read"],
          storedScopes: [],
        },
      });
    });
    context.mocks.api(walletUserContract.connect, ({ never }) => {
      return never();
    });
    await openWallet();
    click(await button("Review permissions"));
    await screen.findByRole("dialog", { name: "Link permissions update" });
    expect(screen.getByText(description)).toBeVisible();
    await expect(button("Reconnect")).resolves.toBeEnabled();
  },
);

test("offers reconnect for an expired authorization instead of a first-time connection", async () => {
  context.mocks.api(walletUserContract.status, ({ respond }) => {
    return respond(200, {
      ...connection(false),
      connectionStatus: "reconnect-required",
    });
  });
  await openWallet();
  await screen.findByText("Reconnect required");
  await expect(menuItem("Reconnect")).resolves.not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(
    queryAllByRoleFast("menuitem").some((item) => {
      return item.textContent?.trim() === "Disconnect";
    }),
  ).toBeTruthy();
});

test("offers Disconnect for a previously unfinished provider revocation", async () => {
  let pending = true;
  context.mocks.api(walletUserContract.status, ({ respond }) => {
    return respond(200, { ...connection(false), revocationPending: pending });
  });
  context.mocks.api(walletUserContract.disconnect, ({ respond }) => {
    pending = false;
    return respond(200, { disconnected: true });
  });
  await openWallet();
  click(await menuItem("Disconnect"));
  await expect(button("Connect")).resolves.toBeEnabled();
});

function transaction(
  overrides: Partial<WalletPurchaseHistoryEntry> = {},
): WalletPurchaseHistoryEntry {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    merchantName: "Example Books",
    amount: 3500,
    currency: "usd",
    status: "approved",
    test: false,
    createdAt: "2026-10-15T03:00:00Z",
    ...overrides,
  };
}

test("shows purchase amounts and distinct approval/payment states, paginates, and retains history when disconnected", async () => {
  const first = transaction();
  const second = transaction({
    id: "00000000-0000-4000-8000-000000000002",
    merchantName: "Example Stationery",
    status: "succeeded",
    test: true,
  });
  context.mocks.api(walletUserContract.status, ({ respond }) => {
    return respond(200, connection(false));
  });
  context.mocks.api(walletUserContract.transactions, ({ query, respond }) => {
    return respond(
      200,
      query.cursor
        ? { transactions: [second], nextCursor: null }
        : { transactions: [first], nextCursor: first.id },
    );
  });
  await openWallet();
  const list = await screen.findByRole("region", { name: "Link transactions" });
  await within(list).findByText("Example Books");
  expect(within(list).getByText("$35.00")).toBeInTheDocument();
  expect(
    within(list).getByText("Approved, awaiting payment"),
  ).toBeInTheDocument();
  await expect(button("Connect")).resolves.toBeEnabled();
  click(await button("Next"));
  await within(list).findByText("Example Stationery");
  expect(within(list).getByText("Payment succeeded")).toBeInTheDocument();
  expect(within(list).getByText("Test")).toBeInTheDocument();
  expect(within(list).queryByText("Example Books")).not.toBeInTheDocument();
  await expect(button("Next")).resolves.toBeDisabled();
  click(await button("Previous"));
  await within(list).findByText("Example Books");
  expect(
    within(list).queryByText("Example Stationery"),
  ).not.toBeInTheDocument();
});

test("shows a transaction error separately from connection status and retries to an empty list", async () => {
  let fail = true;
  context.mocks.api(walletUserContract.status, ({ respond }) => {
    return respond(200, connection(true));
  });
  context.mocks.api(walletUserContract.transactions, ({ respond }) => {
    return fail
      ? respond(403, { error: { code: "FORBIDDEN", message: "Unavailable" } })
      : respond(200, { transactions: [], nextCursor: null });
  });
  await openWallet();
  const list = await screen.findByRole("region", { name: "Link transactions" });
  await within(list).findByText("Couldn’t load transactions. Try again.");
  expect(screen.getByText("Connected")).toBeInTheDocument();
  expect(
    within(list).queryByText("No Link transactions yet"),
  ).not.toBeInTheDocument();
  fail = false;
  click(await button("Retry"));
  await within(list).findByText("No Link transactions yet");
});

test("opens scope review from the reconnect menu without starting consent immediately", async () => {
  const opened = context.mocks.browser.open(context.mocks.browser.authWindow());
  context.mocks.api(walletUserContract.status, ({ respond }) => {
    return respond(200, {
      ...connection(true),
      connectionStatus: "scope-mismatch",
      scopeChange: {
        reason: "permissions_changed",
        addedScopes: ["userinfo:read"],
        removedScopes: [],
        currentScopes: ["userinfo:read"],
        storedScopes: [],
      },
    });
  });
  await openWallet();
  await screen.findByText("Update permissions");
  click(await menuItem("Reconnect"));
  await screen.findByRole("dialog", { name: "Link permissions update" });
  expect(screen.getByText("userinfo:read")).toBeInTheDocument();
  expect(opened.calls).toHaveLength(0);
  click(await button("Close"));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Link permissions update" }),
    ).not.toBeInTheDocument();
  });
  expect(screen.getByText("Update permissions")).toBeInTheDocument();
  await waitFor(() => {
    expect(document.activeElement).toHaveAttribute(
      "aria-label",
      "More options",
    );
  });
});
