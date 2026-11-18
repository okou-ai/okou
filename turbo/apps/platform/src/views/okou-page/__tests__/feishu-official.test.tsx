import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { feishuOfficialContract } from "@okouai/api-contracts/contracts/feishu-official";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  click,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  mockFeishu,
  getAction,
  queryAction,
  findAction,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
function setup(enabled = true) {
  mockFeishu(context, { isAdmin: true });
  return setupPage({
    context,
    path: "/settings/feishu",
    featureSwitches: {
      [FeatureSwitchKey.FeishuIntegration]: true,
      [FeatureSwitchKey.FeishuOfficialBot]: enabled,
    },
  });
}
function mockOfficial(isConfigured: boolean, isConnected = false) {
  context.mocks.api(feishuOfficialContract.getStatus, ({ respond }) => {
    return respond(200, {
      isConfigured,
      isConnected,
      connectedUserName: isConnected ? "Official User" : null,
      installationId: null,
    });
  });
}

describe("official Feishu connection", () => {
  it("keeps the Official entry hidden until the feature is enabled", async () => {
    await setup(false);
    expect(screen.queryByRole("region", { name: "Okou Official" })).toBeNull();
    await expect(findAction("link", "Add bot")).resolves.toBeInTheDocument();
  });

  it("shows a disabled Connect while the new app is not configured", async () => {
    mockOfficial(false);
    await setup();
    const official = await screen.findByRole("region", {
      name: "Okou Official",
    });
    expect(getAction("button", "Connect", official)).toBeDisabled();
    expect(queryAllByRoleFast("link", official)).toHaveLength(0);
    expect(queryAllByRoleFast("button", official)).toHaveLength(1);
  });

  it("opens Official authorization without entering the custom setup wizard", async () => {
    mockOfficial(true);
    const popup = context.mocks.browser.authWindow();
    const replace = vi.fn<(url: string) => void>();
    Object.defineProperty(popup, "location", {
      configurable: true,
      value: { replace },
    });
    const opened = context.mocks.browser.open(popup);
    context.mocks.api(feishuOfficialContract.connect, ({ respond }) => {
      return respond(200, {
        authorizationUrl:
          "https://api.okou.test/api/feishu/oauth/connect?state=official",
      });
    });
    await setup();
    const official = await screen.findByRole("region", {
      name: "Okou Official",
    });
    click(getAction("button", "Connect", official));
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(
        "https://api.okou.test/api/feishu/oauth/connect?state=official",
      );
    });
    expect(opened.calls[0]?.url).toBe("about:blank");
    expect(getAction("link", "Add bot")).toBeInTheDocument();
    expect(screen.queryByLabelText("App secret")).toBeNull();
  });

  it("disconnects the current Official account and preserves custom setup", async () => {
    let connected = true;
    context.mocks.api(feishuOfficialContract.getStatus, ({ respond }) => {
      return respond(200, {
        isConfigured: true,
        isConnected: connected,
        connectedUserName: connected ? "Official User" : null,
        installationId: null,
      });
    });
    context.mocks.api(feishuOfficialContract.disconnect, ({ respond }) => {
      connected = false;
      return respond(200, { success: true });
    });
    await setup();
    const official = await screen.findByRole("region", {
      name: "Okou Official",
    });
    expect(within(official).getByText("Official User")).toBeInTheDocument();
    click(getAction("button", "Disconnect", official));
    await expect(
      findAction("button", "Connect", official),
    ).resolves.toBeEnabled();
    expect(getAction("link", "Add bot")).toBeInTheDocument();
  });
  it("offers Official Connect independently of custom bot setup", async () => {
    mockOfficial(true);
    await setupPage({
      context,
      path: "/settings/feishu",
      featureSwitches: {
        [FeatureSwitchKey.FeishuIntegration]: false,
        [FeatureSwitchKey.FeishuOfficialBot]: true,
      },
    });
    const official = await screen.findByRole("region", {
      name: "Okou Official",
    });
    expect(getAction("button", "Connect", official)).toBeEnabled();
    expect(queryAction("link", "Add bot")).toBeNull();
  });
  it("explains how to continue when the browser blocks the authorization tab", async () => {
    mockOfficial(true);
    context.mocks.browser.open(null);
    await setup();
    const official = await screen.findByRole("region", {
      name: "Okou Official",
    });
    click(getAction("button", "Connect", official));
    await expect(
      within(official).findByText(
        "Allow pop-ups to connect your Feishu account.",
      ),
    ).resolves.toBeInTheDocument();
    expect(getAction("button", "Connect", official)).toBeEnabled();
  });
});
