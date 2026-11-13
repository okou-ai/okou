import type { FeishuInstallationStatus } from "@okouai/api-contracts/contracts/feishu-connect";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  "%s screenshots and secret controls preserve the current draft",
  async (platform) => {
    const user = userEvent.setup({ delay: null });
    mockFeishu(context, {}, platform);
    await setupFeishuSettingsPage(context, platform);
    click(await screen.findByText("Add bot"));
    click(getAction("button", "Next"));
    const appId = await screen.findByLabelText("App ID");
    const secret = screen.getByLabelText("App Secret");
    await fill(appId, "cli_draft");
    await fill(secret, "draft-secret");
    click(getAction("button", "Show App Secret"));
    expect(secret).toHaveAttribute("type", "text");

    click(getAction("radio", "Full screenshot"));
    expect(getAction("radio", "Full screenshot")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(secret).toHaveValue("draft-secret");
    expect(appId).toHaveValue("cli_draft");
    const trigger = getAction("button", "Enlarge screenshot");
    await user.click(trigger);
    const preview = await screen.findByRole("dialog", {
      name: "Add the app credentials",
    });
    expect(
      within(preview).getByRole("img", {
        name: "Feishu app creation result showing where to find the App ID and App Secret",
      }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    const setupDialog = await screen.findByRole("dialog", {
      name: platform === "feishu" ? "Add a Feishu bot" : "Add a Lark bot",
    });
    expect(secret).toHaveValue("draft-secret");
    expect(trigger).toHaveFocus();

    click(getAction("button", "Close"));
    await waitFor(() => {
      expect(setupDialog).not.toBeInTheDocument();
    });
    click(getAction("button", "Add bot"));
    click(getAction("button", "Next"));
    await expect(screen.findByLabelText("App Secret")).resolves.toHaveValue("");
    expect(screen.getByLabelText("App Secret")).toHaveAttribute(
      "type",
      "password",
    );
    expect(getAction("radio", "Key area")).toHaveAttribute(
      "aria-checked",
      "true",
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
    click(getAction("button", "Review guide"));
    await screen.findByText("Create an Agent app");
    for (let index = 0; index < 4; index++) {
      click(getAction("button", "Next"));
    }
    await screen.findByText("Import app and user scopes");
    click(getAction("radio", "2. Paste the JSON and review new scopes"));
    expect(
      screen.getByRole("img", {
        name: "Feishu Batch import/export scopes dialog with the imported JSON and review button highlighted",
      }),
    ).toBeInTheDocument();
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
    click(getAction("button", "Next"));
    await screen.findByText("Configure event delivery");
    expect(screen.getByText("Image 1 of 2")).toBeInTheDocument();
  },
);
