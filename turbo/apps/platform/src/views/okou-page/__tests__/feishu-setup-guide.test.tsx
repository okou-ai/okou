import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { pathname } from "../../../signals/location.ts";
import type { FeishuInstallationStatus } from "@okouai/api-contracts/contracts/feishu-connect";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getAction,
  queryAction,
  findAction,
  mockFeishu,
  setupFeishuSettingsPage,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();

test.each(["feishu", "lark"] as const)(
  "%s screenshots and secret controls preserve the current draft",
  async (platform) => {
    const user = userEvent.setup({ delay: null });
    mockFeishu(context, {}, platform);
    await setupFeishuSettingsPage(context, platform);
    click(await screen.findByText("Add bot"));
    click(await findAction("button", "Next"));
    const appId = await screen.findByLabelText("App ID");
    const secret = screen.getByLabelText("App Secret");
    await fill(appId, "cli_draft");
    await fill(secret, "draft-secret");
    click(getAction("button", "Show App Secret"));
    expect(secret).toHaveAttribute("type", "text");

    click(getAction("button", "View setup reference"));
    expect(appId).toHaveValue("cli_draft");
    click(getAction("button", "Back to fields"));
    expect(secret).toHaveValue("draft-secret");

    expect(pathname()).toBe(`/settings/${platform}/setup`);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "Sidebar" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Chat threads" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("feishu-guide-canvas")).toHaveAttribute(
      "data-zoomable-image-canvas",
      "true",
    );
    await expect(findAction("button", "Zoom in")).resolves.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(secret).toHaveValue("draft-secret");
    expect(appId).toHaveValue("cli_draft");

    click(getAction("link", `${platform === "lark" ? "Lark" : "Feishu"} bots`));
    await screen.findByRole("heading", {
      name: `${platform === "lark" ? "Lark" : "Feishu"} bots`,
    });
    expect(pathname()).toBe(`/settings/${platform}`);
    click(getAction("link", "Add bot"));
    click(await findAction("button", "Next"));
    await expect(screen.findByLabelText("App Secret")).resolves.toHaveValue("");
    expect(screen.getByLabelText("App Secret")).toHaveAttribute(
      "type",
      "password",
    );
  },
);

test.each(["feishu", "lark"] as const)(
  "%s review guide switches screenshots without changing the setup step",
  async (platform) => {
    const installation: FeishuInstallationStatus = {
      id: "f0000000-0000-4000-a000-000000000001",
      appId: "cli_review",
      isConnected: false,
      callbackUrl: "https://api.okou.test/callback",
      callbackVerified: true,
      messageReceived: false,
      tenantKey: "review-tenant",
      tenantName: "Review bot",
      defaultAgentId: null,
      defaultAgentName: "Okou",
      setupCompleted: true,
    };
    mockFeishu(
      context,
      { isInstalled: true, installations: [installation] },
      platform,
    );
    await setupFeishuSettingsPage(context, platform);
    await screen.findByText("Review bot");
    click(getAction("button", "More options for Review bot"));
    click(getAction("link", "Review guide"));
    await screen.findByText("Create an Agent app");
    for (let index = 0; index < 4; index++) {
      click(await findAction("button", "Next"));
    }
    await screen.findByText("Import app and user scopes");
    click(getAction("radio", "2. Paste the JSON and review new scopes"));
    await expect(
      screen.findByRole("img", {
        name: "Feishu Batch import/export scopes dialog with the imported JSON and review button highlighted",
      }),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText("Image 2 of 2")).toBeInTheDocument();
    const json = screen.getByTestId("feishu-scope-import-json");
    const details = json.closest("details");
    if (!details) {
      throw new Error("Expected expandable permission JSON");
    }
    click(within(details).getByText("View permission JSON"));
    expect(json).toBeVisible();
    expect(json.textContent).toContain('"tenant"');
    expect(json.textContent).toContain('"user"');
    click(await findAction("button", "Next"));
    await screen.findByText("Configure event delivery");
    expect(screen.getByText("Image 1 of 2")).toBeInTheDocument();
  },
);

test.each(["feishu", "lark"] as const)(
  "%s setup deep links preserve admin access",
  async (platform) => {
    mockFeishu(context, { isAdmin: false }, platform);
    await setupPage({
      context,
      path: `/settings/${platform}/setup`,
      featureSwitches: {
        [platform === "lark"
          ? FeatureSwitchKey.LarkIntegration
          : FeatureSwitchKey.FeishuIntegration]: true,
      },
    });
    await screen.findByText(
      `An organization admin must configure the app. You can connect your own account from the ${platform === "lark" ? "Lark" : "Feishu"} bot list after setup is complete.`,
    );
    expect(queryAction("button", "Next")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  },
);

test.each(["feishu", "lark"] as const)(
  "%s setup links cannot bypass its feature switch",
  async (platform) => {
    await setupPage({
      context,
      path: `/settings/${platform}/setup`,
      featureSwitches: {
        [FeatureSwitchKey.FeishuIntegration]: platform !== "feishu",
        [FeatureSwitchKey.LarkIntegration]: platform !== "lark",
      },
    });
    expect(pathname()).not.toBe(`/settings/${platform}/setup`);
    expect(screen.queryByText("Create an Agent app")).not.toBeInTheDocument();
  },
);

test.each(["feishu", "lark"] as const)(
  "%s setup does not substitute another bot for a missing installation",
  async (platform) => {
    mockFeishu(context, {}, platform);
    await setupPage({
      context,
      path: `/settings/${platform}/setup/f0000000-0000-4000-a000-000000000099`,
      featureSwitches: {
        [platform === "lark"
          ? FeatureSwitchKey.LarkIntegration
          : FeatureSwitchKey.FeishuIntegration]: true,
      },
    });
    await screen.findByRole("heading", {
      name: `${platform === "lark" ? "Lark" : "Feishu"} bots`,
    });
    expect(pathname()).toBe(`/settings/${platform}`);
    expect(screen.queryByLabelText("App Secret")).not.toBeInTheDocument();
  },
);
