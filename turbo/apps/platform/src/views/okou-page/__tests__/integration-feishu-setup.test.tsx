import { test, expect } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { feishuBrowserConnectContract } from "@okouai/api-contracts/contracts/feishu-browser-connect";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  setupPage,
  startPage,
  click,
  fill,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";
import userEvent from "@testing-library/user-event";
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

function messageLink(provider: string) {
  const signed = {
    installationId: crypto.randomUUID(),
    openId: provider + "-member-24",
    chatId: provider + "-group-7",
    sig: "proof+17/=",
    ts: 1_780_000_123,
  };
  const path =
    "/settings/" +
    provider +
    "?" +
    new URLSearchParams({
      connect: "account",
      ...signed,
      ts: String(signed.ts),
    });
  return { path, signed };
}

test("feishu-connect-flow-001 signing in preserves the entire signed message link", async () => {
  const { path } = messageLink("feishu");
  await startPage({ context, path, auth: null, host: "app.okou.ai" });
  await waitFor(() => {
    return expect(location.pathname).toBe("/sign-in");
  });
  expect(new URL(location.href).searchParams.get("redirect_url")).toBe(
    new URL(path, "https://app.okou.ai").href,
  );
});

test.each([
  ["feishu-connect-flow-002", "feishu", "applink.feishu.cn"],
  ["feishu-connect-flow-009", "lark", "applink.larksuite.com"],
] as const)(
  "%s connects the signed message identity with the integration disabled",
  async (_id, provider, host) => {
    const { path, signed } = messageLink(provider);
    const target = "https://" + host + "/client/chat/open?id=crew-17";
    const browser = context.mocks.browser.locationAssign();
    const submissions: unknown[] = [];
    context.mocks.api(
      feishuBrowserConnectContract.connectFromApp,
      ({ body, request, respond }) => {
        submissions.push({
          body,
          bearer: request.headers.get("authorization"),
        });
        return respond(200, {
          success: true,
          botName: "Survey",
          openUrl: target,
        });
      },
    );
    await startPage({
      context,
      path,
      auth: {
        user: { id: "shore-" + provider, fullName: "Shore member" },
        session: { token: provider + "-session" },
      },
      featureSwitches: {
        [FeatureSwitchKey.FeishuIntegration]: false,
        [FeatureSwitchKey.LarkIntegration]: false,
      },
    });
    await waitFor(() => {
      return expect(browser.calls).toContain(target);
    });
    expect(submissions).toContainEqual({
      body: signed,
      bearer: "Bearer " + provider + "-session",
    });
  },
);

test.each([
  ["feishu-connect-flow-003", "Feishu", "expired"],
  ["feishu-connect-flow-004", "Feishu", "incomplete"],
  ["feishu-connect-flow-011", "Lark", "incomplete"],
] as const)(
  "%s recovers an unusable message link in the originating provider",
  async (_id, brand, reason) => {
    const provider = brand.toLowerCase();
    const path =
      reason === "expired"
        ? messageLink(provider).path
        : "/settings/" + provider + "?connect=account";
    context.mocks.api(
      feishuBrowserConnectContract.connectFromApp,
      ({ respond }) => {
        return respond(400, {
          error: {
            code: "FEISHU_CONNECT_LINK_INVALID",
            message: "Expired signature",
          },
        });
      },
    );
    await setupPage({ context, path });
    await expect(
      screen.findByText("Connection failed"),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByText(
        "This connection link is invalid or has expired. Return to " +
          brand +
          " and message the bot for a new link.",
      ),
    ).toBeVisible();
    await expect(
      findAction("link", "Back to settings"),
    ).resolves.toHaveAttribute("href", "/works");
  },
);

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

test.each(["feishu", "lark"] as const)(
  "%s keeps both edited credentials when the member returns from the enlarged setup image",
  async (provider) => {
    botWorkspace(context, provider, true, () => {
      return [];
    });
    await visitProvider(context, provider, "/settings/" + provider + "/setup");
    click(await findAction("button", "Next"));
    const appId = await screen.findByLabelText("App ID");
    const secret = await screen.findByLabelText("App Secret");
    await fill(appId, "cli_inshore");
    await fill(secret, "demo_secret_inshore");
    click(await findAction("button", "Show App Secret"));
    expect(secret).toHaveAttribute("type", "text");
    click(await findAction("button", "View setup reference"));
    const stage = await screen.findByRole("region", {
      name: "Setup reference",
    });
    const level = within(stage).getByTestId("feishu-guide-image-zoom-level");
    const initial = level.textContent;
    click(await findAction("button", "Zoom in", stage));
    expect(level.textContent).not.toBe(initial);
    await userEvent.keyboard("{Escape}");
    click(await findAction("button", "Back to fields", stage));
    expect(appId).toHaveValue("cli_inshore");
    expect(secret).toHaveValue("demo_secret_inshore");
    const listName = provider === "feishu" ? "Feishu bots" : "Lark bots";
    click(await findAction("link", listName));
    click(await findAction("link", "Add bot"));
    click(await findAction("button", "Next"));
    const nextSecret = await screen.findByLabelText("App Secret");
    expect(nextSecret).toHaveValue("");
    expect(nextSecret).toHaveAttribute("type", "password");
  },
);
