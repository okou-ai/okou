import { larkConnectContract } from "@okouai/api-contracts/contracts/feishu-connect";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getAction,
  mockFeishu,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();

function settingsLink() {
  const link = queryAllByRoleFast("link").find((item) => {
    return item.getAttribute("href") === "/settings/lark";
  });
  if (!link) {
    throw new Error("Expected Lark settings link");
  }
  return link;
}

test("Lark has an independent integration card and guided setup", async () => {
  mockFeishu(context, {}, "lark");
  await setupPage({
    context,
    path: "/works",
    featureSwitches: {
      [FeatureSwitchKey.LarkIntegration]: true,
      [FeatureSwitchKey.FeishuIntegration]: false,
    },
  });
  click(await waitFor(settingsLink));
  await expect(screen.findByText("Lark bots")).resolves.toBeInTheDocument();
  click(await screen.findByText("Add bot"));
  await expect(
    screen.findByText("Create an enterprise custom app"),
  ).resolves.toBeInTheDocument();
  const consoleLink = getAction("link", "Lark developer console");
  expect(consoleLink).toHaveAttribute("href", "https://open.larksuite.com/app");
  expect(getAction("link", "Download the optional Okou icon")).toHaveAttribute(
    "download",
    "okou-lark-app-icon.png",
  );
  click(getAction("button", "Next"));
  await expect(screen.findByLabelText("App ID")).resolves.toBeInTheDocument();
  expect(screen.getByLabelText("App Secret")).toBeInTheDocument();
  let checkedAppId: string | undefined;
  context.mocks.api(larkConnectContract.checkAppId, ({ query, respond }) => {
    checkedAppId = query.appId;
    return respond(200, { available: true });
  });
  await fill(screen.getByLabelText("App ID"), "cli_lark");
  await fill(screen.getByLabelText("App Secret"), "lark-test-secret");
  click(getAction("button", "Next"));
  await expect(
    screen.findByLabelText("Encrypt Key"),
  ).resolves.toBeInTheDocument();
  expect(checkedAppId).toBe("cli_lark");
});

test("enabling Feishu does not expose Lark", async () => {
  mockFeishu(context, {}, "lark");
  await setupPage({
    context,
    path: "/works",
    featureSwitches: {
      [FeatureSwitchKey.FeishuIntegration]: true,
      [FeatureSwitchKey.LarkIntegration]: false,
    },
  });
  await expect(screen.findByText("Feishu")).resolves.toBeInTheDocument();
  expect(
    queryAllByRoleFast("link").some((item) => {
      return item.getAttribute("href") === "/settings/lark";
    }),
  ).toBeFalsy();
});

test("the Lark settings page reads only Lark installations", async () => {
  mockFeishu(context, {}, "lark");
  let requestedLark = false;
  context.mocks.api(larkConnectContract.getStatus, ({ respond }) => {
    requestedLark = true;
    return respond(200, {
      publicBrand: "okou",
      platform: "lark",
      isAdmin: true,
      isInstalled: false,
      isConnected: false,
      appId: null,
      callbackUrl: null,
      callbackVerified: false,
      messageReceived: false,
      tenantKey: null,
      tenantName: null,
      defaultAgentId: null,
      defaultAgentName: "Okou",
      installations: [],
    });
  });
  await setupPage({
    context,
    path: "/settings/lark",
    featureSwitches: {
      [FeatureSwitchKey.LarkIntegration]: true,
      [FeatureSwitchKey.FeishuIntegration]: false,
    },
  });
  await expect(screen.findByText("Lark bots")).resolves.toBeInTheDocument();
  expect(requestedLark).toBeTruthy();
});
