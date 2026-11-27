import {
  walletUserContract,
  type WalletConnectionStatus,
  type WalletPaymentMethod,
} from "@okouai/api-contracts/contracts/wallet";
import { screen, waitFor, within, fireEvent } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import {
  click,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findAction,
  queryAction,
  getAction,
} from "./connector-integrations-test-helpers.ts";
import { linkStatus, serveWallet } from "./wallet-settings-test-helpers.ts";

const context = testContext();

const newConsent = "https://link.example.test/consent/new-wallet";
const renewConsent = "https://link.example.test/consent/existing-wallet";
function localWallet(initial: WalletConnectionStatus) {
  let status = initial;
  serveWallet(context, () => {
    return status;
  });
  context.mocks.api(walletUserContract.connect, ({ respond }) => {
    return respond(200, {
      url:
        status.connectionStatus === "not-connected" ? newConsent : renewConsent,
      expiresAt: "2030-01-07T12:00:00Z",
    });
  });
  context.mocks.api(walletUserContract.disconnect, ({ respond }) => {
    status = linkStatus("not-connected");
    return respond(200, { disconnected: true });
  });
  const windows: Window[] = [];
  vi.spyOn(window, "open").mockImplementation(() => {
    const popup = context.mocks.browser.authWindow();
    Object.defineProperty(popup, "location", { value: new URL("about:blank") });
    popup.opener = window;
    windows.push(popup);
    return popup;
  });
  return {
    windows,
    completeConsent() {
      status = linkStatus("connected");
      context.mocks.ably.trigger("wallet:changed", { orgId: "org_default" });
    },
  };
}
async function visitWallet() {
  await setupPage({ context, path: "/?settings=wallet" });
  return screen.findByRole("region", { name: "Link" });
}
async function walletMenu(region: HTMLElement) {
  const trigger = await findAction("button", "More options", region);
  await waitFor(() => {
    return expect(trigger).toBeEnabled();
  });
  click(trigger);
  return screen.findByRole("menu");
}
function menuItem(menu: HTMLElement, label: string) {
  return queryAllByRoleFast("menuitem", menu).find((item) => {
    return item.textContent?.trim() === label;
  });
}

