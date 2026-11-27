import { teamsConnectContract } from "@okouai/api-contracts/contracts/teams-connect";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import {
  testContext,
  createTestRuntime,
} from "../../../signals/__tests__/test-helpers.ts";
import { click, setupPage, startPage } from "../../../__tests__/page-helper.ts";
import {
  findAction,
  mockTeams,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
const account = Object.freeze({
  tenantId: "harbor-tenant",
  teamsUserId: "harbor-member",
  teamsAadObjectId: null,
  displayName: "Elian",
  userPrincipalName: "elian@example.test",
});
const settings = "/settings/teams";
test("teams-connect-page-001 a bare return displays the verified Teams connection without opening a tab", async () => {
  mockTeams(context, { isConnected: true, linkedAccounts: [account] });
  const browser = context.mocks.browser.open();
  await setupPage({
    context,
    path: settings + "?teamName=False+team&botName=False+bot",
  });
  await screen.findByText("Connected to Microsoft Teams");
  expect(
    screen.getByText("Your Teams account is connected."),
  ).toBeInTheDocument();
  const link = await findAction("link", "Open Teams");
  expect(link).toHaveAttribute("href", "https://teams.microsoft.com/");
  expect(link).toHaveAttribute("target", "_blank");
  expect(browser.calls).toStrictEqual([]);
  expect(screen.queryByText(/False team|False bot/u)).toBeNull();
});
test("teams-connect-page-005 the caller cannot use a different member's connected identity", async () => {
  mockTeams(context, {
    isConnected: true,
    linkedAccounts: [account],
    tenantId: account.tenantId,
  });
  await setupPage({
    context,
    path: settings + "?tenantId=harbor-tenant&teamsUserId=another-member",
  });
  await screen.findByText("Connect Microsoft Teams");
  expect(
    screen.getByText(
      "The requested Teams account or workspace does not match the current connection.",
    ),
  ).toBeInTheDocument();
});
test("teams-connect-page-008 a blocked authorization keeps the draft and leaves the retry enabled", async () => {
  const browser = context.mocks.browser.open(null);
  mockTeams(context, { connectUrl: "https://teams.example.test/authorize" });
  await setupPage({ context, path: settings + "?prompt=Keep+my+draft" });
  const authorize = await findAction("button", "Authorize Microsoft Teams");
  click(authorize);
  const url = new URL(browser.calls.at(-1)?.url ?? "");
  expect(url.origin + url.pathname).toBe(
    "https://teams.example.test/authorize",
  );
  expect(url.searchParams.get("prompt")).toBe("Keep my draft");
  expect(authorize).toBeEnabled();
  expect(screen.getByText("Connect Microsoft Teams")).toBeInTheDocument();
  expect(
    screen.queryByText(/cancelled|connected to Microsoft Teams/iu),
  ).toBeNull();
});
test("teams-connect-page-009 a visibility return reconciles the pending installation", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const browser = context.mocks.browser.open();
  mockTeams(context, {
    pendingInstallation: true,
    linkedAccounts: [account],
    installUrl: "https://teams.microsoft.com/l/app/install-harbor",
  });
  await setupPage({ context, path: settings });
  await screen.findByText("Install in Teams to finish");
  expect(browser.calls).toStrictEqual([]);
  visibility.changeTo("hidden");
  mockTeams(context, {
    isConnected: true,
    isInstalled: true,
    linkedAccounts: [account],
  });
  visibility.changeTo("visible");
  await screen.findByText("Connected to Microsoft Teams");
  expect(location.pathname).toBe(settings);
});

test("teams-connect-page-010 installation during subscription attachment reaches the Teams launch page", async () => {
  const subscription = context.mocks.ably.deferSubscribeOnChannel(
    "user:test-user-123",
    "teams:changed",
  );
  mockTeams(context, { pendingInstallation: true });
  await startPage({
    context,
    path: settings,
  });
  await subscription.started;
  await screen.findByText("Install in Teams to finish");
  mockTeams(context, {
    isInstalled: true,
    isConnected: true,
    linkedAccounts: [account],
  });
  subscription.attach();
  await screen.findByText("Connected to Microsoft Teams");
  const launch = await findAction("link", "Open Teams");
  expect(launch).toHaveAttribute("href", "https://teams.microsoft.com/");
  expect(launch).toHaveAttribute("target", "_blank");
});

