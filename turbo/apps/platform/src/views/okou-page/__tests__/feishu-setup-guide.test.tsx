import { test, expect } from "vitest";
import { screen } from "@testing-library/react";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";
import {
  installation,
  botWorkspace,
  visitProvider,
} from "./provider-bot-fixtures.ts";
import {
  platformFeishuPermissionsScopesBatchImportMenuImg,
  platformFeishuPermissionsScopesBatchImportReviewImg,
  platformFeishuEventSubscriptionModeImg,
} from "../../../lib/static-assets.ts";

const context = testContext();

test.each([
  ["feishu-setup-guide-003", "feishu"],
  ["feishu-setup-guide-004", "lark"],
] as const)(
  "%s reviews the scope reference and resets the selected screenshot on step changes",
  async (_id, provider) => {
    const bot = installation(provider);
    botWorkspace(context, provider, true, () => {
      return [bot];
    });
    await visitProvider(
      context,
      provider,
      "/settings/" + provider + "/setup/" + bot.id,
    );
    click(await findAction("button", "Permissions"));
    const menuImage =
      /Scopes page with the Batch import\/export scopes menu highlighted/u;
    await expect(screen.findByAltText(menuImage)).resolves.toHaveAttribute(
      "src",
      platformFeishuPermissionsScopesBatchImportMenuImg,
    );
    click(await screen.findByText("2. Paste the JSON and review new scopes"));
    await expect(
      screen.findByAltText(
        /dialog with the imported JSON and review button highlighted/u,
      ),
    ).resolves.toHaveAttribute(
      "src",
      platformFeishuPermissionsScopesBatchImportReviewImg,
    );
    click(screen.getByText("View permission JSON"));
    const block = screen.getByText(/"scopes"\s*:/u, { selector: "code" });
    expect(block).toBeVisible();
    const scopes = JSON.parse(block.textContent ?? "null") as {
      scopes: { tenant: string[]; user: string[] };
    };
    expect(scopes.scopes.tenant).toContain("im:message:readonly");
    expect(scopes.scopes.user).toContain("offline_access");
    click(await findAction("button", "Next"));
    await expect(
      screen.findByText("Configure event delivery"),
    ).resolves.toBeInTheDocument();
    await expect(
      screen.findByAltText(
        /Event Configuration screen with the subscription mode edit control highlighted/u,
      ),
    ).resolves.toHaveAttribute("src", platformFeishuEventSubscriptionModeImg);
    click(await findAction("button", "Permissions"));
    await expect(screen.findByAltText(menuImage)).resolves.toHaveAttribute(
      "src",
      platformFeishuPermissionsScopesBatchImportMenuImg,
    );
  },
);

test("feishu-setup-guide-005 a member opening setup gets the workspace administrator and account connection guidance", async () => {
  botWorkspace(context, "feishu", false, () => {
    return [];
  });
  await visitProvider(context, "feishu", "/settings/feishu/setup", "member");
  await expect(
    screen.findByText(
      "An organization admin must configure the app. You can connect your own account from the Feishu bot list after setup is complete.",
    ),
  ).resolves.toBeInTheDocument();
  expect(queryAction("button", "Next")).toBeNull();
});
