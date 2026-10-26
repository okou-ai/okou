import {
  feishuConnectContract,
  larkConnectContract,
  type FeishuConnectStatus,
  type FeishuInstallationStatus,
} from "@okouai/api-contracts/contracts/feishu-connect";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getAction,
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
    const settingsUrl = window.location.href;
    await screen.findByText("First bot");
    click(getAction("button", "More options for First bot"));
    click(getAction("button", "Manage"));
    await screen.findByText("Configure the OAuth redirect URL");
    click(getAction("button", "Next"));
    click(getAction("button", "Next"));
    click(getAction("button", "Next"));
    await screen.findByText("Publish the app");
    click(getAction("button", "Done"));
    await started.promise;
    click(getAction("button", "Close", screen.getByRole("dialog")));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    click(getAction("button", "More options for First bot"));
    click(getAction("button", "Manage"));
    click(getAction("button", "Back"));
    click(getAction("button", "Back"));
    await fill(screen.getByLabelText("App Secret"), "new-test-secret");
    response.resolve();
    await screen.findByText(
      `${platform === "lark" ? "Lark" : "Feishu"} bot installed successfully`,
    );
    expect(window.location.href).toBe(settingsUrl);
    await expect(screen.findByRole("dialog")).resolves.toBeInTheDocument();
    expect(screen.getByLabelText("App Secret")).toHaveValue("new-test-secret");
  },
);
