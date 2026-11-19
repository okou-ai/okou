import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import {
  walletUserContract,
  type WalletConnectionStatus,
} from "@okouai/api-contracts/contracts/wallet";
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
  context.mocks.api(walletUserContract.paymentMethods, ({ respond }) => {
    return respond(200, { data: [] });
  });
  context.mocks.api(walletUserContract.transactions, ({ respond }) => {
    return respond(200, { transactions: [], nextCursor: null });
  });
});

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

function connection(connected: boolean): WalletConnectionStatus {
  return {
    connected,
    revocationPending: false,
    connectionStatus: connected ? "connected" : "not-connected",
    scopeChange: null,
    nextAction: connected ? ("create_spend" as const) : ("connect" as const),
    authorization: {
      known: connected,
      scopes: connected ? ["payment_methods.agentic"] : [],
      sourceActions: [],
      capabilities: {
        payments: connected,
        spendHistory: connected,
        paymentMethods: connected,
        userInfo: false,
        transactions: false,
      },
      missingPermissions: connected
        ? ["userinfo:read", "read_link_transactions"]
        : [
            "payment_methods.agentic",
            "userinfo:read",
            "read_link_transactions",
          ],
    },
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
    screen.findByText("Let Okou make purchases and view your Link activity."),
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

test.each(["not-connected"] as readonly (
  "not-connected" | "connected" | "scope-mismatch" | "reconnect-required"
)[])(
  "shows authorization errors and allows retry when connectionStatus=%s",
  async (connectionStatus) => {
    context.mocks.browser.open(null);
    context.mocks.api(walletUserContract.status, ({ respond }) => {
      return respond(200, {
        ...connection(
          connectionStatus === "connected" ||
            connectionStatus === "scope-mismatch",
        ),
        connectionStatus,
      });
    });
    context.mocks.api(walletUserContract.connect, ({ never }) => {
      return never();
    });
    await openWallet();
    const label =
      connectionStatus === "not-connected" ? "Connect" : "Reconnect";
    const inMenu = connectionStatus === "connected";
    click(await (inMenu ? menuItem(label) : button(label)));
    await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
      "Couldn’t complete the action.",
    );
    const retry = await (inMenu ? menuItem(label) : button(label));
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

test("reconnects changed scopes directly and keeps the warning until new consent completes", async () => {
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
  expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  expect(screen.queryByText("Review permissions")).not.toBeInTheDocument();
  click(await button("Reconnect"));
  await waitFor(() => {
    expect(popup.location.href).toBe(authorizationUrl);
  });
  expect(opened.calls).toHaveLength(1);
  expect(screen.getByText("Update permissions")).toBeInTheDocument();
  expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  status = connection(true);
  context.mocks.ably.trigger("wallet:changed", { orgId: "org_1" });
  await waitFor(() => {
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });
  expect(screen.queryByText("Update permissions")).not.toBeInTheDocument();
  expect(
    queryAllByRoleFast("button").some((element) => {
      return element.textContent?.trim() === "Reconnect";
    }),
  ).toBeFalsy();
});

test("reconnects an expired authorization directly from its status", async () => {
  const popup = context.mocks.browser.authWindow();
  Object.defineProperty(popup, "location", {
    configurable: true,
    value: { href: "" },
  });
  context.mocks.browser.open(popup);
  context.mocks.api(walletUserContract.status, ({ respond }) => {
    return respond(200, {
      ...connection(false),
      connectionStatus: "reconnect-required",
    });
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
  await screen.findByText("Reconnect required");
  click(await button("Reconnect"));
  await waitFor(() => {
    expect(popup.location.href).toBe(authorizationUrl);
  });
  expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  expect(screen.getByText("Reconnect required")).toBeInTheDocument();
  await expect(menuItem("Disconnect")).resolves.not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(
    queryAllByRoleFast("menuitem").some((item) => {
      return item.textContent?.trim() === "Reconnect";
    }),
  ).toBeFalsy();
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

test("shows a transaction error separately from connection status", async () => {
  context.mocks.api(walletUserContract.status, ({ respond }) => {
    return respond(200, connection(true));
  });
  context.mocks.api(walletUserContract.transactions, ({ respond }) => {
    return respond(403, {
      error: { code: "FORBIDDEN", message: "Unavailable" },
    });
  });
  await openWallet();
  const list = await screen.findByRole("region", { name: "Link transactions" });
  await within(list).findByText("Couldn’t load transactions.");
  expect(screen.getByText("Connected")).toBeInTheDocument();
  expect(
    within(list).queryByText("No Link transactions yet"),
  ).not.toBeInTheDocument();
});
