import { initSentry } from "../../../lib/sentry.ts";
import { expect, test, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findAction,
  getIntegrationCard,
  queryAction,
} from "./connector-integrations-test-helpers.ts";
import {
  authorizeUrl,
  authorizationService,
  browserPeer,
  consentFragment,
  consentOpener,
  consentState,
  harbor,
  statusService,
  watchApproval,
} from "./discord-consent-fixtures.ts";

const context = testContext();
test("discord-oauth-compatibility-001 approving and closing consent connects the original Works card", async () => {
  const tab = browserPeer(context);
  context.mocks.browser.open(tab);
  const service = authorizationService(context, {});
  service.release.resolve();
  await setupPage({ context, path: "/works", auth: harbor.auth });
  const card = getIntegrationCard("Discord");
  click(await findAction("button", "Connect", card));
  await service.pending.promise;
  expect(tab.location.href).toBe(authorizeUrl);
  service.approve();
  tab.close();
  await waitFor(() => {
    return expect(card).toHaveTextContent(/\bConnected\b/u);
  });
  expect(location.pathname).toBe("/works");
  expect(tab.closed).toBeTruthy();
  expect(tab.location.href).toBe(authorizeUrl);
});

test("discord-oauth-compatibility-002 a ready consent tab receives the matching result once after Works connects", async () => {
  const tab = browserPeer(context);
  context.mocks.browser.open(tab);
  const delivery = vi.spyOn(tab, "postMessage");
  const service = authorizationService(context, {});
  service.release.resolve();
  await setupPage({ context, path: "/works", auth: harbor.auth });
  const card = getIntegrationCard("Discord");
  click(await findAction("button", "Connect", card));
  await service.pending.promise;
  expect(tab.location.href).toBe(authorizeUrl);
  service.approve();
  await waitFor(() => {
    return expect(card).toHaveTextContent(/\bConnected\b/u);
  });
  const ready = { type: "discord-oauth-ready", state: consentState };
  context.mocks.browser.message(ready, {
    origin: location.origin,
    source: tab,
  });
  context.mocks.browser.message(ready, {
    origin: location.origin,
    source: tab,
  });
  expect(delivery.mock.calls).toStrictEqual([
    [
      {
        type: "discord-oauth-result",
        state: consentState,
        status: "connected",
      },
      location.origin,
    ],
  ]);
  expect(tab.location.href).toBe(authorizeUrl);
  expect(location.pathname).toBe("/works");
});

test.each([
  ["discord-oauth-compatibility-003", "/works"],
  ["discord-oauth-compatibility-004", "/settings/discord"],
] as const)(
  "%s recovers a pending response delivered after consent closes",
  async (_id, path) => {
    const telemetry = context.mocks.sentry();
    initSentry();
    const service = authorizationService(context, {});
    const tab = browserPeer(context);
    context.mocks.browser.open(tab);
    await setupPage({ context, path, auth: harbor.auth });
    const surface =
      path === "/works" ? getIntegrationCard("Discord") : document.body;
    click(await findAction("button", "Connect", surface));
    await service.checking.promise;
    expect(tab.location.href).toBe(authorizeUrl);
    service.approve();
    tab.close();
    service.release.resolve();
    const confirmation =
      path === "/works" ? /^Connected\b/u : "Connected to Discord";
    await expect(
      within(surface).findByText(confirmation),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      return expect(new URL(location.href).searchParams.get("status")).toBe(
        path === "/works" ? null : "connected",
      );
    });
    expect(location.pathname).toBe(path);
    expect(tab.closed).toBeTruthy();
    expect(
      screen.queryByText("Discord authorization was cancelled."),
    ).toBeNull();
    expect(telemetry.reports).toStrictEqual([]);
  },
);

test("discord-oauth-compatibility-005 a callback without an opener discards the proof without redeeming it", async () => {
  vi.stubGlobal("opener", null);
  const approval = watchApproval(context);
  statusService(context, () => {
    return {};
  });
  await setupPage({
    context,
    auth: harbor.auth,
    path: "/settings/discord?status=pending" + consentFragment,
  });
  expect(
    screen.getByText("This authorization was interrupted or refreshed."),
  ).toBeInTheDocument();
  expect(location.hash).toBe("");
  expect(queryAction("link", "Open Discord")).toBeNull();
  expect(approval.settled()).toBeFalsy();
});

test("discord-oauth-compatibility-008 the first matching completion settles the consent page", async () => {
  statusService(context, () => {
    return { isConnected: true, guildId: harbor.guild };
  });
  const receipt = watchApproval(context);
  const finish = consentOpener(context);
  await setupPage({
    context,
    path: "/settings/discord?status=pending" + consentFragment,
    auth: harbor.auth,
  });
  await receipt.promise;
  finish("connected");
  finish("error");
  await expect(
    screen.findByText("Connected to Discord"),
  ).resolves.toBeInTheDocument();
  expect(new URL(location.href).searchParams.get("status")).toBe("connected");
});

test("discord-oauth-compatibility-014 leaving a failed installation closes the original consent popup", async () => {
  const tab = browserPeer(context);
  context.mocks.browser.open(tab);
  const service = authorizationService(
    context,
    { guildId: harbor.guild, flow: "install" },
    { isConnected: true, guildId: harbor.previousGuild },
  );
  await setupPage({
    context,
    path: "/settings/discord/install?guild_id=" + harbor.guild,
    auth: harbor.auth,
  });
  click(await findAction("button", "Join new server"));
  await service.checking.promise;
  service.approve();
  service.fail("conflict");
  service.release.resolve();
  await expect(
    screen.findByText("Disconnect the existing Discord identity first"),
  ).resolves.toBeInTheDocument();
  expect(queryAction("link", "Open Discord")).toBeNull();
  expect(tab.closed).toBeFalsy();
  expect(tab.location.href).toBe(authorizeUrl);
  click(await findAction("link", "Back to settings"));
  await screen.findByText("Microsoft Teams");
  expect(location.pathname).toBe("/works");
  expect(tab.closed).toBeTruthy();
});
