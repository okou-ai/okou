import { integrationsAgentPhoneContract } from "@okouai/api-contracts/contracts/integrations-agentphone";
import { integrationsGithubContract } from "@okouai/api-contracts/contracts/integrations-github";
import { integrationsSlackContract } from "@okouai/api-contracts/contracts/integrations-slack";
import { integrationsTelegramContract } from "@okouai/api-contracts/contracts/integrations-telegram";
import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getAction,
  getIntegrationCard,
  mockSlack,
  mockTeams,
  queryAction,
  setupIntegrationsPage,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
const PHONE_HANDLE = "+15555550123";

function publishPhoneLinked(): void {
  context.mocks.data.agentPhoneIntegration({
    linked: true,
    phoneHandle: PHONE_HANDLE,
    agentPhoneNumber: "+19039853128",
    configured: true,
  });
  context.mocks.ably.trigger("agentphone:changed");
}

test("Integrations show current status and refresh after GitHub connects", async () => {
  const githubUrl =
    "https://github.com/login/oauth/authorize?client_id=github-oauth-client-id";
  mockSlack(context, {
    isConnected: true,
    isInstalled: true,
    isAdmin: true,
    scopeMismatch: true,
    reinstallUrl: "https://slack.com/oauth/reinstall?state=xyz",
    workspaceName: "Okou HQ",
  });
  context.mocks.data.githubIntegration(
    context.mocks.data.defaultGithubIntegration({
      isConnected: false,
      connectedGithubUserId: null,
      connectedGithubUsername: null,
      connectUrl: githubUrl,
    }),
  );
  context.mocks.data.agentPhoneIntegration({
    linked: true,
    phoneHandle: "+15555551212",
    agentPhoneNumber: "+19039853128",
    configured: true,
  });
  const providerWindow = context.mocks.browser.authWindow();
  Object.defineProperty(providerWindow, "location", {
    configurable: true,
    value: { href: "" },
  });
  const browserOpen = context.mocks.browser.open(providerWindow);

  await setupIntegrationsPage(context);

  await expect(screen.findByText("Slack")).resolves.toBeInTheDocument();
  expect(screen.getByText("Connected (Okou HQ)")).toBeInTheDocument();
  expect(screen.getByText(/update permissions/iu)).toBeInTheDocument();
  expect(getIntegrationCard("Phone")).toHaveTextContent("+15555551212");
  expect(
    getAction("button", "Connect", getIntegrationCard("Discord")),
  ).toBeEnabled();
  const githubCard = getIntegrationCard("GitHub");
  expect(getAction("button", "Connect", githubCard)).toBeInTheDocument();
  expect(screen.queryByText("Feishu")).not.toBeInTheDocument();

  click(getAction("button", "Connect", githubCard));

  await waitFor(() => {
    const opened = new URL(providerWindow.location.href);
    expect(opened.origin + opened.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(opened.searchParams.get("client_id")).toBe("github-oauth-client-id");
  });
  expect(browserOpen.calls).toStrictEqual([
    {
      url: "about:blank",
      target: "_blank",
      features: "width=600,height=700",
    },
  ]);

  context.mocks.data.githubIntegration(
    context.mocks.data.defaultGithubIntegration({
      isConnected: true,
      connectedGithubUserId: "98765",
      connectedGithubUsername: "octocat",
    }),
  );
  context.mocks.ably.trigger("github:changed");

  await expect(
    screen.findByText("Connected (@octocat)"),
  ).resolves.toBeInTheDocument();
});

test.each([true, false])(
  "Slack keeps account disconnect in its overflow menu (admin: %s)",
  async (isAdmin) => {
    let isConnected = true;
    context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
      return respond(200, {
        isConnected,
        isInstalled: true,
        isAdmin,
        installUrl: null,
        connectUrl: "https://slack.com/oauth/v2/authorize?state=reconnect",
        reinstallUrl: null,
        scopeMismatch: false,
        workspaceName: "Okou HQ",
      });
    });
    context.mocks.api(integrationsSlackContract.disconnect, ({ respond }) => {
      isConnected = false;
      return respond(200, { ok: true });
    });
    await setupIntegrationsPage(context);
    const card = getIntegrationCard("Slack");
    expect(within(card).getByText("Connected (Okou HQ)")).toBeInTheDocument();
    expect(queryAction("button", "Disconnect", card)).toBeNull();
    click(getAction("button", "More options", card));
    expect(queryAction("button", "Uninstall") !== null).toBe(isAdmin);
    click(getAction("button", "Disconnect"));
    await waitFor(() => {
      expect(getAction("button", "Connect", card)).toBeEnabled();
    });
    expect(within(card).queryByText("Connected (Okou HQ)")).toBeNull();
    expect(queryAction("button", "Disconnect")).toBeNull();
    expect(window.location.pathname).toBe("/works");
  },
);

