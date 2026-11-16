import {
  feishuConnectContract,
  larkConnectContract,
  type FeishuConnectStatus,
  type FeishuInstallationStatus,
} from "@okouai/api-contracts/contracts/feishu-connect";
import { act, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getAction,
  findAction,
  mockFeishu,
  setupFeishuSettingsPage,
} from "./connector-integrations-test-helpers.ts";
const context = testContext();

test.each(["feishu", "lark"] as const)(
  "%s setup completion preserves a newer bot draft and its page",
  async (platform) => {
    const contract =
      platform === "lark" ? larkConnectContract : feishuConnectContract;
    const installation: FeishuInstallationStatus = {
      id: "f0000000-0000-4000-a000-000000000001",
      isConnected: false,
      connectUrl: `https://api.okou.test/api/${platform}/oauth/connect?state=old-installation`,
      appId: "cli_first_bot",
      callbackUrl: "https://api.okou.test/callback",
      callbackVerified: true,
      oauthRedirectUrl: "https://app.okou.test/callback",
      messageReceived: true,
      tenantKey: "first-tenant",
      tenantName: "First bot",
      defaultAgentId: null,
      defaultAgentName: "Okou",
      setupCompleted: false,
    };
    const status: FeishuConnectStatus = {
      ...installation,
      installationId: installation.id,
      isAdmin: true,
      isInstalled: true,
      installations: [installation],
    };
    mockFeishu(context, status, platform);
    const started = context.mocks.deferred<void>();
    const response = context.mocks.deferred<void>();
    context.mocks.api(contract.updateInstallation, async ({ respond }) => {
      started.resolve();
      await response.promise;
      return respond(200, { ...installation, setupCompleted: true });
    });
    await setupFeishuSettingsPage(context, platform);
    const setupUrl = `/settings/${platform}/setup/${installation.id}`;
    await screen.findByText("First bot");
    click(getAction("button", "More options for First bot"));
    click(getAction("link", "Manage"));
    await screen.findByText("Configure the OAuth redirect URL");
    click(await findAction("button", "Next"));
    click(await findAction("button", "Next"));
    click(await findAction("button", "Next"));
    await screen.findByText("Publish the app");
    click(getAction("button", "Done"));
    await started.promise;
    click(getAction("link", `${platform === "lark" ? "Lark" : "Feishu"} bots`));
    await screen.findByRole("heading", {
      name: `${platform === "lark" ? "Lark" : "Feishu"} bots`,
    });
    click(getAction("button", "More options for First bot"));
    click(getAction("link", "Manage"));
    click(await findAction("button", "Back"));
    click(await findAction("button", "Back"));
    await fill(screen.getByLabelText("App Secret"), "new-test-secret");
    await act(async () => {
      response.resolve();
      await response.promise;
    });
    expect(new URL(window.location.href).pathname).toBe(setupUrl);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("App Secret")).toHaveValue("new-test-secret");
  },
);
