import {
  FEISHU_OAUTH_SCOPES,
  feishuConnectContract,
  larkConnectContract,
  type FeishuConnectStatus,
  type FeishuInstallationStatus,
} from "@okouai/api-contracts/contracts/feishu-connect";
import { FEISHU_PLATFORMS } from "@okouai/core/feishu-platform";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { pathname } from "../../../signals/location.ts";
import {
  getAction,
  findAction,
  mockFeishu,
  queryAction,
  setupFeishuSettingsPage,
  setupIntegrationsPage,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
function integrationSuite(platform: "feishu" | "lark") {
  const provider = FEISHU_PLATFORMS[platform];
  const connectContract =
    platform === "lark" ? larkConnectContract : feishuConnectContract;
  function mockBot(overrides: Partial<FeishuConnectStatus> = {}) {
    mockFeishu(context, overrides, platform);
  }
  const INSTALLATION_ID = "00000000-0000-4000-8000-000000000001";
  const AGENT_ID = "00000000-0000-4000-8000-000000000002";
  const HOME_AGENT_ID = "c0000000-0000-4000-a000-000000000001";

  function completedInstallation(
    overrides: Partial<FeishuInstallationStatus> = {},
  ): FeishuInstallationStatus {
    return {
      id: INSTALLATION_ID,
      isConnected: true,
      appId: "cli_feishu",
      callbackUrl: `https://api.okou.test/api/webhooks/feishu/events/${INSTALLATION_ID}`,
      callbackVerified: true,
      messageReceived: true,
      tenantKey: "tenant-feishu",
      tenantName: `Okou ${provider.name}`,
      defaultAgentId: AGENT_ID,
      defaultAgentName: "Okou",
      setupCompleted: true,
      ...overrides,
    };
  }

  function controlledContent(control: HTMLElement): Promise<HTMLElement> {
    return waitFor(() => {
      const contentId = control.getAttribute("aria-controls");
      const content = contentId ? document.getElementById(contentId) : null;
      if (!(content instanceof HTMLElement)) {
        throw new Error(`Expected controlled ${provider.name} options content`);
      }
      return content;
    });
  }

  function getFeishuSettingsLink(): HTMLElement {
    const link = queryAllByRoleFast("link").find((candidate) => {
      return (
        candidate.getAttribute("href") === `${provider.settingsPath}` &&
        candidate.textContent?.includes(`${provider.name}`)
      );
    });
    if (!link) {
      throw new Error(`Expected the ${provider.name} settings link`);
    }
    return link;
  }
  return {
    provider,
    connectContract,
    mockBot,
    INSTALLATION_ID,
    AGENT_ID,
    HOME_AGENT_ID,
    completedInstallation,
    controlledContent,
    getFeishuSettingsLink,
  };
}

describe.each(["feishu", "lark"] as const)("%s integration UI", (platform) => {
  const {
    provider,
    connectContract,
    mockBot,
    INSTALLATION_ID,
    AGENT_ID,
    completedInstallation,
    controlledContent,
    getFeishuSettingsLink,
  } = integrationSuite(platform);

  it(`${provider.name} appears when enabled and shows a connected bot`, async () => {
    mockBot({
      isConnected: true,
      connectedUserName: `${provider.name} User`,
      isInstalled: true,
      appId: "cli_feishu",
      installationId: INSTALLATION_ID,
      callbackUrl: `https://api.okou.test/api/webhooks/feishu/events/${INSTALLATION_ID}`,
      callbackVerified: true,
      messageReceived: true,
      tenantKey: "tenant-feishu",
      tenantName: `Okou ${provider.name}`,
      defaultAgentId: AGENT_ID,
      defaultAgentName: "Okou",
      installations: [
        completedInstallation({
          connectedUserName: `${provider.name} User`,
          botName: `Okou ${provider.name}`,
          botAvatarUrl: "https://example.com/okou-feishu.png",
        }),
      ],
    });
    await setupIntegrationsPage(context, { [platform]: true });

    await expect(
      screen.findByText(`${provider.name}`),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByText(`Route ${provider.name} messages to agents`),
    ).toBeInTheDocument();
    click(getFeishuSettingsLink());

    await expect(
      screen.findByText(`Okou ${provider.name}`),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: `Okou ${provider.name} bot icon` }),
    ).toHaveAttribute("src", "https://example.com/okou-feishu.png");
    expect(
      screen.getByText(`Connected (${provider.name} User)`),
    ).toBeInTheDocument();
    expect(screen.queryByText("Add bot")).not.toBeInTheDocument();
    const moreOptions = await waitFor(() => {
      return getAction("button", `More options for Okou ${provider.name}`);
    });
    click(moreOptions);
    const options = await controlledContent(moreOptions);
    expect(getAction("button", "Uninstall", options)).toBeInTheDocument();
    expect(within(options).queryByText("Manage")).not.toBeInTheDocument();
  });

  it(`${provider.name} keeps a pending uninstall open and allows retry after failure`, async () => {
    mockBot({
      isInstalled: true,
      installations: [completedInstallation()],
    });
    const started = context.mocks.deferred<void>();
    const response = context.mocks.deferred<void>();
    let fail = true;
    context.mocks.api(
      connectContract.removeInstallation,
      async ({ respond }) => {
        if (fail) {
          started.resolve();
          await response.promise;
          return respond(403, {
            error: { code: "FORBIDDEN", message: "Uninstall unavailable" },
          });
        }
        mockBot({ isInstalled: false, installations: [] });
        return respond(200, { success: true });
      },
    );
    await setupFeishuSettingsPage(context, platform);
    await screen.findByText(`Okou ${provider.name}`);
    const moreOptions = getAction(
      "button",
      `More options for Okou ${provider.name}`,
    );
    click(moreOptions);
    const options = await controlledContent(moreOptions);
    click(getAction("button", "Uninstall", options));
    const dialog = await screen.findByRole("dialog", {
      name: `Uninstall ${provider.name} bot?`,
    });
    click(getAction("button", "Uninstall", dialog));
    await started.promise;
    expect(getAction("button", "Cancel", dialog)).toBeDisabled();
    expect(getAction("button", "Uninstalling...", dialog)).toBeDisabled();
    const user = userEvent.setup();
    await user.keyboard("{Escape}");
    expect(dialog).toBeInTheDocument();
    response.resolve();
    await screen.findByText("Uninstall unavailable");
    expect(getAction("button", "Uninstall", dialog)).toBeEnabled();
    fail = false;
    click(getAction("button", "Uninstall", dialog));
    await screen.findByText(`${provider.name} bot uninstalled`);
    await waitFor(() => {
      expect(dialog).not.toBeInTheDocument();
    });
    expect(getAction("link", "Add bot")).toBeEnabled();
  });

  it(`Reviewing a ${provider.name} bot guide never connects`, async () => {
    const browserOpen = context.mocks.browser.open();
    mockBot({
      isConnected: false,
      isInstalled: true,
      isAdmin: true,
      installationId: INSTALLATION_ID,
      appId: "cli_completed_admin",
      callbackUrl: `https://api.okou.test/api/webhooks/feishu/events/${INSTALLATION_ID}`,
      callbackVerified: true,
      messageReceived: true,
      tenantKey: "tenant-admin",
      tenantName: "Completed admin bot",
      defaultAgentId: AGENT_ID,
      defaultAgentName: "Okou",
      installations: [
        completedInstallation({
          isConnected: false,
          connectUrl: `https://api.okou.test/api/${platform}/oauth/connect?state=review-guide`,
          appId: "cli_completed_admin",
          tenantKey: "tenant-admin",
          tenantName: "Completed admin bot",
        }),
      ],
    });
    await setupIntegrationsPage(context, { [platform]: true });
    click(
      await waitFor(() => {
        return getFeishuSettingsLink();
      }),
    );
    await expect(
      screen.findByText(`${provider.name} bots`),
    ).resolves.toBeInTheDocument();
    click(getAction("button", "More options for Completed admin bot"));
    click(getAction("link", "Review guide"));

    await screen.findByRole("heading", {
      name: `${provider.name} review guide`,
    });
    expect(screen.getByText("Create an Agent app")).toBeInTheDocument();
    click(await findAction("button", "Next"));
    expect(screen.getByLabelText("App ID")).toHaveValue("cli_completed_admin");
    expect(screen.getByLabelText("App ID")).toBeDisabled();
    expect(screen.getByLabelText("App Secret")).toBeDisabled();
    expect(screen.getByLabelText("App Secret")).toHaveAttribute(
      "placeholder",
      "Configured",
    );
    click(await findAction("button", "Next"));
    expect(screen.getByLabelText("Encrypt Key")).toBeDisabled();
    expect(screen.getByLabelText("Verification Token")).toBeDisabled();
    click(await findAction("button", "Next"));
    await screen.findByText("Configure the OAuth redirect URL");
    click(await findAction("button", "Next"));
    expect(screen.getByText("Import app and user scopes")).toBeInTheDocument();
    const scopeImportJson = screen.getByTestId("feishu-scope-import-json");
    expect(JSON.parse(scopeImportJson.textContent ?? "")).toStrictEqual({
      scopes: {
        tenant: expect.arrayContaining([
          "im:message.p2p_msg:readonly",
          "im:message.group_at_msg:readonly",
          "im:message.group_at_msg.include_bot:readonly",
          "im:message.group_msg",
          "im:message:send_as_bot",
          "im:message:update",
          "im:resource",
          "cardkit:card:read",
          "cardkit:card:write",
        ]),
        user: [...FEISHU_OAUTH_SCOPES],
      },
    });
    expect(screen.getByRole("note")).toBeInTheDocument();
    click(await findAction("button", "Next"));
    expect(screen.getByText("Configure event delivery")).toBeInTheDocument();
    click(await findAction("button", "Next"));
    expect(screen.getByText("Publish the app")).toBeInTheDocument();

    click(getAction("button", "Done"));

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", {
          name: `${provider.name} review guide`,
        }),
      ).not.toBeInTheDocument();
    });
    await screen.findByText("Completed admin bot");
    expect(pathname()).toBe(provider.settingsPath);
    expect(browserOpen.calls).toStrictEqual([]);
  });

  it(`A workspace member can connect to a completed ${provider.name} bot`, async () => {
    const connectUrl =
      "https://www.okou.test/api/feishu/oauth/connect?state=member";
    const browserOpen = context.mocks.browser.open();
    mockBot({
      isConnected: false,
      isInstalled: true,
      isAdmin: false,
      installationId: INSTALLATION_ID,
      appId: "cli_member_connect",
      callbackUrl: `https://www.okou.test/api/webhooks/feishu/events/${INSTALLATION_ID}`,
      callbackVerified: true,
      messageReceived: false,
      tenantKey: "tenant-member",
      tenantName: "Member bot",
      defaultAgentId: AGENT_ID,
      defaultAgentName: "Okou",
      installations: [
        completedInstallation({
          isConnected: false,
          appId: "cli_member_connect",
          callbackUrl: `https://www.okou.test/api/webhooks/feishu/events/${INSTALLATION_ID}`,
          connectUrl,
          messageReceived: false,
          tenantKey: "tenant-member",
          tenantName: "Member bot",
        }),
      ],
    });
    await setupIntegrationsPage(context, { [platform]: true });
    click(
      await waitFor(() => {
        return getFeishuSettingsLink();
      }),
    );
    await expect(
      screen.findByText(`${provider.name} bots`),
    ).resolves.toBeInTheDocument();

    click(
      await waitFor(() => {
        return getAction("button", "Connect");
      }),
    );

    expect(browserOpen.calls).toStrictEqual([
      {
        url: `${connectUrl}&callbackTarget=app`,
        target: "_blank",
        features: null,
      },
    ]);
    expect(queryAction("button", "More options for Member bot")).toBeNull();
  });
});