test("teams-connect-page-011 a scoped reinstall and the Teams home link retain their different destinations", async () => {
  const installation = "https://teams.microsoft.com/l/app/contract-upgrade";
  mockTeams(context, {
    isInstalled: true,
    isConnected: true,
    linkedAccounts: [account],
    permissionMismatch: true,
    reinstallUrl: installation,
  });
  const params = new URLSearchParams({
    tenantId: account.tenantId,
    teamsUserId: account.teamsUserId,
    serviceUrl: "https://elsewhere.example.test/bot",
  });
  await setupPage({ context, path: settings + "?" + params.toString() });
  await screen.findByText("Connected to Microsoft Teams");
  await expect(
    findAction("link", "Reinstall in Teams"),
  ).resolves.toHaveAttribute("href", installation);
  await expect(findAction("link", "Open Teams")).resolves.toHaveAttribute(
    "href",
    "https://teams.microsoft.com/",
  );
});

test("teams-connect-page-012 returning to Works during refresh discards the late Teams status", async () => {
  mockTeams(context);
  const visibility = context.mocks.browser.visibilityState("visible");
  await setupPage({ context, path: settings });
  const back = await findAction("link", "Back to settings");
  const pending = createDeferredPromise<AbortSignal>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  const replied = createDeferredPromise<void>(context.signal);
  context.mocks.api(
    teamsConnectContract.getStatus,
    async ({ request, respond }) => {
      if (!pending.settled()) {
        pending.resolve(request.signal);
        await release.promise;
        replied.resolve();
      }
      return respond(200, {
        isInstalled: true,
        pendingInstallation: false,
        isConnected: true,
        isAdmin: true,
        linkedAccounts: [account],
      });
    },
  );
  visibility.changeTo("hidden");
  visibility.changeTo("visible");
  const signal = await pending.promise;
  click(back);
  await screen.findByText("Discord");
  expect(window.location.pathname).toBe("/works");
  release.resolve();
  await replied.promise;
  expect(signal.aborted).toBeTruthy();
  expect(screen.getByText("Discord")).toBeInTheDocument();
  expect(screen.queryByText("Connected to Microsoft Teams")).toBeNull();
});

test("teams-connect-page-013 signing in preserves the full incoming Teams conversation", async () => {
  const fields = new URLSearchParams({
    orgId: "org_guest",
    tenantId: "west",
    teamsUserId: "kelly",
    teamsAadObjectId: "aad-kelly",
    teamId: "support",
    conversationId: "case/44",
    activityId: "reply 6",
    channelId: "escalations",
    threadId: "thread:alpha",
    serviceUrl: "https://gateway.example.test/conversation",
    error: "account missing",
  });
  const path = settings + "?" + fields.toString();
  const incoming = createTestRuntime(context);
  await startPage({ context: incoming, path, auth: null });
  await waitFor(() => {
    return expect(window.location.pathname).toBe("/sign-in");
  });
  const destination = new URL(window.location.href);
  const returnTo = new URL(destination.searchParams.get("redirect_url") ?? "");
  expect(returnTo.pathname + returnTo.search).toBe(path);
  await startPage({
    context,
    host: destination.host,
    path: destination.pathname + destination.search,
    auth: null,
  });
  const form = await screen.findByTestId("clerk-sign-in");
  const target = new URL(
    form.dataset.clerkForceRedirectUrl ?? "",
    window.location.origin,
  );
  expect(target.pathname).toBe(settings);
  expect(target.origin + target.pathname + target.search).toBe(returnTo.href);
});

test("teams-connect-page-017 a linked member can open Teams without a bot installation in the named workspace", async () => {
  mockTeams(context, {
    isConnected: true,
    isInstalled: false,
    teamId: null,
    linkedAccounts: [account],
  });
  await setupPage({
    context,
    path:
      settings +
      "?orgId=org_external&tenantId=" +
      account.tenantId +
      "&teamsUserId=" +
      account.teamsUserId,
  });
  await screen.findByText("Your Teams account is connected.");
  expect(screen.getByText("Connected to Microsoft Teams")).toBeInTheDocument();
});
