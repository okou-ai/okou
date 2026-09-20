import { integrationsGithubContract } from "@okouai/api-contracts/contracts/integrations-github";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click } from "../../../__tests__/page-helper.ts";
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
    publicBrand: "okou",
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
    publicBrand: "okou",
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

  await setupIntegrationsPage(context, { agentPhone: true });

  await expect(screen.findByText("Slack")).resolves.toBeInTheDocument();
  expect(screen.getByText("Connected (Okou HQ)")).toBeInTheDocument();
  expect(screen.getByText(/update permissions/iu)).toBeInTheDocument();
  expect(getIntegrationCard("Phone")).toHaveTextContent("+15555551212");
  const githubCard = getIntegrationCard("GitHub");
  expect(getAction("button", "Connect", githubCard)).toBeInTheDocument();
  expect(screen.queryByText("Feishu")).not.toBeInTheDocument();
  expect(screen.queryByText("Strapi")).not.toBeInTheDocument();

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

test("Open Telegram settings from Integrations", async () => {
  mockSlack(context, { isConnected: true, isInstalled: true, isAdmin: true });

  await setupIntegrationsPage(context);

  await expect(screen.findByText("Telegram")).resolves.toBeInTheDocument();
  click(getAction("link", "Open Telegram settings"));

  await expect(
    waitFor(() => {
      return getAction("link", "Back to integrations");
    }),
  ).resolves.toBeInTheDocument();
});

test("Integrations hide AgentPhone when its feature switch is disabled", async () => {
  await setupIntegrationsPage(context);

  await expect(screen.findByText("Telegram")).resolves.toBeInTheDocument();
  expect(screen.queryByText("Phone")).not.toBeInTheDocument();
});

test("A user connects AgentPhone through the inbound message flow", async () => {
  context.mocks.data.agentPhoneIntegration({
    linked: false,
    publicBrand: "okou",
    agentPhoneNumber: "+19039853128",
    configured: true,
  });

  await setupIntegrationsPage(context, { agentPhone: true });

  const phoneCard = await waitFor(() => {
    return getIntegrationCard("Phone");
  });
  expect(phoneCard).toHaveTextContent("iMessage or SMS to+1 (903) 985-3128");
  click(getAction("button", "Connect phone", phoneCard));

  const dialog = await screen.findByRole("dialog", { name: "Connect phone" });
  expect(dialog).toHaveAccessibleDescription(
    "Message this AgentPhone number from the phone you want to connect.",
  );
  expect(
    within(dialog).getByText(
      "Use iMessage when possible. SMS and MMS replies may not arrive reliably.",
    ),
  ).toBeVisible();
  expect(within(dialog).getByText("Send “hi”")).toBeVisible();
  expect(within(dialog).getByText("Open our reply")).toBeVisible();
  expect(
    within(dialog).getByText(
      "Tap the connection link within 10 minutes to finish.",
    ),
  ).toBeVisible();
  expect(getAction("link", "Open Messages", dialog)).toHaveAttribute(
    "href",
    "sms:+19039853128?body=hi",
  );

  publishPhoneLinked();

  await waitFor(() => {
    expect(getIntegrationCard("Phone")).toHaveTextContent(PHONE_HANDLE);
    expect(
      screen.queryByRole("dialog", { name: "Connect phone" }),
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

test("Microsoft Teams does not expose a tenant identifier as a display name", async () => {
  mockSlack(context, { isConnected: true, isInstalled: true, isAdmin: true });
  mockTeams(context, {
    isConnected: true,
    isInstalled: true,
    isAdmin: true,
    tenantId: "tenant-123",
    tenantName: null,
    teamName: null,
  });

  await setupIntegrationsPage(context);

  const teamsCard = await waitFor(() => {
    return getIntegrationCard("Microsoft Teams");
  });
  await waitFor(() => {
    expect(within(teamsCard).getByText("Connected")).toBeInTheDocument();
  });
  expect(
    within(teamsCard).queryByText("Connected (tenant-123)"),
  ).not.toBeInTheDocument();
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
