import { now } from "../../../lib/time.ts";
import { integrationsAgentPhoneContract } from "@okouai/api-contracts/contracts/integrations-agentphone";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { integrationsSlackContract } from "@okouai/api-contracts/contracts/integrations-slack";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  mockSlack,
  mockTeams,
  getIntegrationCard,
  setupIntegrationsPage,
} from "./connector-integrations-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
const context = testContext();
test("integrations-hub-status-006 the phone dialog copies its international destination", async () => {
  context.mocks.data.agentPhoneIntegration({
    linked: false,
    configured: true,
    agentPhoneNumber: "+13144386568",
  });
  context.mocks.api(
    integrationsAgentPhoneContract.createLinkCode,
    ({ respond }) => {
      return respond(200, {
        code: "53269531",
        expiresAt: new Date(now() + 600_000).toISOString(),
      });
    },
  );
  const clipboard = context.mocks.browser.clipboardWriteText();
  await setupIntegrationsPage(context);
  await screen.findByText("Phone");
  const card = getIntegrationCard("Phone");
  expect(card).toHaveTextContent("Text-message access to Okou");
  expect(card).not.toHaveTextContent("+1 (314) 438-6568");
  click(await findFastControl("button", /Connect/i, card));
  const dialog = await screen.findByRole("dialog", {
    name: "Text Okou from your iPhone",
  });
  await within(dialog).findByText("+1 (314) 438-6568");
  click(await findFastControl("button", /^Copy .*314/, dialog));
  await screen.findByText("Phone number copied");
  expect(clipboard.writes).toStrictEqual(["+13144386568"]);
});
test("integrations-hub-status-011 uninstalling the installed Teams integration asks for confirmation", async () => {
  mockTeams(context, { isInstalled: true, isConnected: false, isAdmin: true });
  await setupIntegrationsPage(context);
  await screen.findByText("Microsoft Teams");
  click(
    await findFastControl(
      "button",
      /option/i,
      getIntegrationCard("Microsoft Teams"),
    ),
  );
  click(await findFastControl("button", "Uninstall Microsoft Teams"));
  await expect(
    screen.findByRole("dialog", {
      name: "Uninstall Microsoft Teams integration?",
    }),
  ).resolves.toBeInTheDocument();
});
test("integrations-hub-status-002 Slack disconnect is reached from the installed workspace menu", async () => {
  let connected = true;
  context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
    return respond(200, {
      isConnected: connected,
      isInstalled: true,
      isAdmin: true,
      workspaceName: "Okou HQ",
      connectUrl: "https://slack.example.test/connect",
      scopeMismatch: false,
      installUrl: null,
      reinstallUrl: null,
    });
  });
  context.mocks.api(integrationsSlackContract.disconnect, ({ respond }) => {
    connected = false;
    return respond(200, { ok: true });
  });
  await setupIntegrationsPage(context);
  await screen.findByText(/Connected \(Okou HQ\)/);
  const card = getIntegrationCard("Slack");
  expect(within(card).queryByText("Disconnect")).not.toBeInTheDocument();
  click(await findFastControl("button", /option/i, card));
  await findFastControl("button", "Uninstall");
  click(await findFastControl("button", "Disconnect"));
  await findFastControl("button", /Connect/i, card);
  expect(card).not.toHaveTextContent("Connected (Okou HQ)");
  expect(location.pathname).toBe("/works");
});

test("integrations-hub-status-012 installing Slack opens its installation destination and refreshes the original card", async () => {
  const installUrl = "https://slack.example.test/workspace/install";
  const connectUrl = "https://slack.example.test/member/connect";
  mockSlack(context, { isAdmin: true, installUrl, connectUrl });
  const opened = context.mocks.browser.open(null);
  await setupIntegrationsPage(context);
  await screen.findByText("Slack");
  click(
    await findFastControl(
      "button",
      "Install to Slack",
      getIntegrationCard("Slack"),
    ),
  );
  const tab = opened.calls.find((entry) => {
    return entry.target === "_blank";
  });
  expect(tab).toBeDefined();
  const url = new URL(tab!.url!);
  expect(url.origin + url.pathname).toBe(installUrl);
  mockSlack(context, {
    isInstalled: true,
    isConnected: true,
    workspaceName: "Verified workspace",
    isAdmin: true,
    installUrl,
    connectUrl,
  });
  context.mocks.ably.trigger("slack:changed");
  await within(getIntegrationCard("Slack")).findByText(
    "Connected (Verified workspace)",
  );
  expect(location.pathname).toBe("/works");
});
