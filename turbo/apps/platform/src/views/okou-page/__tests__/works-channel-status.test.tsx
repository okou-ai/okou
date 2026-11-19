import { larkOfficialContract } from "@okouai/api-contracts/contracts/lark-official";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { within } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findAction,
  getIntegrationCard,
  mockFeishu,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();

test("Works distinguishes Feishu and Lark connection states on the same page", async () => {
  mockFeishu(context, { isConnected: true, isInstalled: true }, "feishu");
  mockFeishu(context, { isConnected: false }, "lark");
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
  await expect(findAction("link", "Feishu: Manage")).resolves.toHaveAttribute(
    "href",
    "/settings/feishu",
  );
  expect(
    within(getIntegrationCard("Feishu")).getByText("Connected"),
  ).toBeInTheDocument();
  await expect(findAction("link", "Lark: Connect")).resolves.toHaveAttribute(
    "href",
    "/settings/lark",
  );
});

test("Works recognizes an official Lark connection without a custom bot", async () => {
  context.mocks.api(larkOfficialContract.getStatus, ({ respond }) => {
    return respond(200, {
      isConfigured: true,
      isConnected: true,
      connectedUserName: "Avery",
      installationId: "00000000-0000-4000-8000-000000000001",
    });
  });
  await setupPage({
    context,
    path: "/works",
    featureSwitches: {
      [FeatureSwitchKey.WorksChannelCards]: true,
      [FeatureSwitchKey.LarkIntegration]: false,
      [FeatureSwitchKey.LarkOfficialBot]: true,
    },
  });
  await expect(findAction("link", "Lark: Manage")).resolves.toHaveAttribute(
    "href",
    "/settings/lark",
  );
  expect(
    within(getIntegrationCard("Lark")).getByText("Connected"),
  ).toBeInTheDocument();
});

test("Works keeps the original Teams installation action and copy with cards off", async () => {
  await setupPage({
    context,
    path: "/works",
    featureSwitches: { [FeatureSwitchKey.WorksChannelCards]: false },
  });
  const card = getIntegrationCard("Microsoft Teams");
  await expect(
    findAction("button", "Install in Teams", card),
  ).resolves.toBeEnabled();
  expect(card).toHaveTextContent(
    "Connect your Microsoft account to finish setup",
  );
});
