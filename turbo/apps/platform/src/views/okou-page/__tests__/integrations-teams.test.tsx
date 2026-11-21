import { test, expect } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
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