test("A workspace member is directed to an admin for GitHub installation", async () => {
  mockSlack(context, { isConnected: true, isInstalled: true, isAdmin: false });
  context.mocks.api(
    integrationsGithubContract.getInstallation,
    ({ respond }) => {
      return respond(404, {
        error: { message: "GitHub installation not found", code: "NOT_FOUND" },
        installUrl: null,
      });
    },
  );

  await setupIntegrationsPage(context);

  const githubCard = await waitFor(() => {
    return getIntegrationCard("GitHub");
  });
  expect(
    within(githubCard).getByText(
      "Ask an organization admin to install the GitHub App",
    ),
  ).toBeInTheDocument();
  expect(queryAction("link", "Install GitHub App", githubCard)).toBeNull();
  expect(queryAction("button", "Connect", githubCard)).toBeNull();
});

test("Authorize the official Telegram bot directly in a new tab from Integrations", async () => {
  mockSlack(context, { isConnected: true, isInstalled: true, isAdmin: true });
  context.mocks.data.telegramIntegration({
    statuses: [
      {
        id: "official",
        kind: "official",
        username: "okou_bot",
        avatarUrl: null,
        agent: null,
        isOwner: false,
        isConnected: false,
        tokenStatus: "valid",
        domainConfigured: true,
        environment: {
          requiredSecrets: [],
          requiredVars: [],
          missingSecrets: [],
          missingVars: [],
        },
        official: {
          configured: true,
          usesDefaultAgent: true,
          linkedTelegramUserId: null,
        },
      },
    ],
  });
  context.mocks.api(
    integrationsTelegramContract.getLinkStatus,
    ({ respond }) => {
      return respond(200, {
        linked: false,
        installation: {
          id: "official",
          botUsername: "okou_bot",
          loginBotId: "987654321",
          domainConfigured: true,
        },
      });
    },
  );
  const authorizationWindow = context.mocks.browser.authWindow();
  Object.defineProperty(authorizationWindow, "location", {
    configurable: true,
    value: { href: "" },
  });
  const opened = context.mocks.browser.open(authorizationWindow);

  await setupIntegrationsPage(context);

  await expect(screen.findByText("Telegram")).resolves.toBeInTheDocument();
  const telegramCard = getIntegrationCard("Telegram");
  const connect = await waitFor(() => {
    const button = getAction("button", "Connect", telegramCard);
    expect(button).toBeEnabled();
    return button;
  });
  expect(connect).toBeEnabled();
  click(connect);

  expect(opened.calls).toStrictEqual([
    { url: "about:blank", target: "_blank", features: null },
  ]);
  const authUrl = await waitFor(() => {
    const url = new URL(authorizationWindow.location.href);
    expect(url.origin + url.pathname).toBe("https://oauth.telegram.org/auth");
    expect(url.searchParams.get("bot_id")).toBe("987654321");
    return url;
  });
  const callbackUrl = new URL(authUrl.searchParams.get("return_to") ?? "");
  const callback = {
    protocol: 2,
    operationId: callbackUrl.searchParams.get("operationId"),
    bot: "official",
  };
  act(() => {
    context.mocks.browser.message(
      { ...callback, type: "telegram-auth-bridge-ready" },
      { source: authorizationWindow, origin: callbackUrl.origin },
    );
    context.mocks.browser.message(
      {
        ...callback,
        type: "telegram-auth",
        data: {
          id: "99001",
          first_name: "Alice",
          username: "alice",
          auth_date: "1700000000",
          hash: "b".repeat(64),
        },
      },
      { source: authorizationWindow, origin: callbackUrl.origin },
    );
  });

  await expect(
    screen.findByText("Connected (@alice)"),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe("/works");
  expect(queryAction("button", "Connect", telegramCard)).toBeNull();
});

test("The shared phone card and connect dialog display digits instead of a vanity number", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  context.mocks.data.agentPhoneIntegration({
    linked: false,
    agentPhoneNumber: "+13144386568",
    configured: true,
  });
  context.mocks.api(
    integrationsAgentPhoneContract.createLinkCode,
    ({ respond }) => {
      return respond(200, {
        code: "74290618",
        expiresAt: "2026-09-20T15:10:00.000Z",
      });
    },
  );
  await setupIntegrationsPage(context);
  const phoneCard = await waitFor(() => {
    return getIntegrationCard("Phone");
  });
  expect(phoneCard).toHaveTextContent("+1 (314) 438-6568");
  click(getAction("button", "Connect phone", phoneCard));
  const dialog = await screen.findByRole("dialog", {
    name: "Text Okou from your iPhone",
  });
  await expect(
    within(dialog).findByText("+1 (314) 438-6568"),
  ).resolves.toBeVisible();
  click(getAction("button", "Copy +1 (314) 438-6568", dialog));
  await expect(
    screen.findByText("Phone number copied"),
  ).resolves.toBeInTheDocument();
  expect(clipboard.writes).toStrictEqual(["+13144386568"]);
});

