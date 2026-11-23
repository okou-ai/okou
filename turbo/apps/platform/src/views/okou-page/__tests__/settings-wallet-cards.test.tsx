import {
  walletUserContract,
  type WalletPaymentMethod,
} from "@okouai/api-contracts/contracts/wallet";
import { fireEvent, screen, within, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findAction,
  getAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";
import { linkStatus, serveWallet } from "./wallet-settings-test-helpers.ts";

const context = testContext();
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

test("Returning to Link activity keeps the old purchase until its own refresh completes", async () => {
  serveWallet(context, () => {
    return linkStatus("connected");
  });
  const cardRead = context.mocks.deferred<void>(),
    cardDelivery = context.mocks.deferred<void>();
  const activityRead = context.mocks.deferred<void>(),
    activityDelivery = context.mocks.deferred<void>();
  let changed = false;
  context.mocks.api(walletUserContract.paymentMethods, async ({ respond }) => {
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
  });
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
  cardDelivery.resolve();
  await screen.findByText("Business");
  const cards = screen.getByRole("list", { name: "Your cards in Link" });
  expect(within(cards).getByRole("listitem")).toHaveTextContent("Default");
  expect(screen.queryByText("Everyday")).toBeNull();
  expect(screen.getByText("Recent purchase")).toBeVisible();
  activityDelivery.resolve();
  await screen.findByText("Updated purchase");
  expect(screen.queryByText("Recent purchase")).toBeNull();
});
