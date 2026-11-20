import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { larkOfficialContract } from "@okouai/api-contracts/contracts/lark-official";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  mockFeishu,
  getAction,
  queryAction,
  findAction,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
function setup(enabled = true) {
  mockFeishu(context, { isAdmin: true }, "lark");
  return setupPage({
    context,
    path: "/settings/lark",
    featureSwitches: {
      [FeatureSwitchKey.LarkIntegration]: true,
      [FeatureSwitchKey.LarkOfficialBot]: enabled,
    },
  });
}
function mockOfficial(isConfigured: boolean, isConnected = false) {
  context.mocks.api(larkOfficialContract.getStatus, ({ respond }) => {
    return respond(200, {
      isConfigured,
      isConnected,
      connectedUserName: isConnected ? "Official User" : null,
      installationId: null,
    });
  });
}

describe("official Lark connection", () => {
  it("disconnects the current Official account through its options menu", async () => {
    let connected = true;
    context.mocks.api(larkOfficialContract.getStatus, ({ respond }) => {
      return respond(200, {
        isConfigured: true,
        isConnected: connected,
        connectedUserName: connected ? "Official User" : null,
        installationId: null,
      });
    });
    context.mocks.api(larkOfficialContract.disconnect, ({ respond }) => {
      connected = false;
      return respond(200, { success: true });
    });
    await setup();
    const official = await screen.findByRole("region", {
      name: "Okou",
    });
    expect(within(official).getByText("Official User")).toBeInTheDocument();
    const user = userEvent.setup();
    const menu = getAction("button", "More options for Okou", official);
    await user.click(menu);
    await findAction("button", "Disconnect");
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(queryAction("button", "Disconnect")).toBeNull();
      expect(menu).toHaveFocus();
    });
    await user.keyboard("{Enter}");
    const disconnect = await findAction("button", "Disconnect");
    click(disconnect);
    await expect(
      findAction("button", "Connect", official),
    ).resolves.toBeEnabled();
    expect(getAction("link", "Add bot")).toBeInTheDocument();
  });

  it("offers Official Connect independently of custom bot setup", async () => {
    mockOfficial(true);
    await setupPage({
      context,
      path: "/settings/lark",
      featureSwitches: {
        [FeatureSwitchKey.LarkIntegration]: false,
        [FeatureSwitchKey.LarkOfficialBot]: true,
      },
    });
    const official = await screen.findByRole("region", {
      name: "Okou",
    });
    expect(getAction("button", "Connect", official)).toBeEnabled();
    expect(queryAction("link", "Add bot")).toBeNull();
  });

  it("explains how to continue when the browser blocks the authorization tab", async () => {
    mockOfficial(true);
    context.mocks.browser.open(null);
    await setup();
    const official = await screen.findByRole("region", {
      name: "Okou",
    });
    click(getAction("button", "Connect", official));
    await expect(
      within(official).findByText(
        "Allow pop-ups to connect your Lark account.",
      ),
    ).resolves.toBeInTheDocument();
    expect(getAction("button", "Connect", official)).toBeEnabled();
  });
});
