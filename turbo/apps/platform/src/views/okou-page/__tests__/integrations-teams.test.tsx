import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  teamsConnectContract,
  type TeamsConnectStatus,
} from "@okouai/api-contracts/contracts/teams-connect";
import { act, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getAction,
  getIntegrationCard,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
function status(
  overrides: Partial<TeamsConnectStatus> = {},
): TeamsConnectStatus {
  return {
    isInstalled: false,
    isConnected: false,
    isAdmin: true,
    pendingInstallation: false,
    linkedAccounts: [],
    connectUrl: "/api/teams/oauth/connect?orgId=org_default",
    installUrl: "/api/teams/oauth/connect?flow=install&orgId=org_default",
    ...overrides,
  };
}

test("Works Connect starts the required Teams installation", async () => {
  context.mocks.api(teamsConnectContract.getStatus, ({ respond }) => {
    return respond(200, status({ pendingInstallation: true }));
  });
  const open = context.mocks.browser.open();
  await setupPage({
    featureSwitches: { [FeatureSwitchKey.WorksChannelCards]: true },
    context,
    path: "/works",
  });
  const card = getIntegrationCard("Microsoft Teams");
  click(getAction("button", "Connect", card));
  expect(new URL(open.calls[0]?.url ?? "").searchParams.get("flow")).toBe(
    "install",
  );
  expect(card).not.toHaveTextContent("Connected");
  expect(window.location.pathname).toBe("/works");
});

test("Returning to Works retries a failed Teams read without hiding the other integrations", async () => {
  let failed = true;
  context.mocks.api(teamsConnectContract.getStatus, ({ respond }) => {
    if (failed) {
      throw Response.error();
    }
    return respond(200, status());
  });
  await expect(
    setupPage({
      featureSwitches: { [FeatureSwitchKey.WorksChannelCards]: true },
      context,
      path: "/works",
    }),
  ).rejects.toThrow("Failed to fetch");
  await waitFor(() => {
    expect(getIntegrationCard("Microsoft Teams")).toHaveTextContent(
      "Unable to check your Teams connection.",
    );
  });
  const card = getIntegrationCard("Microsoft Teams");
  expect(getIntegrationCard("Slack")).toBeInTheDocument();
  failed = false;
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await waitFor(() => {
    return expect(getAction("button", "Connect", card)).toBeEnabled();
  });
});

test("Teams actions preserve prompt and protected preview access", async () => {
  context.mocks.api(teamsConnectContract.getStatus, ({ respond }) => {
    return respond(
      200,
      status({
        installUrl:
          "https://pr-431-api.vm6.ai/api/teams/oauth/connect?flow=install&orgId=org_default",
      }),
    );
  });
  const open = context.mocks.browser.open();
  await setupPage({
    featureSwitches: { [FeatureSwitchKey.WorksChannelCards]: true },
    context,
    host: "pr-431-app-okou-app-preview.vm0.workers.dev",
    path: "/works?prompt=Retain+my+work&x-vercel-protection-bypass=preview-secret",
  });
  click(getAction("button", "Connect", getIntegrationCard("Microsoft Teams")));
  const url = new URL(open.calls[0]?.url ?? "");
  expect(url.origin).toBe("https://pr-431-api.vm6.ai");
  expect(url.searchParams.get("prompt")).toBe("Retain my work");
  expect(url.searchParams.get("x-vercel-protection-bypass")).toBe(
    "preview-secret",
  );
  expect(window.location.pathname).toBe("/works");
});

test("Members can connect a Teams identity without an organization bot", async () => {
  context.mocks.api(teamsConnectContract.getStatus, ({ respond }) => {
    return respond(
      200,
      status({
        isAdmin: false,
        installUrl: null,
        connectUrl: "/api/teams/oauth/connect?connectState=verified-identity",
      }),
    );
  });
  const open = context.mocks.browser.open();
  await setupPage({
    featureSwitches: { [FeatureSwitchKey.WorksChannelCards]: true },
    context,
    path: "/works",
  });
  const card = getIntegrationCard("Microsoft Teams");
  click(getAction("button", "Connect", card));
  expect(
    new URL(open.calls[0]?.url ?? "").searchParams.get("connectState"),
  ).toBe("verified-identity");
});

test("An independent Teams identity remains connected after bot removal", async () => {
  context.mocks.api(teamsConnectContract.getStatus, ({ respond }) => {
    return respond(
      200,
      status({
        isInstalled: false,
        isConnected: true,
        isAdmin: true,
        connectUrl: null,
        tenantName: "Personal identity tenant",
        installUrl: "/api/teams/oauth/connect?connectState=admin-install",
      }),
    );
  });
  const open = context.mocks.browser.open();
  await setupPage({
    featureSwitches: { [FeatureSwitchKey.WorksChannelCards]: true },
    context,
    path: "/works",
  });
  await expect(
    screen.findByText("Connected (Personal identity tenant)"),
  ).resolves.toBeInTheDocument();
  const card = getIntegrationCard("Microsoft Teams");
  click(getAction("button", "More Microsoft Teams options", card));
  click(getAction("button", "Install in Teams"));
  expect(
    new URL(open.calls[0]?.url ?? "").searchParams.get("connectState"),
  ).toBe("admin-install");
  expect(card).toHaveTextContent("Connected (Personal identity tenant)");
});