test("A user connects AgentPhone with a prefilled one-time code", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  const code = "74290618";
  const messageHref = `sms:+19039853128?body=${code}`;
  context.mocks.data.agentPhoneIntegration({
    linked: false,
    agentPhoneNumber: "+19039853128",
    configured: true,
  });
  context.mocks.api(
    integrationsAgentPhoneContract.createLinkCode,
    ({ respond }) => {
      return respond(200, {
        code,
        expiresAt: "2026-09-20T15:10:00.000Z",
      });
    },
  );

  await setupIntegrationsPage(context);

  const phoneCard = await waitFor(() => {
    return getIntegrationCard("Phone");
  });
  expect(phoneCard).toHaveTextContent("iMessage or SMS to+1 (903) 985-3128");
  click(getAction("button", "Connect phone", phoneCard));

  const dialog = await screen.findByRole("dialog", {
    name: "Text Okou from your iPhone",
  });
  expect(dialog).toHaveAccessibleDescription(
    "Scan with your camera, then send the prefilled code.",
  );
  expect(
    within(dialog).getByText(
      "Use iMessage when possible. SMS and MMS replies may not arrive reliably.",
    ),
  ).toBeVisible();
  expect(within(dialog).getByText("Code")).toBeVisible();
  expect(within(dialog).getByText("Send to")).toBeVisible();
  expect(within(dialog).getByText("Expires in 10 minutes")).toBeVisible();
  expect(within(dialog).getByTestId("agentphone-link-qr")).toHaveAttribute(
    "data-sms-href",
    messageHref,
  );
  // The link completes on the phone, so the dialog offers no footer actions:
  // its only buttons copy what is sent, plus the dialog's own close.
  expect(
    queryAllByRoleFast("button", dialog).map((button) => {
      return button.getAttribute("aria-label") ?? button.textContent;
    }),
  ).toStrictEqual([
    `Copy connection code ${code}`,
    "Copy +1 (903) 985-3128",
    "Close",
  ]);
  // Where the QR cannot be scanned -- the phone itself -- a button opens
  // Messages with the same prefilled code in its place.
  expect(
    within(dialog).getByTestId("agentphone-open-messages"),
  ).toHaveAttribute("href", messageHref);
  // Rewards are off for this workspace, so the dialog promises none.
  expect(within(dialog).queryByText("+1,000")).not.toBeInTheDocument();

  click(getAction("button", `Copy connection code ${code}`, dialog));
  await expect(
    screen.findByText("Connection code copied"),
  ).resolves.toBeInTheDocument();
  click(getAction("button", "Copy +1 (903) 985-3128", dialog));
  await expect(
    screen.findByText("Phone number copied"),
  ).resolves.toBeInTheDocument();
  expect(clipboard.writes).toStrictEqual([code, "+19039853128"]);

  publishPhoneLinked();

  await waitFor(() => {
    expect(getIntegrationCard("Phone")).toHaveTextContent(PHONE_HANDLE);
    expect(
      screen.queryByRole("dialog", { name: "Text Okou from your iPhone" }),
    ).not.toBeInTheDocument();
  });
});

test("An admin can begin Microsoft Teams installation", async () => {
  const browserOpen = context.mocks.browser.open();
  mockSlack(context, { isConnected: true, isInstalled: true, isAdmin: true });
  mockTeams(context, { isConnected: false, isInstalled: false, isAdmin: true });

  await setupIntegrationsPage(context);

  const teamsCard = await waitFor(() => {
    return getIntegrationCard("Microsoft Teams");
  });
  const install = getAction("button", "Install in Teams", teamsCard);
  expect(
    screen.getByText(
      "Connect your Microsoft account, then install the Teams app",
    ),
  ).toBeInTheDocument();

  click(install);

  expect(browserOpen.calls).toHaveLength(1);
  const opened = browserOpen.calls[0];
  expect(opened?.target).toBe("_blank");
  const url = new URL(opened?.url ?? "", window.location.origin);
  expect(url.pathname).toBe("/api/teams/oauth/connect");
  expect(url.searchParams.get("orgId")).toBe("org_1");
  expect(url.searchParams.get("userId")).toBe("user_1");
});