test("settings-wallet-001 consent in a single isolated window connects the wallet until the member disconnects", async () => {
  const link = localWallet(linkStatus("not-connected"));
  const region = await visitWallet();
  click(await findAction("button", "Connect", region));
  await waitFor(() => {
    return expect(link.windows[0]?.location.href).toBe(newConsent);
  });
  expect(link.windows[0]?.opener).toBeNull();
  link.completeConsent();
  await expect(
    within(region).findByText("Connected"),
  ).resolves.toBeInTheDocument();
  expect(within(region).queryByText("Reconnect")).toBeNull();
  expect(within(region).queryByText("Disconnect")).toBeNull();
  const menu = await walletMenu(region);
  click(within(menu).getByText("Disconnect"));
  await waitFor(() => {
    return expect(queryAction("button", "Connect", region)).toBeEnabled();
  });
  expect(link.windows).toHaveLength(1);
});
test("settings-wallet-003 a blocked popup leaves a retryable Connect action beside an alert", async () => {
  serveWallet(context, () => {
    return linkStatus("not-connected");
  });
  context.mocks.browser.open(null);
  const region = await visitWallet();
  click(await findAction("button", "Connect", region));
  await expect(within(region).findByRole("alert")).resolves.toHaveTextContent(
    "Couldn’t complete the action.",
  );
  expect(queryAction("button", "Connect", region)).toBeEnabled();
});
test("settings-wallet-007 reconnecting from the wallet menu keeps the existing authorization available", async () => {
  const link = localWallet(linkStatus("connected"));
  const region = await visitWallet();
  await within(region).findByText("Connected");
  click(within(await walletMenu(region)).getByText("Reconnect"));
  await waitFor(() => {
    return expect(link.windows[0]?.location.href).toBe(renewConsent);
  });
  expect(within(region).getByText("Connected")).toBeInTheDocument();
  expect(menuItem(await walletMenu(region), "Disconnect")).toBeDefined();
});
test("settings-wallet-008 the permission warning stays until the member’s workspace confirms consent", async () => {
  const link = localWallet(linkStatus("scope-mismatch"));
  const region = await visitWallet();
  await within(region).findByText("Update permissions");
  click(await findAction("button", "Reconnect", region));
  await waitFor(() => {
    return expect(link.windows[0]?.location.href).toBe(renewConsent);
  });
  expect(within(region).getByText("Update permissions")).toBeInTheDocument();
  expect(within(region).queryByText("Connected")).toBeNull();
  expect(within(region).queryByText("Review permissions")).toBeNull();
  link.completeConsent();
  await within(region).findByText("Connected");
  expect(within(region).queryByText("Update permissions")).toBeNull();
  expect(queryAction("button", "Reconnect", region)).toBeNull();
});
test("settings-wallet-009 expired Link access opens consent directly and keeps only disconnection in the menu", async () => {
  const link = localWallet(linkStatus("reconnect-required"));
  const region = await visitWallet();
  click(await findAction("button", "Reconnect", region));
  await waitFor(() => {
    return expect(link.windows[0]?.location.href).toBe(renewConsent);
  });
  expect(within(region).getByText("Reconnect required")).toBeInTheDocument();
  expect(within(region).queryByText("Connected")).toBeNull();
  const menu = await walletMenu(region);
  expect(menuItem(menu, "Disconnect")).toBeDefined();
  expect(menuItem(menu, "Reconnect")).toBeUndefined();
});
test("settings-wallet-010 completing an unfinished revocation restores the Connect action", async () => {
  localWallet(linkStatus("not-connected", true));
  const region = await visitWallet();
  const menu = await walletMenu(region);
  click(within(menu).getByText("Disconnect"));
  await expect(findAction("button", "Connect", region)).resolves.toBeEnabled();
});
test("settings-wallet-012 forbidden activity displays an error while the wallet stays connected", async () => {
  serveWallet(context, () => {
    return linkStatus("connected");
  });
  context.mocks.api(walletUserContract.activity, ({ respond }) => {
    return respond(403, {
      error: { code: "FORBIDDEN", message: "Link history access denied" },
    });
  });
  const region = await visitWallet();
  const history = await screen.findByRole("region", {
    name: "Link transactions",
  });
  await expect(within(history).findByRole("alert")).resolves.toHaveTextContent(
    "Couldn’t load transactions.",
  );
  expect(within(history).queryByText("No Link transactions yet")).toBeNull();
  expect(within(region).getByText("Connected")).toBeInTheDocument();
});

test("realtime-011 Link settings refresh on subscription, handle the member event, and recover missed changes", async () => {
  const source = context.mocks.ably;
  const channel = "user:test-user-123";
  const topic = "wallet:changed";
  const subscription = source.deferSubscribeOnChannel(channel, topic);
  let status = linkStatus("not-connected");
  serveWallet(context, () => {
    return status;
  });
  await setupPage({
    context,
    path: "/?settings=wallet",
  });
  const region = await screen.findByRole("region", { name: "Link" });
  await findAction("button", "Connect", region);
  await subscription.started;

  status = linkStatus("scope-mismatch");
  subscription.attach();
  await within(region).findByText("Update permissions");
  status = linkStatus("connected");
  source.triggerOnChannel(channel, topic, { orgId: "org_default" });
  await within(region).findByText("Connected");

  source.triggerConnectionState("suspended");
  status = linkStatus("reconnect-required");
  source.triggerConnectionState("connected");
  await expect(
    within(region).findByText("Reconnect required"),
  ).resolves.toBeInTheDocument();
});

