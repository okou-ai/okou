import { test, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { integrationsWechatContract } from "@okouai/api-contracts/contracts/integrations-wechat";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  findAction,
  getIntegrationCard,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
test("integrations-wechat-005 Escape returns focus to the keyboard connection trigger", async () => {
  const id = crypto.randomUUID();
  context.mocks.api(integrationsWechatContract.status, ({ respond }) => {
    return respond(200, {
      configured: true,
      status: "disconnected",
      binding: null,
    });
  });
  context.mocks.api(integrationsWechatContract.connect, ({ respond }) => {
    return respond(200, {
      id,
      qrContent: "weixin://harbor-consent",
      expiresAt: "2099-04-12T12:00:00.000Z",
    });
  });
  context.mocks.api(integrationsWechatContract.poll, ({ body, respond }) => {
    return body.id === id
      ? respond(200, { status: "verification_required" })
      : respond(404, {
          error: { code: "NOT_FOUND", message: "Unknown attempt" },
        });
  });
  context.mocks.api(integrationsWechatContract.cancel, ({ respond }) => {
    return respond(204);
  });
  await setupPage({
    context,
    path: "/works",
    featureSwitches: {
      [FeatureSwitchKey.WechatIntegration]: true,
      [FeatureSwitchKey.WorksChannelCards]: false,
    },
  });
  const connect = await findAction(
    "button",
    "Connect",
    getIntegrationCard("WeChat"),
  );
  connect.focus();
  const keyboard = userEvent.setup({ delay: null });
  await keyboard.keyboard("{Enter}");
  await expect(
    screen.findByText("Enter the verification code shown in WeChat."),
  ).resolves.toBeInTheDocument();
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  await keyboard.keyboard("{Escape}");
  await waitFor(() => {
    return expect(connect).toHaveFocus();
  });
  expect(screen.queryByRole("dialog")).toBeNull();
});
