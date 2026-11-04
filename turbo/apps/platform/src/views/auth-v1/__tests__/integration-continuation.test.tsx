import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";

import { setupPage, startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const ENTRIES = [
  {
    name: "Halloween email",
    entry: "/?halloween=1",
  },
  {
    name: "AgentPhone",
    entry:
      "/settings/agentphone?handle=%2B15555550123&agent=agt_test&ts=1784880000&sig=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&channel=imessage&context=one&context=two",
  },
  {
    name: "Slack OAuth completion",
    entry:
      "/connectors/slack/callback?integration=slack&state=private-state&code=private-code",
  },
  {
    name: "Teams OAuth completion",
    entry:
      "/connectors/microsoft-365/callback?integration=teams&state=private-state&code=private-code",
  },
  {
    name: "GitHub OAuth continuation",
    entry:
      "/connectors/github/callback?integration=github&state=private-state&installation_id=12345&setup_action=install",
  },
  {
    name: "Slack",
    entry:
      "/settings/slack?w=T123&u=U123&c=C123&t=123.456&context=one&context=two",
  },
  {
    name: "Telegram",
    entry:
      "/settings/telegram?bot=official&tgUser=99001&ts=1700000000&sig=test-signature&tgUserName=alice&tgDisplayName=Alice+Tester&context=one&context=two",
  },
  {
    name: "Telegram with case-insensitive and trailing-slash routing",
    entry:
      "/SETTINGS/telegram/?bot=official&tgUser=99001&ts=1700000000&sig=test-signature&context=one&context=two",
  },
  {
    name: "legacy Telegram",
    entry:
      "/telegram/connect?bot=official&tgUser=99001&ts=1700000000&sig=test-signature&tgUserName=alice&tgDisplayName=Alice+Tester&context=one&context=two",
  },
  // Discord captures and sanitizes its callback before the shared auth wrapper.
  // Only its supported public fields belong in the continuation contract.
  {
    name: "Discord",
    entry: "/settings/discord?guild_id=123456789012345678&status=pending",
  },
  {
    name: "Discord install",
    entry:
      "/settings/discord/install?guild_id=123456789012345678&status=connected",
  },
  {
    name: "Teams",
    entry:
      "/settings/teams?tenantId=tenant&teamsUserId=user&teamsAadObjectId=aad&orgId=org&conversationId=conversation&activityId=activity&channelId=channel&threadId=thread&context=one&context=two",
  },
  {
    name: "legacy pending Discord callback",
    entry: "/works?discord=pending&guild_id=123456789012345678",
  },
  {
    name: "legacy failed Discord callback",
    entry: "/works?discord=error&discord_error=cancelled",
  },
  {
    name: "legacy connected Discord callback",
    entry: "/works?discord=connected&guild_id=123456789012345678",
  },
] as const;

function expectContinuation(
  actual: string | null | undefined,
  expected: string,
) {
  if (!actual) {
    throw new Error("The auth page did not provide a continuation URL");
  }
  const actualUrl = new URL(actual);
  const expectedUrl = new URL(expected);
  // Stable sorting ignores key order while retaining repeated-value order.
  actualUrl.searchParams.sort();
  expectedUrl.searchParams.sort();
  // A failed continuation check must not print signed-link fields.
  expect(actualUrl.href === expectedUrl.href).toBeTruthy();
}

test.each(ENTRIES)(
  "Organization selection preserves the complete supported continuation for $name",
  async ({ entry }) => {
    const target = `https://app.okou.ai${entry}#public-context`;
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
    expectContinuation(
      new URL(window.location.href).searchParams.get("redirect_url"),
      target,
    );

    // Follow the emitted destination through the real auth Router and Clerk UI.
    window.history.replaceState(null, "", window.location.href);
    window.dispatchEvent(new PopStateEvent("popstate"));
    const signIn = await screen.findByTestId("clerk-sign-in");
    expectContinuation(signIn.dataset.clerkForceRedirectUrl, target);
  },
);

test.each(ENTRIES)(
  "Sign-in and sign-up retain the complete supported continuation for $name",
  async ({ entry }) => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const target = `https://app.okou.ai${entry}#public-context`;
    await startPage({ context, host: "app.okou.ai", path: target, auth: null });
    await waitFor(() => {
      expect(window.location.pathname).toBe("/sign-in");
    });
    window.history.replaceState(null, "", window.location.href);
    window.dispatchEvent(new PopStateEvent("popstate"));
    const signIn = await screen.findByTestId("clerk-sign-in");
    expectContinuation(signIn.dataset.clerkForceRedirectUrl, target);

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
    const signUp = await screen.findByTestId("clerk-sign-up");
    expectContinuation(signUp.dataset.clerkForceRedirectUrl, target);
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
      path: `${entry}&guild_id=123456789012345678#discord_oauth=approve&state=${"s".repeat(43)}&approval_proof=${proof}`,
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
    expectContinuation(
      params.get("redirect_url"),
      `https://app.okou.ai${entry}&guild_id=123456789012345678`,
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

test("A sanitized Discord return after login or actor change reports interrupted approval", async () => {
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
    path: "/settings/discord?status=pending&guild_id=123456789012345678",
    auth: {
      user: { id: "replacement-user", fullName: "Replacement User" },
    },
  });
  await expect(
    screen.findByRole("heading", { name: "Connection failed" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText("This authorization was interrupted or refreshed."),
  ).toBeInTheDocument();
  expect(screen.getByText("Back to settings").closest("a")).toHaveAttribute(
    "href",
    "/works",
  );
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
