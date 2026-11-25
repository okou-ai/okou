import {
  findAction,
  mockSlack,
  mockTeams,
} from "../../okou-page/__tests__/connector-integrations-test-helpers.ts";
import { test, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  authorizationService,
  authorizeUrl,
  browserPeer,
  harbor,
  statusService,
} from "../../okou-page/__tests__/discord-consent-fixtures.ts";
import {
  connectedGmailSource,
  mockOnboardingConnectorCatalog,
} from "./onboarding-catalog-test-helpers.ts";

const context = testContext();
function openChannels() {
  mockSlack(context);
  mockTeams(context);
  context.mocks.browser.matchMedia(false);
  context.mocks.data.onboardingStatus({
    isAdmin: true,
    needsOnboarding: true,
    onboardingComplete: false,
  });
  mockOnboardingConnectorCatalog(context, [connectedGmailSource()]);
  return setupPage({ context, path: "/onboarding/slack", auth: harbor.auth });
}
function discord() {
  return findAction("button", "Discord");
}
function addedDiscord() {
  return waitFor(() => {
    const button = screen.getByText("Discord").closest("button");
    expect(button).toHaveTextContent("Added");
    return button;
  });
}
function next() {
  return findAction("button", "Continue");
}
test("onboarding-discord-001 an administrator can continue to the first task after Discord finishes", async () => {
  const service = authorizationService(context, {}, { isAdmin: true });
  const tab = browserPeer(context);
  const browser = context.mocks.browser.open(tab);
  await openChannels();
  await expect(next()).resolves.toBeDisabled();
  click(await discord());
  await service.checking.promise;
  expect(browser.calls).toContainEqual(
    expect.objectContaining({ target: "_blank" }),
  );
  expect(tab.location.href).toBe(authorizeUrl);
  await expect(discord()).resolves.toBeDisabled();
  await expect(next()).resolves.toBeDisabled();
  expect(location.pathname).toBe("/onboarding/slack");
  service.approve();
  service.release.resolve();
  const added = await addedDiscord();
  expect(added).toBeDisabled();
  await expect(next()).resolves.toBeEnabled();
  click(await next());
  await waitFor(() => {
    return expect(location.pathname).toBe("/onboarding/capabilities");
  });
  click(await next());
  await screen.findByText("Let’s start your first task");
  expect(location.pathname).toBe("/onboarding/ready");
});
test("onboarding-discord-003 losing the Discord connection makes the chat step required again", async () => {
  let connected = true;
  statusService(context, () => {
    return { isAdmin: true, isConnected: connected };
  });
  await openChannels();
  await addedDiscord();
  await expect(next()).resolves.toBeEnabled();
  connected = false;
  context.mocks.ably.trigger("discord:changed");
  await screen.findByRole("heading", { name: "Keep Okou a message away" });
  await expect(discord()).resolves.toBeEnabled();
  await expect(next()).resolves.toBeDisabled();
});
