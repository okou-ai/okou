import {
  FEISHU_OAUTH_SCOPES,
  feishuConnectContract,
  larkConnectContract,
  type FeishuConnectStatus,
  type FeishuInstallationStatus,
} from "@okouai/api-contracts/contracts/feishu-connect";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FEISHU_PLATFORMS } from "@okouai/core/feishu-platform";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
  startPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { pathname } from "../../../signals/location.ts";
import {
  getAction,
  mockFeishu,
  queryAction,
  setupFeishuSettingsPage,
  setupIntegrationsPage,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
describe.each(["feishu", "lark"] as const)("%s integration UI", (platform) => {
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
      publicBrand: "okou",
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
      screen.findByText("Create an enterprise custom app"),
    ).resolves.toBeInTheDocument();
    const createGuideImage = screen.getByRole("img", {
      name: "Feishu app creation form with the app name, icon, and Create button highlighted",
    });
    expect(createGuideImage).toBeInTheDocument();
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

    click(getAction("button", "Next"));

    await expect(screen.findByLabelText("App ID")).resolves.toBeInTheDocument();
    expect(screen.getByLabelText("App Secret")).toBeInTheDocument();
    const credentialsGuideImage = screen.getByRole("img", {
      name: "Feishu app creation result showing where to find the App ID and App Secret",
    });
    expect(credentialsGuideImage).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Verification Token"),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Default agent")).not.toBeInTheDocument();
  });

  it.each([false, true])(
    "setup connects if needed (%s)",
    async (isConnected) => {
      mockBot();
      const connectUrl = `https://api.okou.test/api/${platform}/oauth/connect?state=new-bot`;
      const completion = createDeferredPromise<void>(context.signal);
      let status: FeishuConnectStatus | undefined;
      let submitted: unknown;
      let completed: unknown;
      context.mocks.api(connectContract.setup, ({ body, respond }) => {
        submitted = body;
        const installation = completedInstallation({
          isConnected: false,
          setupCompleted: false,
          appId: body.appId,
          defaultAgentId: body.defaultAgentId,
          callbackVerified: false,
          messageReceived: false,
          oauthRedirectUrl: `https://app.okou.test${provider.callbackPath}`,
        });
        status = {
          ...installation,
          isAdmin: true,
          isInstalled: true,
          installationId: INSTALLATION_ID,
          installations: [installation],
        };
        mockBot(status);
        return respond(200, status);
      });
      context.mocks.api(
        connectContract.updateInstallation,
        async ({ body, params, respond, withSignal }) => {
          completed = { body, installationId: params.installationId };
          await withSignal(completion.promise);
          return respond(
            200,
            completedInstallation({
              isConnected,
              defaultAgentId: body.defaultAgentId,
              connectUrl,
            }),
          );
        },
      );
      await setupFeishuSettingsPage(context, platform);
      const expectedUrl = isConnected
        ? window.location.href
        : `${connectUrl}&callbackTarget=app`;
      click(await screen.findByText("Add bot"));
      click(getAction("button", "Next"));
      await fill(await screen.findByLabelText("App ID"), "cli_new_bot");
      await fill(screen.getByLabelText("App Secret"), "app-secret");
      click(getAction("button", "Next"));
      await fill(
        await screen.findByLabelText("Verification Token"),
        "verification-token",
      );
      await fill(screen.getByLabelText("Encrypt Key"), "encrypt-key");
      click(getAction("button", "Verify and continue"));
      await expect(
        screen.findByText("Configure the OAuth redirect URL"),
      ).resolves.toBeVisible();
      expect(submitted).toStrictEqual({
        appId: "cli_new_bot",
        appSecret: "app-secret",
        verificationToken: "verification-token",
        encryptKey: "encrypt-key",
        defaultAgentId: HOME_AGENT_ID,
        createNew: true,
      });
      expect(
        screen.getByDisplayValue(
          `https://app.okou.test${provider.callbackPath}`,
        ),
      ).toBeVisible();
      click(getAction("button", "Next"));
      expect(screen.getByText("Import user token scopes")).toBeVisible();
      click(getAction("button", "Next"));
      expect(screen.getByText("Configure event delivery")).toBeVisible();
      expect(getAction("button", "Waiting for callback")).toBeDisabled();
      if (!status) {
        throw new Error("Expected configured installation");
      }
      mockBot({
        ...status,
        callbackVerified: true,
        installations: status.installations?.map((installation) => {
          return { ...installation, callbackVerified: true };
        }),
      });
      context.mocks.ably.trigger("feishu:changed");
      await expect(
        screen.findByText("Callback verified"),
      ).resolves.toBeVisible();
      click(getAction("button", "Next"));
      expect(screen.getByText("Publish the app")).toBeVisible();
      click(getAction("button", "Done"));
      await waitFor(() => {
        expect(getAction("button", "Back")).toBeDisabled();
      });
      expect(pathname()).toBe(provider.settingsPath);
      completion.resolve();
      await expect(
        screen.findByText(`${provider.name} bot installed successfully`),
      ).resolves.toBeVisible();
      await waitFor(() => {
        expect(screen.queryByText("Publish the app")).not.toBeInTheDocument();
      });
      expect(window.location.href).toBe(expectedUrl);
      expect(completed).toStrictEqual({
        installationId: INSTALLATION_ID,
        body: { defaultAgentId: HOME_AGENT_ID, setupCompleted: true },
      });
    },
  );

  it("a failed setup completion stays in the guide and connects after a successful retry", async () => {
    const connectUrl = `https://api.okou.test/api/${platform}/oauth/connect?state=resumed-bot`;
    const installation = completedInstallation({
      isConnected: false,
      setupCompleted: false,
      tenantName: "Pending bot",
      oauthRedirectUrl: `https://app.okou.test${provider.callbackPath}`,
    });
    mockBot({
      isInstalled: true,
      installations: [installation],
    });
    context.mocks.api(connectContract.updateInstallation, ({ respond }) => {
      return respond(400, {
        error: {
          code: "BAD_REQUEST",
          message: "Select an agent from this organization",
        },
      });
    });
    await setupFeishuSettingsPage(context, platform);
    await expect(screen.findByText("Pending bot")).resolves.toBeInTheDocument();
    click(getAction("button", "More options for Pending bot"));
    click(getAction("button", "Manage"));
    expect(
      screen.getByText("Configure the OAuth redirect URL"),
    ).toBeInTheDocument();
    expect(getAction("button", "Next")).toBeEnabled();
    click(getAction("button", "Next"));
    expect(screen.getByText("Import user token scopes")).toBeInTheDocument();
    click(getAction("button", "Next"));
    expect(screen.getByText("Configure event delivery")).toBeInTheDocument();
    click(getAction("button", "Next"));
    expect(screen.getByText("Publish the app")).toBeInTheDocument();
    click(getAction("button", "Done"));

    await expect(
      screen.findByText("Select an agent from this organization"),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(getAction("button", "Back")).toBeEnabled();
    });
    expect(screen.getByText("Publish the app")).toBeInTheDocument();
    expect(pathname()).toBe(provider.settingsPath);

    context.mocks.api(connectContract.updateInstallation, ({ respond }) => {
      return respond(200, {
        ...installation,
        setupCompleted: true,
        connectUrl,
      });
    });
    click(getAction("button", "Done"));
    await waitFor(() => {
      expect(window.location.href).toBe(`${connectUrl}&callbackTarget=app`);
    });
  });

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

  it.each([true, false])("review never connects (%s)", async (isConnected) => {
    const browserOpen = context.mocks.browser.open();
    mockBot({
      isConnected,
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
          isConnected,
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
    click(getAction("button", "Review guide"));

    expect(
      screen.getByRole("heading", { name: `${provider.name} review guide` }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Create an enterprise custom app"),
    ).toBeInTheDocument();
    click(getAction("button", "Next"));
    expect(screen.getByLabelText("App ID")).toHaveValue("cli_completed_admin");
    expect(screen.getByLabelText("App ID")).toBeDisabled();
    expect(screen.getByLabelText("App Secret")).toBeDisabled();
    expect(screen.getByLabelText("App Secret")).toHaveAttribute(
      "placeholder",
      "Configured",
    );
    click(getAction("button", "Next"));
    expect(screen.getByLabelText("Encrypt Key")).toBeDisabled();
    expect(screen.getByLabelText("Verification Token")).toBeDisabled();
    click(getAction("button", "Next"));
    expect(
      screen.getByText("Configure the OAuth redirect URL"),
    ).toBeInTheDocument();
    click(getAction("button", "Next"));
    expect(screen.getByText("Import user token scopes")).toBeInTheDocument();
    const scopeImportJson = screen.getByTestId("feishu-user-scope-import-json");
    expect(JSON.parse(scopeImportJson.textContent ?? "")).toStrictEqual({
      scopes: { tenant: [], user: [...FEISHU_OAUTH_SCOPES] },
    });
    expect(screen.getByRole("note")).toBeInTheDocument();
    click(getAction("button", "Next"));
    expect(screen.getByText("Configure event delivery")).toBeInTheDocument();
    click(getAction("button", "Next"));
    expect(screen.getByText("Publish the app")).toBeInTheDocument();
    expect(screen.getByLabelText("Default agent")).toBeDisabled();

    click(getAction("button", "Done"));

    expect(
      screen.queryByRole("heading", {
        name: `${provider.name} review guide`,
      }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Completed admin bot")).toBeInTheDocument();
    expect(pathname()).toBe(provider.settingsPath);
    expect(browserOpen.calls).toStrictEqual([]);
  });

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

  it(`Direct ${provider.name} settings wait for authoritative feature switches`, async () => {
    mockBot();
    const featureResponse = createDeferredPromise<void>(context.signal);
    context.mocks.api(
      featureSwitchesContract.get,
      async ({ respond, withSignal }) => {
        await withSignal(featureResponse.promise);
        return respond(200, {
          switches: { [provider.featureSwitch]: true },
          effectiveSwitches: { [provider.featureSwitch]: true },
        });
      },
    );

    const page = await startPage({ context, path: `${provider.settingsPath}` });
    expect(pathname()).toBe(`${provider.settingsPath}`);
    featureResponse.resolve(undefined);
    await page.ready;

    await expect(
      screen.findByText(`${provider.name} bots`),
    ).resolves.toBeInTheDocument();
    expect(pathname()).toBe(`${provider.settingsPath}`);
  });

  it(`A member cannot manage an incomplete ${provider.name} bot`, async () => {
    mockBot({
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
          isConnected: false,
          appId: "cli_member",
          connectUrl:
            "https://www.okou.test/api/feishu/oauth/connect?state=incomplete",
          tenantKey: "tenant-member",
          tenantName: "Member bot",
          setupCompleted: false,
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
    expect(screen.getByText("Setup incomplete")).toBeInTheDocument();
    expect(screen.queryByText("Add bot")).not.toBeInTheDocument();
    expect(screen.queryByText("Connect")).not.toBeInTheDocument();
    expect(queryAction("button", "More options for Member bot")).toBeNull();
  });

  it(`${provider.name} setup advances when callback verification arrives`, async () => {
    let callbackVerified = false;
    let isConnected = false;
    context.mocks.api(connectContract.getStatus, ({ respond }) => {
      const installation = completedInstallation({
        isConnected,
        appId: "cli_feishu",
        oauthRedirectUrl: `https://app.okou.test${provider.callbackPath}`,
        callbackVerified,
        messageReceived: false,
        tenantKey: null,
        tenantName: null,
        setupCompleted: false,
      });
      return respond(200, {
        publicBrand: "okou",
        isConnected,
        isInstalled: true,
        isAdmin: true,
        installationId: INSTALLATION_ID,
        appId: "cli_feishu",
        callbackUrl: `https://api.okou.test/api/webhooks/feishu/events/${INSTALLATION_ID}`,
        callbackVerified,
        messageReceived: false,
        tenantKey: null,
        tenantName: null,
        defaultAgentId: AGENT_ID,
        defaultAgentName: "Okou",
        installations: [installation],
      });
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
    click(getAction("button", `More options for ${provider.name} bot`));
    click(getAction("button", "Manage"));
    expect(
      screen.getByText("Configure the OAuth redirect URL"),
    ).toBeInTheDocument();
    expect(
      screen.getByDisplayValue(`https://app.okou.test${provider.callbackPath}`),
    ).toBeInTheDocument();
    click(getAction("button", "Next"));
    expect(screen.getByText("Import user token scopes")).toBeInTheDocument();
    click(getAction("button", "Next"));
    expect(screen.getByText("Configure event delivery")).toBeInTheDocument();
    expect(screen.getAllByText("Waiting for callback")).not.toHaveLength(0);
    expect(document.body).toHaveTextContent("im.message.receive_v1");
    callbackVerified = true;
    isConnected = true;
    context.mocks.ably.trigger("feishu:changed");

    await expect(
      screen.findByText("Callback verified"),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByText(`${provider.name} connected successfully`),
    ).toBeInTheDocument();
    expect(getAction("button", "Next")).toBeEnabled();
    click(getAction("button", "Next"));
    expect(screen.getByText("Publish the app")).toBeInTheDocument();
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

  it(`A ${provider.name} App ID already registered in Okou cannot be reused`, async () => {
    mockBot({ isAdmin: true });
    context.mocks.api(connectContract.checkAppId, ({ query, respond }) => {
      expect(query.appId).toBe("cli_registered");
      return respond(409, {
        error: {
          code: "CONFLICT",
          message: `This ${provider.name} App ID is already registered in Okou`,
        },
      });
    });
    await setupIntegrationsPage(context, { [platform]: true });
    click(
      await waitFor(() => {
        return getFeishuSettingsLink();
      }),
    );
    click(await screen.findByText("Add bot"));
    click(getAction("button", "Next"));
    await fill(await screen.findByLabelText("App ID"), "cli_registered");
    await fill(screen.getByLabelText("App Secret"), "app-secret");

    click(getAction("button", "Next"));

    await expect(
      screen.findByText(
        `This ${provider.name} App ID is already registered in Okou`,
      ),
    ).resolves.toBeInTheDocument();
    expect(screen.getByLabelText("App ID")).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Verification Token"),
    ).not.toBeInTheDocument();
  });

  it(`${provider.name} settings provide setup troubleshooting guidance`, async () => {
    mockBot();
    await setupFeishuSettingsPage(context, platform);

    await expect(
      screen.findByRole("heading", { name: "Setup FAQ" }),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByText(
        `Why does ${provider.name} show "Challenge code didn't get a response"?`,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Return to the Tokens step/u)).toBeInTheDocument();
    expect(
      screen.getByText("Why is publishing the app waiting for approval?"),
    ).toBeInTheDocument();
    expect(
      screen.getByText((content) => {
        return content.includes(`${provider.name} sends the approval request`);
      }),
    ).toBeInTheDocument();
  });
});
