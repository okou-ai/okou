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
  "%s token setup preserves a newer bot draft",
  async (platform) => {
    const contract =
      platform === "lark" ? larkConnectContract : feishuConnectContract;
    mockFeishu(context, {}, platform);
    const started = context.mocks.deferred<void>();
    const response = context.mocks.deferred<void>();
    const installation: FeishuInstallationStatus = {
      id: "f0000000-0000-4000-a000-000000000001",
      isConnected: true,
      appId: "cli_first_bot",
      callbackUrl: "https://api.okou.test/callback",
      callbackVerified: true,
      messageReceived: false,
      tenantKey: "first-tenant",
      tenantName: "First bot",
      defaultAgentId: null,
      defaultAgentName: "Okou",
      setupCompleted: false,
    };
    context.mocks.api(contract.setup, async ({ respond }) => {
      started.resolve();
      await response.promise;
      const status: FeishuConnectStatus = {
        ...installation,
        installationId: installation.id,
        isAdmin: true,
        isInstalled: true,
        installations: [installation],
      };
      mockFeishu(context, status, platform);
      return respond(200, status);
    });
    await setupFeishuSettingsPage(context, platform);
    click(await screen.findByText("Add bot"));
    click(await findAction("button", "Next"));
    await fill(await screen.findByLabelText("App ID"), "cli_first_bot");
    await fill(screen.getByLabelText("App Secret"), "test-secret");
    click(await findAction("button", "Next"));
    await fill(
      await screen.findByLabelText("Verification Token"),
      "test-token",
    );
    await fill(screen.getByLabelText("Encrypt Key"), "test-key");
    click(getAction("button", "Verify and continue"));
    await started.promise;
    click(getAction("link", `${platform === "lark" ? "Lark" : "Feishu"} bots`));
    await screen.findByRole("heading", {
      name: `${platform === "lark" ? "Lark" : "Feishu"} bots`,
    });
    click(getAction("link", "Add bot"));
    click(await findAction("button", "Next"));
    await fill(screen.getByLabelText("App ID"), "cli_second_draft");
    await fill(screen.getByLabelText("App Secret"), "new-test-secret");
    await act(async () => {
      response.resolve();
      await response.promise;
    });
    expect(screen.getByLabelText("App ID")).toHaveValue("cli_second_draft");
    expect(screen.getByLabelText("App Secret")).toHaveValue("new-test-secret");
  },
);