test("Microsoft Teams offers Connect after installation", async () => {
  mockSlack(context, { isConnected: true, isInstalled: true, isAdmin: true });
  mockTeams(context, { isConnected: false, isInstalled: true, isAdmin: true });

  await setupIntegrationsPage(context);

  const teamsCard = await waitFor(() => {
    return getIntegrationCard("Microsoft Teams");
  });
  expect(getAction("button", "Connect", teamsCard)).toBeInTheDocument();
  expect(queryAction("button", "Install in Teams", teamsCard)).toBeNull();
});

test("Microsoft Teams shows its connected team name", async () => {
  mockSlack(context, { isConnected: true, isInstalled: true, isAdmin: true });
  mockTeams(context, {
    isConnected: true,
    isInstalled: true,
    isAdmin: true,
    tenantName: "Okou Tenant",
    teamName: "Core Team",
  });

  await setupIntegrationsPage(context);

  await expect(
    screen.findByText("Microsoft Teams"),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText("Connected (Core Team)")).toBeInTheDocument();
  expect(getAction("link", "Install GitHub App")).toBeInTheDocument();
});

test("Uninstalling Microsoft Teams requires confirmation", async () => {
  mockSlack(context, { isConnected: true, isInstalled: true, isAdmin: true });
  mockTeams(context, { isConnected: false, isInstalled: true, isAdmin: true });

  await setupIntegrationsPage(context);

  await expect(
    screen.findByText("Microsoft Teams"),
  ).resolves.toBeInTheDocument();
  click(getAction("button", "More Microsoft Teams options"));
  click(getAction("button", "Uninstall Microsoft Teams"));

  await expect(
    screen.findByRole("dialog", {
      name: "Uninstall Microsoft Teams integration?",
    }),
  ).resolves.toBeInTheDocument();
});

test.each([false, true])(
  "Slack starts OAuth directly and refreshes the original Works page (installed: %s)",
  async (isInstalled) => {
    let connected = false;
    context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
      return respond(200, {
        isConnected: connected,
        isInstalled: isInstalled || connected,
        isAdmin: true,
        installUrl: "https://slack.example.test/install",
        connectUrl: "https://slack.example.test/connect",
        workspaceName: connected ? "Verified workspace" : null,
      });
    });
    const opened = context.mocks.browser.open();
    await setupIntegrationsPage(context);
    const card = getIntegrationCard("Slack");
    click(
      getAction("button", isInstalled ? "Connect" : "Install to Slack", card),
    );
    const url = new URL(opened.calls[0]!.url!);
    expect(url.origin).toBe("https://slack.example.test");
    expect(url.pathname).toBe(isInstalled ? "/connect" : "/install");
    expect(opened.calls[0]!.target).toBe("_blank");
    expect(pathname()).toBe("/works");
    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription("slack:changed")).toBeTruthy();
    });
    connected = true;
    context.mocks.ably.trigger("slack:changed");
    await expect(
      within(card).findByText("Connected (Verified workspace)"),
    ).resolves.toBeInTheDocument();
    expect(pathname()).toBe("/works");
  },
);

test("Slack permission refresh reports actual scope recovery on the original Works page", async () => {
  let scopeMismatch = true;
  context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
    return respond(200, {
      isConnected: true,
      isInstalled: true,
      isAdmin: true,
      scopeMismatch,
      reinstallUrl: scopeMismatch
        ? "https://slack.example.test/reinstall"
        : null,
      workspaceName: "Verified workspace",
    });
  });
  const opened = context.mocks.browser.open();
  await setupIntegrationsPage(context);
  const card = getIntegrationCard("Slack");
  click(getAction("button", "Update Permissions", card));
  const url = new URL(opened.calls[0]!.url!);
  expect(url.origin).toBe("https://slack.example.test");
  expect(url.pathname).toBe("/reinstall");
  expect(opened.calls[0]!.target).toBe("_blank");
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription("slack:changed")).toBeTruthy();
  });
  scopeMismatch = false;
  context.mocks.ably.trigger("slack:changed");
  await expect(
    screen.findByText("Permissions updated"),
  ).resolves.toBeInTheDocument();
  expect(
    queryAction("button", "Update Permissions", card),
  ).not.toBeInTheDocument();
  expect(pathname()).toBe("/works");
});
