import {
  walletUserContract,
  type WalletConnectionStatus,
} from "@okouai/api-contracts/contracts/wallet";
import { screen, waitFor, within } from "@testing-library/react";
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
