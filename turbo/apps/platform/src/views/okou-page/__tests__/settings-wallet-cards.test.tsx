import type { WalletPaymentMethod } from "@okouai/api-contracts/contracts/wallet";
import { fireEvent, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
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
