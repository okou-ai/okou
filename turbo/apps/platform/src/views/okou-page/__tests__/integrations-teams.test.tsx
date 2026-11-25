import { teamsConnectContract } from "@okouai/api-contracts/contracts/teams-connect";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { test, expect } from "vitest";
import { click, startPage, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findAction,
  getIntegrationCard,
  mockTeams,
  setupIntegrationsPage,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();

test("integrations-teams-004 the pending organization install opens its install flow and stays on Works", async () => {
  const browser = context.mocks.browser.open();
  const destination =
    "https://api.example.test/api/teams/oauth/connect?flow=install&workspace=shore";
  mockTeams(context, {
    pendingInstallation: true,
    isConnected: false,
    installUrl: destination,
  });
  await setupIntegrationsPage(context);
  const card = getIntegrationCard("Microsoft Teams");
  click(await findAction("button", "Install in Teams", card));
  const popup = browser.calls.find(({ target }) => {
    return target === "_blank";
  });
  expect(popup).toBeDefined();
  const url = new URL(popup?.url ?? "", "https://app.okou.ai");
  expect(url.origin + url.pathname).toBe(
    "https://api.example.test/api/teams/oauth/connect",
  );
  expect(url.searchParams.get("flow")).toBe("install");
  expect(card).not.toHaveTextContent(/\bConnected\b/u);
  expect(location.pathname).toBe("/works");
});

test("integrations-teams-008 a member opens their verified identity connection without an organization installer", async () => {
  const browser = context.mocks.browser.open();
  const target =
    "https://api.example.test/api/teams/oauth/connect?connectState=verified-identity";
  mockTeams(context, {
    isAdmin: false,
    isInstalled: false,
    installUrl: null,
    connectUrl: target,
  });
  await setupIntegrationsPage(context);
  const card = getIntegrationCard("Microsoft Teams");
  click(await findAction("button", "Connect", card));
  const popup = browser.calls.find(({ target }) => {
    return target === "_blank";
  });
  expect(popup).toBeDefined();
  const url = new URL(popup?.url ?? "", "https://app.okou.ai");
  expect(url.origin + url.pathname).toBe(
    "https://api.example.test/api/teams/oauth/connect",
  );
  expect(url.searchParams.get("connectState")).toBe("verified-identity");
  expect(location.pathname).toBe("/works");
});

test("integrations-teams-005 returning focus recovers only the unavailable Teams card", async () => {
  let available = false;
  context.mocks.api(teamsConnectContract.getStatus, ({ respond }) => {
    return available
      ? respond(200, {
          isInstalled: false,
          isAdmin: true,
          isConnected: false,
          linkedAccounts: [],
          pendingInstallation: false,
          installUrl: "/api/teams/oauth/connect?flow=install",
        })
      : respond(503, {
          error: {
            code: "UNAVAILABLE",
            message: "Cannot fetch Harbor Teams status",
          },
        });
  });
  const page = await startPage({
    context,
    path: "/works",
    featureSwitches: { [FeatureSwitchKey.WorksChannelCards]: false },
  });
  await expect(page.ready).rejects.toThrow(/Cannot fetch|Failed to fetch/i);
  const card = getIntegrationCard("Microsoft Teams");
  expect(card).toHaveTextContent("Unable to check your Teams connection.");
  expect(getIntegrationCard("Slack")).toBeInTheDocument();
  available = true;
  window.dispatchEvent(new Event("focus"));
  await expect(
    findAction("button", "Install in Teams", card),
  ).resolves.toBeEnabled();
});

test("integrations-teams-006 the preview installation keeps the prompt and access value on the API host", async () => {
  const origin = "https://pr-749-api.vm6.ai";
  mockTeams(context, {
    installUrl: origin + "/api/teams/oauth/connect?flow=install",
  });
  const browser = context.mocks.browser.open();
  await setupPage({
    context,
    host: "pr-749-app.omby.ai",
    path: "/works?prompt=Retain+my+work&x-vercel-protection-bypass=harbor-preview",
    featureSwitches: { [FeatureSwitchKey.WorksChannelCards]: false },
  });
  click(
    await findAction(
      "button",
      "Install in Teams",
      getIntegrationCard("Microsoft Teams"),
    ),
  );
  const popup = browser.calls.at(-1);
  expect(popup?.target).toBe("_blank");
  const target = new URL(popup?.url ?? "");
  expect(target.origin).toBe(origin);
  expect(target.searchParams.get("prompt")).toBe("Retain my work");
  expect(target.searchParams.get("x-vercel-protection-bypass")).toBe(
    "harbor-preview",
  );
  expect(location.pathname).toBe("/works");
});

test("integrations-teams-009 the independent tenant stays connected while installation starts", async () => {
  mockTeams(context, {
    isInstalled: false,
    isConnected: true,
    tenantName: "Personal identity tenant",
    linkedAccounts: [
      {
        tenantId: "harbor",
        teamsUserId: "user27",
        displayName: null,
        teamsAadObjectId: null,
        userPrincipalName: null,
      },
    ],
    installUrl: "/api/teams/oauth/connect?connectState=admin-install",
  });
  const browser = context.mocks.browser.open();
  await setupIntegrationsPage(context);
  const card = getIntegrationCard("Microsoft Teams");
  expect(card).toHaveTextContent("Connected (Personal identity tenant)");
  click(await findAction("button", "Install in Teams", card));
  const href = new URL(browser.calls.at(-1)?.url ?? "", location.href);
  expect(href.searchParams.get("connectState")).toBe("admin-install");
  expect(card).toHaveTextContent("Connected (Personal identity tenant)");
});
