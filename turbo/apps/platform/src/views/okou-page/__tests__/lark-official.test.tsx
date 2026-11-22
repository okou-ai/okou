import { larkOfficialContract } from "@okouai/api-contracts/contracts/lark-official";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect, vi } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage, click } from "../../../__tests__/page-helper.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import { botWorkspace } from "./provider-bot-fixtures.ts";
const context = testContext();
async function settings(custom: boolean, connected = false) {
  const installationId = crypto.randomUUID();
  botWorkspace(context, "lark", true, () => {
    return [];
  });
  context.mocks.api(larkOfficialContract.getStatus, ({ respond }) => {
    return respond(200, {
      isConfigured: true,
      isConnected: connected,
      connectedUserName: connected ? "Official User" : null,
      installationId: connected ? installationId : null,
    });
  });
  context.mocks.api(larkOfficialContract.disconnect, ({ respond }) => {
    connected = false;
    return respond(200, { success: true });
  });
  await setupPage({
    context,
    path: "/settings/lark",
    host: "app.okou.ai",
    auth: {
      user: { id: "user_harbor", fullName: "Harbor reader" },
      session: { token: "harbor-admin" },
    },
    featureSwitches: {
      [FeatureSwitchKey.WorksChannelCards]: false,
      [FeatureSwitchKey.LarkIntegration]: custom,
      [FeatureSwitchKey.LarkOfficialBot]: true,
    },
  });
  await screen.findByRole("region", { name: "Okou" });
}
test("lark-official-004 keyboard reopening the official account menu allows disconnect", async () => {
  await settings(true, true);
  await screen.findByText("Official User");
  const menu = await findFastControl("button", "More options for Okou");
  click(menu);
  await findFastControl("button", "Disconnect");
  await userEvent.keyboard("{Escape}");
  expect(queryFastControl("button", "Disconnect")).toBeNull();
  expect(menu).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  click(await findFastControl("button", "Disconnect"));
  await expect(findFastControl("button", "Connect")).resolves.toBeEnabled();
  await expect(findFastControl("link", "Add bot")).resolves.toBeEnabled();
});
test("lark-official-005 the official connection is available independently of custom bots", async () => {
  await settings(false);
  await expect(findFastControl("button", "Connect")).resolves.toBeEnabled();
  expect(queryFastControl("link", "Add bot")).toBeNull();
});
test("lark-official-006 a blocked authorization window leaves the official connection retryable", async () => {
  vi.spyOn(window, "open").mockReturnValue(null);
  await settings(false);
  const connect = await findFastControl("button", "Connect");
  click(connect);
  await screen.findByText("Allow pop-ups to connect your Lark account.");
  expect(connect).toBeEnabled();
});
