import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { walletUserContract } from "@okouai/api-contracts/contracts/wallet";
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

async function openWallet(enabled = true) {
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
    featureSwitches: { [FeatureSwitchKey.LinkWallet]: enabled },
  });
}

function connection(connected: boolean) {
  return {
    connected,
    revocationPending: false,
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
  click(await button("Disconnect"));
  await waitFor(() => {
    return expect(disconnects).toBe(1);
  });
  await expect(button("Connect")).resolves.toBeEnabled();
});

test("does not show Wallet or fetch its connection when the feature is disabled", async () => {
  context.mocks.api(walletUserContract.status, ({ never }) => {
    return never();
  });
  await openWallet(false);
  await screen.findByRole("dialog");
  expect(
    queryAllByRoleFast("button").some((element) => {
      return element.textContent?.trim() === "Wallet";
    }),
  ).toBeFalsy();
  expect(screen.queryByText("Link")).not.toBeInTheDocument();
});

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
  await expect(button("Disconnect")).resolves.toBeEnabled();
});

test("keeps Connect available after a blocked authorization window", async () => {
  context.mocks.browser.open(null);
  context.mocks.api(walletUserContract.status, ({ respond }) => {
    return respond(200, connection(false));
  });
  context.mocks.api(walletUserContract.connect, ({ never }) => {
    return never();
  });
  await openWallet();
  click(await button("Connect"));
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Couldn’t complete the action.",
  );
  await expect(button("Connect")).resolves.toBeEnabled();
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
  click(await button("Disconnect"));
  await expect(button("Connect")).resolves.toBeEnabled();
});
