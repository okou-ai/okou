import { expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { integrationsWechatContract as contract } from "@okouai/api-contracts/contracts/integrations-wechat";
import { setupPage, click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getIntegrationCard,
  getAction,
} from "./connector-integrations-test-helpers.ts";
const context = testContext();
const id = "00000000-0000-4000-8000-000000000001";
const attempt = Object.freeze({
  id,
  qrContent: "https://weixin.qq.com/qr-test",
  expiresAt: "2099-01-01T00:00:00.000Z",
});
const setup = () => {
  return setupPage({
    context,
    path: "/works",
    featureSwitches: { [FeatureSwitchKey.WechatIntegration]: true },
  });
};
test("WeChat is hidden with its feature disabled", async () => {
  await setupPage({
    context,
    path: "/works",
    featureSwitches: { [FeatureSwitchKey.WechatIntegration]: false },
  });
  expect(screen.queryByText("WeChat")).not.toBeInTheDocument();
});
test("Connect displays a QR and an expired code can be replaced", async () => {
  let attempts = 0;
  context.mocks.api(contract.status, ({ respond }) => {
    return respond(200, { configured: true, status: "disconnected" });
  });
  context.mocks.api(contract.connect, ({ respond }) => {
    attempts++;
    return respond(200, attempt);
  });
  context.mocks.api(contract.poll, ({ respond }) => {
    return respond(200, { status: "expired" });
  });
  await setup();
  await click(getAction("button", "Connect", getIntegrationCard("WeChat")));
  await expect(screen.findByRole("dialog")).resolves.toHaveTextContent(
    "Scan this QR code with WeChat",
  );
  await expect(
    screen.findByText("This QR code expired. Create a new one."),
  ).resolves.toBeInTheDocument();
  await click(getAction("button", "Create a new QR code"));
  await waitFor(() => {
    expect(attempts).toBe(2);
  });
});
test("a scan requiring verification keeps the QR and shows a code field", async () => {
  context.mocks.api(contract.status, ({ respond }) => {
    return respond(200, { configured: true, status: "disconnected" });
  });
  context.mocks.api(contract.connect, ({ respond }) => {
    return respond(200, attempt);
  });
  context.mocks.api(contract.poll, ({ respond }) => {
    return respond(200, { status: "verification_required" });
  });
  await setup();
  await click(getAction("button", "Connect", getIntegrationCard("WeChat")));
  await expect(
    screen.findByTestId("wechat-connect-qr"),
  ).resolves.toBeInTheDocument();
  await expect(
    screen.findByRole("textbox", { name: "Verification code" }),
  ).resolves.toBeInTheDocument();
  expect(getAction("button", "Verify")).toBeDisabled();
});
