import {
  FEISHU_OAUTH_SCOPES,
  feishuConnectContract,
  type FeishuInstallationStatus,
} from "@okouai/api-contracts/contracts/feishu-connect";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

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
    tenantName: "Okou Feishu",
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
      throw new Error("Expected controlled Feishu options content");
    }
    return content;
  });
}

function getFeishuSettingsLink(): HTMLElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return (
      candidate.getAttribute("href") === "/settings/feishu" &&
      candidate.textContent?.includes("Feishu")
    );
  });
  if (!link) {
    throw new Error("Expected the Feishu settings link");
  }
  return link;
}

test("An organization admin can start guided Feishu bot setup", async () => {
  mockFeishu(context, { isAdmin: true });
  await setupIntegrationsPage(context, { feishu: true });

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
  expect(iconDownload).toHaveAttribute("download", "okou-feishu-app-icon.png");
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
  expect(screen.queryByLabelText("Verification Token")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Default agent")).not.toBeInTheDocument();
});

test("Feishu appears when enabled and shows a connected bot", async () => {
  mockFeishu(context, {
    isConnected: true,
    connectedUserName: "Feishu User",
    isInstalled: true,
    appId: "cli_feishu",
    installationId: INSTALLATION_ID,
    callbackUrl: `https://api.okou.test/api/webhooks/feishu/events/${INSTALLATION_ID}`,
    callbackVerified: true,
    messageReceived: true,
    tenantKey: "tenant-feishu",
    tenantName: "Okou Feishu",
    defaultAgentId: AGENT_ID,
    defaultAgentName: "Okou",
    installations: [
      completedInstallation({
        connectedUserName: "Feishu User",
        botName: "Okou Feishu",
        botAvatarUrl: "https://example.com/okou-feishu.png",
      }),
    ],
  });
  await setupIntegrationsPage(context, { feishu: true });

  await expect(screen.findByText("Feishu")).resolves.toBeInTheDocument();
  expect(
    screen.getByText("Route Feishu messages to agents"),
  ).toBeInTheDocument();
  click(getFeishuSettingsLink());

  await expect(screen.findByText("Okou Feishu")).resolves.toBeInTheDocument();
  expect(
    screen.getByRole("img", { name: "Okou Feishu bot icon" }),
  ).toHaveAttribute("src", "https://example.com/okou-feishu.png");
  expect(screen.getByText("Connected (Feishu User)")).toBeInTheDocument();
  expect(screen.queryByText("Add bot")).not.toBeInTheDocument();
  const moreOptions = await waitFor(() => {
    return getAction("button", "More options for Okou Feishu");
  });
  click(moreOptions);
  const options = await controlledContent(moreOptions);
  expect(getAction("button", "Uninstall", options)).toBeInTheDocument();
  expect(within(options).queryByText("Manage")).not.toBeInTheDocument();
});

test("An admin can review the setup guide for a completed Feishu bot", async () => {
  mockFeishu(context, {
    isConnected: true,
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
        appId: "cli_completed_admin",
        tenantKey: "tenant-admin",
        tenantName: "Completed admin bot",
      }),
    ],
  });
  await setupIntegrationsPage(context, { feishu: true });
  click(
    await waitFor(() => {
      return getFeishuSettingsLink();
    }),
  );
  await expect(screen.findByText("Feishu bots")).resolves.toBeInTheDocument();
  click(getAction("button", "More options for Completed admin bot"));
  click(getAction("button", "Review guide"));

  expect(
    screen.getByRole("heading", { name: "Feishu review guide" }),
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
    screen.queryByRole("heading", { name: "Feishu review guide" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText("Completed admin bot")).toBeInTheDocument();
});