describe.each(["feishu"] as const)("%s integration UI", (platform) => {
  const {
    provider,
    connectContract,
    mockBot,
    INSTALLATION_ID,
    AGENT_ID,
    HOME_AGENT_ID,
    completedInstallation,
    controlledContent,
    getFeishuSettingsLink,
  } = integrationSuite(platform);

  it(`An organization admin can start guided ${provider.name} bot setup`, async () => {
    mockBot({ isAdmin: true });
    await setupIntegrationsPage(context, { [platform]: true });

    click(
      await waitFor(() => {
        return getFeishuSettingsLink();
      }),
    );
    click(await screen.findByText("Add bot"));

    await expect(
      screen.findByText("Create an Agent app"),
    ).resolves.toBeInTheDocument();
    const createGuideImage = screen.getByRole("img", {
      name: `${provider.name} app creation form with the app name, icon, and Create button highlighted`,
    });
    expect(createGuideImage).toBeInTheDocument();
    expect(screen.getByText(/select the Agent type/u)).toBeVisible();
    const iconDownload = getAction("link", "Download the optional Okou icon");
    expect(iconDownload).toHaveAttribute(
      "href",
      "https://static.okou.io/platform/views/zero-page/assets/feishu/app-icon-okou-fefdc683bf5c.png",
    );
    expect(iconDownload).toHaveAttribute(
      "download",
      `okou-${platform}-app-icon.png`,
    );
    expect(
      screen.getByRole("img", { name: "Optional Okou app icon" }),
    ).toHaveAttribute(
      "src",
      "https://static.okou.io/platform/views/zero-page/assets/feishu/app-icon-okou-fefdc683bf5c.png",
    );

    click(await findAction("button", "Next"));

    await expect(screen.findByLabelText("App ID")).resolves.toBeInTheDocument();
    expect(screen.getByLabelText("App Secret")).toBeInTheDocument();
    const credentialsGuideImage = screen.getByRole("img", {
      name: "Feishu app creation result showing where to find the App ID and App Secret",
    });
    expect(credentialsGuideImage).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Verification Token"),
    ).not.toBeInTheDocument();
  });

  it.each(["Enter"] as const)(
    `${provider.name} credentials validate before advancing with %s`,
    async (activation) => {
      const user = userEvent.setup({ delay: null });
      const appIdCheck = createDeferredPromise<void>(context.signal);
      mockBot();
      context.mocks.api(
        connectContract.checkAppId,
        async ({ respond, withSignal }) => {
          await withSignal(appIdCheck.promise);
          return respond(200, { available: true });
        },
      );
      await setupFeishuSettingsPage(context, platform);
      click(await screen.findByText("Add bot"));
      click(await findAction("button", "Next"));
      const appId = await screen.findByLabelText("App ID");
      const appSecret = screen.getByLabelText("App Secret");
      await fill(appId, "cli_new_bot");
      expect(getAction("button", "Next")).toBeDisabled();
      await user.click(appId);
      await user.keyboard("{Enter}");
      expect(appSecret).toBeInTheDocument();
      await fill(appSecret, "   ");
      expect(getAction("button", "Next")).toBeDisabled();
      await fill(appSecret, "app-secret");
      const next = getAction("button", "Next");
      expect(next).toBeEnabled();

      if (activation === "Enter") {
        await user.click(appSecret);
        await user.keyboard("{Enter}");
      } else {
        click(next);
      }

      await waitFor(() => {
        expect(getAction("button", "Checking…")).toBeDisabled();
      });
      expect(appId).toBeDisabled();
      expect(appSecret).toBeDisabled();
      expect(getAction("button", "Back")).toBeDisabled();
      click(next);
      await user.keyboard("{Enter}");
      appIdCheck.resolve();

      await expect(
        screen.findByLabelText("Verification Token"),
      ).resolves.toBeInTheDocument();
      expect(getAction("button", "Verify and continue")).toBeDisabled();
      click(getAction("button", "Back"));
      expect(screen.getByLabelText("App ID")).toHaveValue("cli_new_bot");
      expect(screen.getByLabelText("App Secret")).toHaveValue("app-secret");
      click(getAction("button", "Back"));
      expect(screen.getByText("Create an Agent app")).toBeInTheDocument();
      click(getAction("button", "Cancel"));
      await screen.findByRole("heading", { name: `${provider.name} bots` });
    },
  );

  it(`A connected ${provider.name} user can disconnect only their own account`, async () => {
    mockBot({
      isConnected: true,
      isInstalled: true,
      isAdmin: false,
      installationId: INSTALLATION_ID,
      appId: "cli_member",
      callbackUrl: `https://api.okou.test/api/webhooks/feishu/events/${INSTALLATION_ID}`,
      callbackVerified: true,
      messageReceived: true,
      tenantKey: "tenant-member",
      tenantName: "Member bot",
      defaultAgentId: AGENT_ID,
      defaultAgentName: "Okou",
      installations: [
        completedInstallation({
          appId: "cli_member",
          tenantKey: "tenant-member",
          tenantName: "Member bot",
        }),
      ],
    });
    await setupIntegrationsPage(context, { [platform]: true });
    click(
      await waitFor(() => {
        return getFeishuSettingsLink();
      }),
    );
    await expect(
      screen.findByText(`${provider.name} bots`),
    ).resolves.toBeInTheDocument();

    const moreOptions = await waitFor(() => {
      return getAction("button", "More options for Member bot");
    });
    click(moreOptions);
    const options = await controlledContent(moreOptions);

    expect(getAction("button", "Disconnect", options)).toBeInTheDocument();
    expect(within(options).queryByText("Review guide")).not.toBeInTheDocument();
    expect(within(options).queryByText("Manage")).not.toBeInTheDocument();
    expect(within(options).queryByText("Uninstall")).not.toBeInTheDocument();
  });

  it(`Direct ${provider.name} settings require ${provider.name} to be enabled`, async () => {
    await setupPage({
      context,
      path: `${provider.settingsPath}`,
      featureSwitches: { [provider.featureSwitch]: false },
    });

    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${HOME_AGENT_ID}/chat`);
    });
    expect(screen.queryByText(`${provider.name} bots`)).not.toBeInTheDocument();
  });

  it(`A ${provider.name} App ID already registered in Okou cannot be reused`, async () => {
    const user = userEvent.setup({ delay: null });
    mockBot({ isAdmin: true });
    context.mocks.api(connectContract.checkAppId, ({ query, respond }) => {
      return query.appId === "cli_registered"
        ? respond(409, {
            error: {
              code: "CONFLICT",
              message: `This ${provider.name} App ID is already registered in Okou`,
            },
          })
        : respond(200, { available: true });
    });
    await setupIntegrationsPage(context, { [platform]: true });
    click(
      await waitFor(() => {
        return getFeishuSettingsLink();
      }),
    );
    click(await screen.findByText("Add bot"));
    click(await findAction("button", "Next"));
    await fill(await screen.findByLabelText("App ID"), "cli_registered");
    await fill(screen.getByLabelText("App Secret"), "app-secret");

    await user.click(screen.getByLabelText("App Secret"));
    await user.keyboard("{Enter}");

    await expect(
      screen.findByText(
        `This ${provider.name} App ID is already registered in Okou`,
      ),
    ).resolves.toBeInTheDocument();
    expect(screen.getByLabelText("App ID")).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Verification Token"),
    ).not.toBeInTheDocument();
    await fill(screen.getByLabelText("App ID"), "cli_available");
    await user.click(screen.getByLabelText("App ID"));
    await user.keyboard("{Enter}");
    await expect(
      screen.findByLabelText("Verification Token"),
    ).resolves.toBeInTheDocument();
  });
});