function bank(isDefault: boolean): WalletPaymentMethod {
  return {
    id: "checking",
    type: "BANK_ACCOUNT",
    name: "Branch checking",
    isDefault,
  };
}
function card(
  id: string,
  name: string,
  brand: string,
  last4: string,
  isDefault = false,
): WalletPaymentMethod {
  return { id, type: "CARD", name, isDefault, cardSummary: { brand, last4 } };
}
async function cardsList(methods: WalletPaymentMethod[]) {
  serveWallet(
    context,
    () => {
      return linkStatus("connected");
    },
    methods,
  );
  await setupPage({ context, path: "/?settings=wallet" });
  return screen.findByRole("list", { name: "Your cards in Link" });
}
function manageCards() {
  const section = screen.getByRole("region", { name: "Your cards in Link" });
  return getAction("link", "Manage cards", section);
}
test("settings-wallet-cards-001 Link puts the default Visa before the Mastercard and offers safe external management", async () => {
  const list = await cardsList([
    card("travel", "Travel card", "mastercard", "9051"),
    bank(false),
    card("daily", "Daily card", "visa", "7412", true),
  ]);
  const names = within(list).getAllByRole("listitem");
  expect(names).toHaveLength(2);
  const [first, second] = names;
  expect(first).toHaveTextContent("Daily card");
  expect(first).toHaveTextContent("Default");
  expect(first).toHaveTextContent("visa ···· 7412");
  expect(within(first!).getByAltText("")).toHaveAttribute(
    "src",
    expect.stringMatching(/\/visa-[^/]+\.svg$/u),
  );
  expect(second).toHaveTextContent("Travel card");
  expect(second).toHaveTextContent("mastercard ···· 9051");
  expect(within(second!).getByAltText("")).toHaveAttribute(
    "src",
    expect.stringMatching(/\/mastercard-[^/]+\.svg$/u),
  );
  expect(within(list).queryByText("Branch checking")).toBeNull();
  const section = screen.getByRole("region", { name: "Your cards in Link" });
  expect(
    within(section).getByText("Manage cards", { selector: "a" }),
  ).toHaveAttribute("href", "https://app.link.com/wallet");
  expect(manageCards()).toHaveAttribute("target", "_blank");
  expect(manageCards()).toHaveAttribute(
    "rel",
    expect.stringContaining("noopener"),
  );
  expect(manageCards()).toHaveAttribute(
    "rel",
    expect.stringContaining("noreferrer"),
  );
  expect(queryAction("button", "Manage cards", section)).toBeNull();
});
test("settings-wallet-cards-002 a default bank account supplies neither a card badge nor artwork for a card missing details", async () => {
  const list = await cardsList([
    bank(true),
    { id: "pending", type: "CARD", name: "Card from issuer", isDefault: false },
  ]);
  const row = within(list).getByRole("listitem");
  expect(row).toHaveTextContent("Card from issuer");
  expect(within(list).queryByText("Default")).toBeNull();
  expect(within(list).queryByAltText("")).toBeNull();
  expect(manageCards()).toHaveAttribute("href", "https://app.link.com/wallet");
});
test("settings-wallet-cards-003 a failed Visa image and an unfamiliar brand keep the identifying card details readable", async () => {
  const list = await cardsList([
    card("home", "Home expenses", "VISA", "3981", true),
    card("club", "Club card", "North Club", "2117"),
  ]);
  const [home, club] = within(list).getAllByRole("listitem");
  const image = within(home!).getByAltText("");
  expect(image).toBeVisible();
  fireEvent.error(image);
  expect(image).not.toBeVisible();
  expect(home).toHaveTextContent("Home expenses");
  expect(home).toHaveTextContent("VISA ···· 3981");
  expect(within(home!).getByText("Default")).toBeVisible();
  expect(club).toHaveTextContent("Club card");
  expect(club).toHaveTextContent("North Club ···· 2117");
  expect(within(club!).queryByAltText("")).toBeNull();
  expect(manageCards()).toHaveAttribute("href", "https://app.link.com/wallet");
});

test.each([
  ["settings-wallet-cards-010", "release"],
  ["Withheld control", "withhold"],
] as const)(
  "%s %s the old card inventory after the wallet is disconnected",
  async (_label, delivery) => {
    let connected = true;
    let refreshing = false;
    const pending = context.mocks.deferred<void>();
    const release = context.mocks.deferred<void>();
    const consumed = context.mocks.deferred<void>();
    serveWallet(context, () => {
      return linkStatus(connected ? "connected" : "not-connected");
    });
    context.mocks.api(walletUserContract.disconnect, ({ respond }) => {
      connected = false;
      return respond(200, { disconnected: true });
    });
    const staleCard = card(
      "closed-card",
      "Card from the previous wallet",
      "VISA",
      "5148",
    );
    context.mocks.api(
      walletUserContract.paymentMethods,
      async ({ respond }) => {
        if (!refreshing) {
          return respond(200, {
            data: [card("daily", "Everyday", "VISA", "7108")],
          });
        }
        pending.resolve();
        await release.promise;
        return respond(200, { data: [staleCard] });
      },
    );
    const original = Response.prototype.json;
    vi.spyOn(Response.prototype, "json").mockImplementation(async function (
      this: Response,
    ) {
      const value: unknown = await original.call(this);
      if (
        this.url.endsWith(walletUserContract.paymentMethods.path) &&
        JSON.stringify(value).includes(staleCard.id)
      ) {
        consumed.resolve();
      }
      return value;
    });
    await setupPage({ context, path: "/?settings=wallet" });
    await screen.findByText("Everyday");
    refreshing = true;
    context.mocks.ably.trigger("wallet:changed", { orgId: "org_default" });
    await pending.promise;
    const link = screen.getByRole("region", { name: "Link" });
    click(await findAction("button", "More options", link));
    click(within(await screen.findByRole("menu")).getByText("Disconnect"));
    const connect = await findAction("button", "Connect", link);
    if (delivery === "release") {
      release.resolve();
      await consumed.promise;
    }
    await waitFor(() => {
      return expect(connect).toBeEnabled();
    });
    expect(
      screen.queryByRole("region", { name: "Your cards in Link" }),
    ).toBeNull();
    expect(screen.queryByText("Everyday")).toBeNull();
    expect(screen.queryByText(staleCard.name)).toBeNull();
  },
);

