import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";

import { setupPage, startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const ENTRIES = [
  "/settings/slack?w=T123&u=U123&c=C123&t=123.456",
  "/settings/telegram?bot=official&tgUser=99001&ts=1700000000&sig=test-signature&tgUserName=alice&tgDisplayName=Alice+Tester",
  "/SETTINGS/telegram/?bot=official&tgUser=99001&ts=1700000000&sig=test-signature",
  "/telegram/connect?bot=official&tgUser=99001&ts=1700000000&sig=test-signature&tgUserName=alice&tgDisplayName=Alice+Tester",
  "/settings/discord?guild_id=123456789012345678&workspace=Example&status=pending",
  "/settings/discord/install?guild_id=123456789012345678&status=connected",
  "/settings/teams?tenantId=tenant&teamsUserId=user&teamsAadObjectId=aad&orgId=org&conversationId=conversation&activityId=activity&channelId=channel&threadId=thread",
  "/works?discord=pending&guild_id=123456789012345678",
  "/works?discord=error&error=access_denied",
  "/works?discord=connected&workspace=Example",
] as const;

test.each(ENTRIES)(
  "Organization selection preserves the complete supported continuation for %s",
  async (entry) => {
    const target = `https://app.okou.ai${entry}&context=one&context=two#public-context`;
    await startPage({
      context,
      host: "app.okou.ai",
      path: target,
      auth: {
        user: { id: "integration-user", fullName: "Integration User" },
        organization: { activeOrg: null, memberships: [] },
      },
    });

    await waitFor(() => {
      expect(window.location.pathname).toBe(
        "/sign-in/tasks/choose-organization",
      );
    });
    expect(new URL(window.location.href).searchParams.get("redirect_url")).toBe(
      target,
    );

    // Follow the emitted destination through the real auth Router and Clerk UI.
    window.history.replaceState(null, "", window.location.href);
    window.dispatchEvent(new PopStateEvent("popstate"));
    const signIn = await screen.findByTestId("clerk-sign-in");
    expect(signIn).toHaveAttribute("data-clerk-force-redirect-url", target);
  },
);

test.each(ENTRIES)(
  "Sign-in and sign-up retain repeated query and fragment context for %s",
  async (entry) => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const target = `https://app.okou.ai${entry}&context=one&context=two#public-context`;
    await startPage({ context, host: "app.okou.ai", path: target, auth: null });
    await waitFor(() => {
      expect(window.location.pathname).toBe("/sign-in");
    });
    window.history.replaceState(null, "", window.location.href);
    window.dispatchEvent(new PopStateEvent("popstate"));
    const signIn = await screen.findByTestId("clerk-sign-in");
    expect(signIn).toHaveAttribute("data-clerk-force-redirect-url", target);

    const signUpUrl = signIn.dataset.clerkSignUpUrl;
    const router = window.__okouClerkRouter;
    if (!signUpUrl || !router) {
      throw new Error("Clerk did not expose its sign-up navigation");
    }
    await router.push(signUpUrl, {
      windowNavigate(to) {
        window.location.assign(to);
      },
    });
    await expect(screen.findByTestId("clerk-sign-up")).resolves.toHaveAttribute(
      "data-clerk-force-redirect-url",
      target,
    );
  },
);

test.each(["/works", "/works?discord=unknown", "/agents"])(
  "Organization selection does not add a new return flow for %s",
  async (path) => {
    await startPage({
      context,
      path,
      host: "app.okou.ai",
      auth: {
        user: { id: "unrelated-user", fullName: "Unrelated User" },
        organization: { activeOrg: null, memberships: [] },
      },
    });
    await waitFor(() => {
      expect(window.location.pathname).toBe(
        "/sign-in/tasks/choose-organization",
      );
    });
    expect(window.location.search).toBe("");
  },
);

test.each([
  { entry: "/settings/discord?status=pending", signedIn: false },
  { entry: "/works?discord=pending", signedIn: false },
  { entry: "/settings/discord?status=pending", signedIn: true },
  { entry: "/works?discord=pending", signedIn: true },
])(
  "Discord proof is consumed before auth from $entry (signed in: $signedIn)",
  async ({ entry, signedIn }) => {
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    const proof = "a".repeat(43);
    await startPage({
      context,
      host: "app.okou.ai",
      path: `${entry}&context=one&context=two#discord_oauth=approve&state=${"s".repeat(43)}&approval_proof=${proof}`,
      auth: signedIn
        ? {
            user: { id: "approval-user", fullName: "Approval User" },
            organization: { activeOrg: null, memberships: [] },
          }
        : null,
    });
    await waitFor(() => {
      expect(window.location.pathname).toBe(
        signedIn ? "/sign-in/tasks/choose-organization" : "/sign-in",
      );
    });
    const params = new URLSearchParams(
      signedIn ? window.location.search : window.location.hash.split("?")[1],
    );
    expect(params.get("redirect_url")).toBe(
      `https://app.okou.ai${entry}&context=one&context=two`,
    );
    expect(JSON.stringify(logs.mock.calls).includes(proof)).toBeFalsy();
    expect(window.location.href.includes("approval_proof")).toBeFalsy();
    expect(
      JSON.stringify({
        ...window.localStorage,
        ...window.sessionStorage,
      }).includes(proof),
    ).toBeFalsy();
  },
);

test("A sanitized Discord return after login or actor change restarts lost approval", async () => {
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, {
      isAvailable: true,
      isConnected: false,
      isAdmin: true,
      guildId: null,
      guildName: null,
      discordUserId: null,
      defaultAgentId: null,
      defaultAgentName: null,
      onboarding: "oauth",
      dmSelectionConnectionId: null,
      dmBindings: [],
      contextMode: "mentions_only",
    });
  });
  await setupPage({
    context,
    host: "app.okou.ai",
    path: "/settings/discord?status=pending&context=public",
    featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
    auth: {
      user: { id: "replacement-user", fullName: "Replacement User" },
    },
  });
  await expect(
    screen.findByText(/restart the connection from the original tab/u),
  ).resolves.toBeInTheDocument();
  expect(window.location.hash).toBe("");
});

test("An untrusted integration-looking return cannot bypass allowed-origin auth", async () => {
  await setupPage({
    context,
    host: "app.okou.ai",
    path: `/sign-in/tasks/choose-organization?redirect_url=${encodeURIComponent("https://evil.example/settings/telegram?bot=official")}`,
    auth: null,
  });
  expect(screen.getByTestId("clerk-sign-in")).toHaveAttribute(
    "data-clerk-force-redirect-url",
    "https://app.okou.ai",
  );
});
