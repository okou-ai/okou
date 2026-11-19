import {
  type FeishuConnectStatus,
  larkConnectContract,
} from "@okouai/api-contracts/contracts/feishu-connect";
import { larkOfficialContract } from "@okouai/api-contracts/contracts/lark-official";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getAction,
  mockFeishu,
  queryAction,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();

function channelCard(name: string): HTMLElement {
  return getAction("link", name);
}

test("Works distinguishes Feishu and Lark connection states on the same page", async () => {
  mockFeishu(context, {
    isInstalled: true,
    isConnected: true,
    appId: "cli_feishu",
    tenantName: "Acme Feishu",
  });
  const larkReads: FeishuConnectStatus[] = [];
  context.mocks.api(larkConnectContract.getStatus, ({ respond }) => {
    const status: FeishuConnectStatus = {
      isConnected: false,
      isInstalled: false,
      isAdmin: true,
      appId: null,
      callbackUrl: null,
      callbackVerified: false,
      messageReceived: false,
      tenantKey: null,
      tenantName: null,
      defaultAgentId: null,
      defaultAgentName: "Okou",
    };
    larkReads.push(status);
    return respond(200, status);
  });

  await setupPage({
    context,
    path: "/works",
    featureSwitches: {
      [FeatureSwitchKey.WorksChannelCards]: true,
      [FeatureSwitchKey.FeishuIntegration]: true,
      [FeatureSwitchKey.LarkIntegration]: true,
      [FeatureSwitchKey.LarkOfficialBot]: false,
    },
  });

  await waitFor(() => {
    expect(channelCard("Feishu: Manage")).toHaveTextContent("Connected");
  });
  expect(larkReads).toHaveLength(1);
  const lark = channelCard("Lark: Connect");
  expect(lark).not.toHaveTextContent("Connected");
  expect(channelCard("Feishu: Manage")).toHaveAttribute(
    "href",
    "/settings/feishu",
  );
  expect(lark).toHaveAttribute("href", "/settings/lark");
});

test("Works recognizes an official Lark connection without a custom bot", async () => {
  mockFeishu(context, { isInstalled: false, isConnected: false }, "lark");
  context.mocks.api(larkOfficialContract.getStatus, ({ respond }) => {
    return respond(200, {
      isConfigured: true,
      isConnected: true,
      connectedUserName: "Ada Lovelace",
      installationId: "77777777-7777-4777-8777-777777777777",
    });
  });

  await setupPage({
    context,
    path: "/works",
    featureSwitches: {
      [FeatureSwitchKey.WorksChannelCards]: true,
      [FeatureSwitchKey.FeishuIntegration]: false,
      [FeatureSwitchKey.LarkIntegration]: true,
      [FeatureSwitchKey.LarkOfficialBot]: true,
    },
  });

  await waitFor(() => {
    expect(channelCard("Lark: Manage")).toHaveTextContent("Connected");
  });
  expect(queryAction("link", "Lark: Connect")).toBeNull();
});