test.each(["activity", "cards"] as const)(
  "settings-wallet-cards-005 Returning to Link activity preserves each unchanged section while %s refreshes first",
  async (first) => {
    serveWallet(context, () => {
      return linkStatus("connected");
    });
    const cardRead = context.mocks.deferred<void>(),
      cardDelivery = context.mocks.deferred<void>();
    const activityRead = context.mocks.deferred<void>(),
      activityDelivery = context.mocks.deferred<void>();
    let changed = false;
    context.mocks.api(
      walletUserContract.paymentMethods,
      async ({ respond }) => {
        if (changed) {
          if (!cardRead.settled()) {
            cardRead.resolve();
          }
          await cardDelivery.promise;
        }
        return respond(200, {
          data: [
            changed
              ? card("business", "Business", "VISA", "4491", true)
              : card("everyday", "Everyday", "VISA", "3871"),
          ],
        });
      },
    );
    context.mocks.api(walletUserContract.activity, async ({ respond }) => {
      if (changed) {
        if (!activityRead.settled()) {
          activityRead.resolve();
        }
        await activityDelivery.promise;
      }
      return respond(200, {
        data: [
          {
            id: changed ? "supplies" : "market",
            sourceId: null,
            amount: 2150,
            currency: "usd",
            date: "2026-09-18",
            description: changed ? "Updated purchase" : "Recent purchase",
            origin: "link",
            category: null,
            status: "succeeded",
          },
        ],
        hasMore: false,
        nextCursor: null,
      });
    });
    const visibility = context.mocks.browser.visibilityState("visible");
    await setupPage({ context, path: "/?settings=wallet" });
    await screen.findByText("Everyday");
    await screen.findByText("Recent purchase");
    visibility.changeTo("hidden");
    fireEvent.blur(window);
    visibility.changeTo("visible");
    fireEvent.focus(window);
    expect(screen.getByText("Everyday")).toBeVisible();
    expect(screen.getByText("Recent purchase")).toBeVisible();
    changed = true;
    context.mocks.ably.trigger("wallet:changed", { orgId: "org_default" });
    await Promise.all([cardRead.promise, activityRead.promise]);
    expect(screen.getByText("Everyday")).toBeVisible();
    expect(screen.getByText("Recent purchase")).toBeVisible();
    const activityFirst = first === "activity";
    const firstReply = activityFirst ? activityDelivery : cardDelivery;
    const lastReply = activityFirst ? cardDelivery : activityDelivery;
    firstReply.resolve();
    await screen.findByText(activityFirst ? "Updated purchase" : "Business");
    expect(
      screen.getByText(activityFirst ? "Everyday" : "Recent purchase"),
    ).toBeVisible();
    expect(
      screen.queryByText(activityFirst ? "Business" : "Updated purchase"),
    ).toBeNull();
    lastReply.resolve();
    await screen.findByText("Updated purchase");
    await screen.findByText("Business");
    const cards = screen.getByRole("list", { name: "Your cards in Link" });
    expect(within(cards).getByRole("listitem")).toHaveTextContent("Default");
    expect(screen.queryByText("Everyday")).toBeNull();
    expect(screen.queryByText("Recent purchase")).toBeNull();
  },
);
