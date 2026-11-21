import { expect, test } from "vitest";
import { screen } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
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