test("A connected Feishu user can disconnect only their own account", async () => {
  mockFeishu(context, {
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
  await setupIntegrationsPage(context, { feishu: true });
  click(
    await waitFor(() => {
      return getFeishuSettingsLink();
    }),
  );
  await expect(screen.findByText("Feishu bots")).resolves.toBeInTheDocument();

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

test("Direct Feishu settings require Feishu to be enabled", async () => {
  await setupPage({
    context,
    path: "/settings/feishu",
    featureSwitches: { [FeatureSwitchKey.FeishuIntegration]: false },
  });

  await waitFor(() => {
    expect(pathname()).toBe(`/agents/${HOME_AGENT_ID}/chat`);
  });
  expect(screen.queryByText("Feishu bots")).not.toBeInTheDocument();
});

test("Direct Feishu settings wait for authoritative feature switches", async () => {
  mockFeishu(context);
  const featureResponse = createDeferredPromise<void>(context.signal);
  context.mocks.api(
    featureSwitchesContract.get,
    async ({ respond, withSignal }) => {
      await withSignal(featureResponse.promise);
      return respond(200, {
        switches: { [FeatureSwitchKey.FeishuIntegration]: true },
        effectiveSwitches: { [FeatureSwitchKey.FeishuIntegration]: true },
      });
    },
  );

  const page = await startPage({ context, path: "/settings/feishu" });
  expect(pathname()).toBe("/settings/feishu");
  featureResponse.resolve(undefined);
  await page.ready;

  await expect(screen.findByText("Feishu bots")).resolves.toBeInTheDocument();
  expect(pathname()).toBe("/settings/feishu");
});

test("A member cannot manage an incomplete Feishu bot", async () => {
  mockFeishu(context, {
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
  await setupIntegrationsPage(context, { feishu: true });
  click(
    await waitFor(() => {
      return getFeishuSettingsLink();
    }),
  );

  await expect(screen.findByText("Feishu bots")).resolves.toBeInTheDocument();
  expect(screen.getByText("Setup incomplete")).toBeInTheDocument();
  expect(screen.queryByText("Add bot")).not.toBeInTheDocument();
  expect(screen.queryByText("Connect")).not.toBeInTheDocument();
  expect(queryAction("button", "More options for Member bot")).toBeNull();
});

test("Feishu setup advances when callback verification arrives", async () => {
  let callbackVerified = false;
  let isConnected = false;
  context.mocks.api(feishuConnectContract.getStatus, ({ respond }) => {
    const installation = completedInstallation({
      isConnected,
      appId: "cli_feishu",
      oauthRedirectUrl: "https://app.okou.test/connectors/feishu/callback",
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
  await setupIntegrationsPage(context, { feishu: true });
  click(
    await waitFor(() => {
      return getFeishuSettingsLink();
    }),
  );
  await expect(screen.findByText("Feishu bots")).resolves.toBeInTheDocument();
  click(getAction("button", "More options for Feishu bot"));
  click(getAction("button", "Manage"));
  expect(
    screen.getByText("Configure the OAuth redirect URL"),
  ).toBeInTheDocument();
  expect(
    screen.getByDisplayValue(
      "https://app.okou.test/connectors/feishu/callback",
    ),
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
  expect(screen.getByText("Feishu connected successfully")).toBeInTheDocument();
  expect(getAction("button", "Next")).toBeEnabled();
  click(getAction("button", "Next"));
  expect(screen.getByText("Publish the app")).toBeInTheDocument();
});

test("A workspace member can connect to a completed Feishu bot", async () => {
  const connectUrl =
    "https://www.okou.test/api/feishu/oauth/connect?state=member";
  const browserOpen = context.mocks.browser.open();
  mockFeishu(context, {
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
  await setupIntegrationsPage(context, { feishu: true });
  click(
    await waitFor(() => {
      return getFeishuSettingsLink();
    }),
  );
  await expect(screen.findByText("Feishu bots")).resolves.toBeInTheDocument();

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

test("A Feishu App ID already registered in Okou cannot be reused", async () => {
  mockFeishu(context, { isAdmin: true });
  context.mocks.api(feishuConnectContract.checkAppId, ({ query, respond }) => {
    expect(query.appId).toBe("cli_registered");
    return respond(409, {
      error: {
        code: "CONFLICT",
        message: "This Feishu App ID is already registered in Okou",
      },
    });
  });
  await setupIntegrationsPage(context, { feishu: true });
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
    screen.findByText("This Feishu App ID is already registered in Okou"),
  ).resolves.toBeInTheDocument();
  expect(screen.getByLabelText("App ID")).toBeInTheDocument();
  expect(screen.queryByLabelText("Verification Token")).not.toBeInTheDocument();
});

test("Feishu settings provide setup troubleshooting guidance", async () => {
  mockFeishu(context);
  await setupFeishuSettingsPage(context);

  await expect(
    screen.findByRole("heading", { name: "Setup FAQ" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText(
      /Why does Feishu show "Challenge code didn't get a response"\?/u,
    ),
  ).toBeInTheDocument();
  expect(screen.getByText(/Return to the Tokens step/u)).toBeInTheDocument();
  expect(
    screen.getByText("Why is publishing the app waiting for approval?"),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Feishu sends the approval request/u),
  ).toBeInTheDocument();
});
