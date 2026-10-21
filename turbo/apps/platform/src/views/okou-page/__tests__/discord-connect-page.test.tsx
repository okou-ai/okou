import {
  integrationsDiscordContract,
  type DiscordOrgStatus,
} from "@okouai/api-contracts/contracts/integrations-discord";
import { discordOauthContract } from "@okouai/api-contracts/contracts/discord-oauth";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { click, setupPage, startPage } from "../../../__tests__/page-helper.ts";
import { initSentry } from "../../../lib/sentry.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { bootstrapSkeleton } from "../../../test/bootstrap-skeleton.ts";

import {
  getAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
const guildId = "123456789012345678";
const path = `/settings/discord?guild_id=${guildId}`;

function status(overrides: Partial<DiscordOrgStatus> = {}): DiscordOrgStatus {
  return {
    isAvailable: true,
    isConnected: false,
    isAdmin: true,
    guildId,
    guildName: "Design team",
    discordUserId: null,
    defaultAgentId: null,
    defaultAgentName: null,
    onboarding: "oauth",
    dmSelectionConnectionId: null,
    dmBindings: [],
    contextMode: "mentions_only",
    ...overrides,
  };
}

test.each([true, false])(
  "An install link starts a new installation for an already connected user (approved: %s)",
  async (approved) => {
    let finished = false;
    let current = status({ isConnected: true, guildId: "345678901234567890" });
    const popup = context.mocks.browser.authWindow();
    vi.spyOn(popup, "postMessage");
    Object.defineProperty(popup, "location", {
      configurable: true,
      value: { href: "" },
    });
    context.mocks.browser.open(popup);
    let requestBody: unknown;
    const authorizationUrl = `https://discord.com/oauth2/authorize?state=${"s".repeat(43)}`;
    context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
      return respond(200, current);
    });
    context.mocks.api(discordOauthContract.start, ({ body, respond }) => {
      requestBody = body;
      return respond(200, {
        authorizationUrl,
        completionToken: "c".repeat(43),
      });
    });
    context.mocks.api(discordOauthContract.complete, ({ respond }) => {
      if (!finished) {
        return respond(409, {
          error: {
            code: "DISCORD_OAUTH_APPROVAL_REQUIRED",
            message: "Approve this authorization in the consent browser.",
          },
        });
      }
      if (!approved) {
        return respond(400, {
          error: { code: "BAD_REQUEST", message: "Consent was not completed" },
        });
      }
      current = status({ isConnected: true });
      return respond(200, { status: "connected" });
    });
    await setupPage({
      context,
      path: `/settings/discord/install?guild_id=${guildId}`,
      featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
    });
    expect(
      screen.getByRole("heading", { name: "Add Okou to a server" }),
    ).toBeInTheDocument();
    expect(queryAction("link", "Open Discord")).toBeNull();
    expect(requestBody).toBeUndefined();
    click(getAction("button", "Join new server"));
    await waitFor(() => {
      return expect(popup.location.href).toBe(authorizationUrl);
    });
    expect(requestBody).toStrictEqual({ flow: "install", guildId });
    finished = true;
    await expect(
      screen.findByText(
        approved
          ? "Connected to Discord"
          : "Discord authorization could not be completed. Try again.",
      ),
    ).resolves.toBeInTheDocument();
    expect(popup.closed).toBeFalsy();
    expect(popup.location.href).toBe(authorizationUrl);
    // Completing installation must preserve delivery to a callback whose
    // ready event is still queued, even as the original URL leaves /install.
    expect(popup.postMessage).not.toHaveBeenCalled();
    context.mocks.browser.message(
      { type: "discord-oauth-ready", state: "s".repeat(43) },
      { origin: window.location.origin, source: popup },
    );
    expect(popup.postMessage).toHaveBeenCalledWith(
      {
        type: "discord-oauth-result",
        state: "s".repeat(43),
        status: approved ? "connected" : "error",
      },
      window.location.origin,
    );
    expect(window.location.pathname).toBe(
      approved ? "/settings/discord" : "/settings/discord/install",
    );
    expect(
      queryAction("link", "Open Discord")?.getAttribute("href") ?? null,
    ).toBe(approved ? `discord://-/channels/${guildId}` : null);
    expect(
      queryAction("button", "Retry")?.hasAttribute("disabled") ?? null,
    ).toBe(approved ? null : false);
  },
);

test.each(["install", "connect"] as const)(
  "The Discord bot link offers %s directly and retains the target server",
  async (flow) => {
    let approved = false;
    let current = status({
      guildId: flow === "connect" ? guildId : null,
      guildName: flow === "connect" ? "Design team" : null,
    });
    context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
      return respond(200, current);
    });
    const popup = context.mocks.browser.authWindow();
    vi.spyOn(popup, "postMessage");
    Object.defineProperty(popup, "location", {
      configurable: true,
      value: { href: "" },
    });
    context.mocks.browser.open(popup);
    const state = "s".repeat(43);
    const completionToken = "c".repeat(43);
    const authorizationUrl = `https://discord.com/oauth2/authorize?state=${state}`;
    let requestBody: unknown;
    let completionBody: unknown;
    context.mocks.api(discordOauthContract.start, ({ body, respond }) => {
      requestBody = body;
      return respond(200, { authorizationUrl, completionToken });
    });
    context.mocks.api(discordOauthContract.complete, ({ body, respond }) => {
      completionBody = body;
      if (!approved) {
        return respond(409, {
          error: {
            code: "DISCORD_OAUTH_APPROVAL_REQUIRED",
            message: "Approve Discord authorization before completing it.",
          },
        });
      }
      current = status({ isConnected: true });
      return respond(200, {
        status: "connected",
      });
    });
    await setupPage({
      context,
      path,
      featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
    });
    expect(
      screen.getByRole("heading", { name: "Connect to Discord" }),
    ).toBeInTheDocument();
    click(getAction("button", "Connect"));
    await waitFor(() => {
      expect(popup.location.href).toBe(authorizationUrl);
    });
    expect(getAction("button", "Connecting...")).toBeDisabled();
    expect(
      screen.getByText("Connect your Discord account to chat with your agent."),
    ).toBeInTheDocument();
    expect(queryAction("link", "Open Discord")).not.toBeInTheDocument();
    expect(requestBody).toStrictEqual({ guildId });
    context.mocks.browser.message(
      { type: "discord-oauth-ready", state },
      { origin: window.location.origin, source: popup },
    );
    approved = true;
    await waitFor(() => {
      const completed = screen.getByRole("heading", {
        name: "Connected to Discord",
      });
      expect(completed).toBeInTheDocument();
    });
    expect(completionBody).toStrictEqual({ state, completionToken });
    await waitFor(() => {
      expect(
        Object.fromEntries(new URLSearchParams(window.location.search)),
      ).toStrictEqual({
        status: "connected",
        workspace: "Design team",
        guild_id: guildId,
      });
    });
    expect(
      queryAction("link", "Open Discord")?.getAttribute("href") ?? null,
    ).toBe(`discord://-/channels/${guildId}`);
    expect(popup.closed).toBeFalsy();
    expect(popup.location.href).toBe(authorizationUrl);
    expect(popup.postMessage).toHaveBeenCalledWith(
      { type: "discord-oauth-result", state, status: "connected" },
      window.location.origin,
    );
  },
);

test.each(["connected", "disconnected", "error"] as const)(
  "Discord consent finishes in place after the refreshed status is %s",
  async (result) => {
    const opener = context.mocks.browser.authWindow();
    vi.stubGlobal("opener", opener);
    const state = "s".repeat(43);
    const approvalProof = "p".repeat(43);
    const approving = context.mocks.deferred<void>();
    const approved = context.mocks.deferred<void>();
    const refreshing = context.mocks.deferred<void>();
    const refreshed = context.mocks.deferred<void>();
    let completed = false;
    context.mocks.api(
      integrationsDiscordContract.getStatus,
      async ({ respond }) => {
        if (!completed) {
          // An older connection must not count as this attempt completing.
          return respond(
            200,
            status({ isConnected: true, guildId: "345678901234567890" }),
          );
        }
        if (!refreshing.settled()) {
          refreshing.resolve();
        }
        await refreshed.promise;
        return result === "error"
          ? respond(403, {
              error: { code: "FORBIDDEN", message: "Discord access denied" },
            })
          : respond(200, status({ isConnected: result === "connected" }));
      },
    );
    context.mocks.api(discordOauthContract.approve, async ({ respond }) => {
      approving.resolve();
      await approved.promise;
      return respond(200, { approved: true });
    });
    const page = await startPage({
      context,
      path: `/settings/discord?status=pending#discord_oauth=approve&state=${state}&approval_proof=${approvalProof}`,
      featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
    });
    await page.content;
    await approving.promise;
    expect(
      screen.getByRole("heading", { name: "Checking account status..." }),
    ).toBeInTheDocument();
    expect(queryAction("link", "Open Discord")).toBeNull();
    expect(window.location.hash).toBe("");
    const completion = {
      type: "discord-oauth-result",
      state,
      status: "connected",
    };
    const origin = window.location.origin;
    completed = true;
    // The server can finish while this tab's approval response is in flight.
    context.mocks.browser.message(completion, { origin, source: opener });
    approved.resolve();
    await page.ready;
    await refreshing.promise;
    expect(
      screen.getByRole("heading", { name: "Checking account status..." }),
    ).toBeInTheDocument();
    expect(bootstrapSkeleton()).toHaveAttribute("aria-hidden", "true");
    expect(queryAction("link", "Open Discord")).toBeNull();
    refreshed.resolve();
    await expect(
      screen.findByRole("heading", {
        name:
          result === "connected"
            ? "Connected to Discord"
            : result === "error"
              ? "Connection failed"
              : "Connect to Discord",
      }),
    ).resolves.toBeInTheDocument();
    expect(bootstrapSkeleton()).toHaveAttribute("aria-hidden", "true");
    expect(window.location.pathname).toBe("/settings/discord");
    expect(new URLSearchParams(window.location.search).get("status")).toBe(
      "connected",
    );
    expect(
      queryAction("link", "Open Discord")?.getAttribute("href") ?? null,
    ).toBe(result === "connected" ? `discord://-/channels/${guildId}` : null);
  },
);

test.each(["connected", "error"] as const)(
  "Only the original window's same-origin %s result for this attempt can finish Discord consent",
  async (result) => {
    const opener = context.mocks.browser.authWindow();
    vi.spyOn(opener, "postMessage");
    vi.stubGlobal("opener", opener);
    const state = "s".repeat(43);
    context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
      return respond(200, status({ isConnected: true }));
    });
    context.mocks.api(discordOauthContract.approve, ({ respond }) => {
      return respond(200, { approved: true });
    });
    await setupPage({
      context,
      path: `/settings/discord?status=pending#discord_oauth=approve&state=${state}&approval_proof=${"p".repeat(43)}`,
      featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
    });
    expect(
      screen.getByRole("heading", { name: "Checking account status..." }),
    ).toBeInTheDocument();
    expect(opener.postMessage).toHaveBeenCalledWith(
      { type: "discord-oauth-ready", state },
      window.location.origin,
    );
    const completion = { type: "discord-oauth-result", state, status: result };
    const origin = window.location.origin;
    await act(() => {
      context.mocks.browser.message(completion, {
        origin: "https://untrusted.example",
        source: opener,
      });
      context.mocks.browser.message(completion, {
        origin,
        source: context.mocks.browser.authWindow(),
      });
      context.mocks.browser.message(
        { ...completion, state: "another-attempt" },
        { origin, source: opener },
      );
      context.mocks.browser.message(
        { ...completion, status: "unknown" },
        { origin, source: opener },
      );
    });
    expect(
      screen.getByRole("heading", { name: "Checking account status..." }),
    ).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("status")).toBe(
      "pending",
    );
    context.mocks.browser.message(completion, { origin, source: opener });
    await expect(
      screen.findByRole("heading", {
        name:
          result === "connected" ? "Connected to Discord" : "Connection failed",
      }),
    ).resolves.toBeInTheDocument();
    expect(bootstrapSkeleton()).toHaveAttribute("aria-hidden", "true");
    expect(new URLSearchParams(window.location.search).get("status")).toBe(
      result,
    );
  },
);

test.each([
  { result: "connected", approvalStatus: 200 },
  { result: "connected", approvalStatus: 403 },
  { result: "error", approvalStatus: 200 },
  { result: "error", approvalStatus: 403 },
] as const)(
  "A terminal $result result renders before an in-flight approval response ($approvalStatus) and remains final",
  async ({ result, approvalStatus }) => {
    const opener = context.mocks.browser.authWindow();
    vi.stubGlobal("opener", opener);
    const state = "s".repeat(43);
    const approving = context.mocks.deferred<void>();
    const approved = context.mocks.deferred<void>();
    context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
      return respond(200, status({ isConnected: true }));
    });
    context.mocks.api(discordOauthContract.approve, async ({ respond }) => {
      approving.resolve();
      await approved.promise;
      return approvalStatus === 200
        ? respond(200, { approved: true })
        : respond(403, {
            error: { code: "FORBIDDEN", message: "Approval failed" },
          });
    });
    const page = await startPage({
      context,
      path: `/settings/discord?status=pending#discord_oauth=approve&state=${state}&approval_proof=${"p".repeat(43)}`,
      featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
    });
    await page.content;
    await approving.promise;
    expect(
      screen.getByRole("heading", { name: "Checking account status..." }),
    ).toBeInTheDocument();
    context.mocks.browser.message(
      { type: "discord-oauth-result", state, status: result },
      { origin: window.location.origin, source: opener },
    );
    const title =
      result === "connected" ? "Connected to Discord" : "Connection failed";
    await expect(
      screen.findByRole("heading", { name: title }),
    ).resolves.toBeInTheDocument();
    expect(bootstrapSkeleton()).toHaveAttribute("aria-hidden", "true");
    expect(queryAction("button", "Retry")).toBeNull();
    expect(new URLSearchParams(window.location.search).get("status")).toBe(
      result,
    );

    approved.resolve();
    await page.ready;
    await act(() => {
      context.mocks.browser.message(
        {
          type: "discord-oauth-result",
          state,
          status: result === "connected" ? "error" : "connected",
        },
        { origin: window.location.origin, source: opener },
      );
    });
    expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    expect(queryAction("button", "Retry")).toBeNull();
    expect(new URLSearchParams(window.location.search).get("status")).toBe(
      result,
    );
    expect(bootstrapSkeleton()).toHaveAttribute("aria-hidden", "true");
  },
);

test.each([false, true])(
  "The Discord success URL uses verified connection data (connected: %s)",
  async (isConnected) => {
    context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
      return respond(200, status({ isConnected }));
    });
    await setupPage({
      context,
      path: `${path}&status=connected&workspace=Unverified+server`,
      featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
    });
    expect(screen.queryByText(/Unverified server/u)).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: isConnected ? "Connected to Discord" : "Connect to Discord",
      }),
    ).toBeInTheDocument();
    expect(
      queryAction("link", "Open Discord")?.getAttribute("href") ?? null,
    ).toBe(isConnected ? `discord://-/channels/${guildId}` : null);
    const action = isConnected
      ? getAction("link", "Open Discord")
      : getAction("button", "Connect");
    expect(action).not.toBeDisabled();
  },
);

test("A blocked Discord popup shows a retry action on the connection page", async () => {
  context.mocks.browser.open(null);
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, status());
  });
  await setupPage({
    context,
    path,
    featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
  });
  click(getAction("button", "Connect"));
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Allow popups to authorize Discord, then try again.",
  );
  expect(getAction("button", "Retry")).toBeEnabled();
  expect(queryAction("link", "Open Discord")).not.toBeInTheDocument();
});

test("Closing Discord consent shows cancellation without failure capture and can retry to a verified connection", async () => {
  const sentry = context.mocks.sentry();
  initSentry();
  let current = status();
  let retrying = false;
  let approved = false;
  const retryState = "r".repeat(43);
  const retryToken = "t".repeat(43);
  let completionBody: unknown;
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, current);
  });
  const popup = context.mocks.browser.authWindow();
  Object.defineProperty(popup, "location", {
    configurable: true,
    value: { href: "" },
  });
  context.mocks.browser.open(popup);
  const authorizationUrl = `https://discord.com/oauth2/authorize?state=${"s".repeat(43)}`;
  const retryUrl = `https://discord.com/oauth2/authorize?state=${retryState}`;
  context.mocks.api(discordOauthContract.start, ({ respond }) => {
    return respond(200, {
      authorizationUrl: retrying ? retryUrl : authorizationUrl,
      completionToken: retrying ? retryToken : "c".repeat(43),
    });
  });
  context.mocks.api(discordOauthContract.complete, ({ body, respond }) => {
    completionBody = body;
    if (body.state === retryState && approved) {
      current = status({
        isConnected: true,
        discordUserId: "234567890123456789",
      });
      return respond(200, { status: "connected" });
    }
    return respond(409, {
      error: {
        code: "DISCORD_OAUTH_APPROVAL_REQUIRED",
        message: "Discord consent has not been approved",
      },
    });
  });
  await setupPage({
    context,
    path,
    featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
  });
  click(getAction("button", "Connect"));
  await waitFor(() => {
    expect(popup.location.href).toBe(authorizationUrl);
  });
  popup.close();
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Discord authorization was cancelled. You can start again.",
  );
  expect(getAction("button", "Retry")).toBeEnabled();
  expect(queryAction("link", "Open Discord")).not.toBeInTheDocument();
  expect(new URLSearchParams(window.location.search).get("status")).not.toBe(
    "connected",
  );
  expect(
    screen.queryByText("Discord consent has not been approved"),
  ).toBeNull();
  expect(sentry.reports).toStrictEqual([]);

  const retryPopup = context.mocks.browser.authWindow();
  Object.defineProperty(retryPopup, "location", {
    configurable: true,
    value: { href: "" },
  });
  context.mocks.browser.open(retryPopup);
  retrying = true;
  click(getAction("button", "Retry"));
  await waitFor(() => {
    expect(retryPopup.location.href).toBe(retryUrl);
  });
  expect(getAction("button", "Connecting...")).toBeDisabled();
  expect(queryAction("link", "Open Discord")).toBeNull();
  approved = true;
  await expect(
    screen.findByRole("heading", { name: "Connected to Discord" }),
  ).resolves.toBeInTheDocument();
  expect(getAction("link", "Open Discord")).toHaveAttribute(
    "href",
    `discord://-/channels/${guildId}`,
  );
  await waitFor(() => {
    expect(new URLSearchParams(window.location.search).get("status")).toBe(
      "connected",
    );
  });
  expect(retryPopup.closed).toBeFalsy();
  expect(completionBody).toStrictEqual({
    state: retryState,
    completionToken: retryToken,
  });
  expect(sentry.reports).toStrictEqual([]);
});

test.each([
  { statusCode: 409, code: "CONFLICT" },
  { statusCode: 403, code: "FORBIDDEN" },
  { statusCode: 400, code: "DISCORD_OAUTH_FAILED" },
  { statusCode: 503, code: "DISCORD_OAUTH_APPROVAL_REQUIRED" },
] as const)(
  "Closing consent does not hide a real $statusCode $code completion failure on the canonical page",
  async ({ statusCode, code }) => {
    const sentry = context.mocks.sentry();
    initSentry();
    const completing = context.mocks.deferred<void>();
    const respondToCompletion = context.mocks.deferred<void>();
    const popup = context.mocks.browser.authWindow();
    Object.defineProperty(popup, "location", {
      configurable: true,
      value: { href: "" },
    });
    context.mocks.browser.open(popup);
    context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
      return respond(200, status());
    });
    context.mocks.api(discordOauthContract.start, ({ respond }) => {
      return respond(200, {
        authorizationUrl: `https://discord.com/oauth2/authorize?state=${"s".repeat(43)}`,
        completionToken: "c".repeat(43),
      });
    });
    context.mocks.api(discordOauthContract.complete, async ({ respond }) => {
      completing.resolve();
      await respondToCompletion.promise;
      return respond(statusCode, {
        error: { code, message: "Discord completion failed verification" },
      });
    });
    await setupPage({
      context,
      path,
      featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
    });
    click(getAction("button", "Connect"));
    await completing.promise;
    popup.close();
    respondToCompletion.resolve();
    await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
      "Discord authorization could not be completed. Try again.",
    );
    expect(
      screen.getByText("Discord completion failed verification"),
    ).toBeInTheDocument();
    expect(getAction("button", "Retry")).toBeEnabled();
    expect(queryAction("link", "Open Discord")).toBeNull();
    expect(new URLSearchParams(window.location.search).get("status")).not.toBe(
      "connected",
    );
    expect(sentry.reports).toMatchObject([
      {
        type: "exception",
        error: { code, status: statusCode, expected: false },
      },
    ]);
  },
);

test("A Discord DM link can connect without a server hint", async () => {
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, status());
  });
  await setupPage({
    context,
    path: "/settings/discord",
    featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
  });
  expect(getAction("button", "Connect")).toBeEnabled();
});

test("A failed Discord status request exposes the error page and its back link", async () => {
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(403, {
      error: { code: "FORBIDDEN", message: "Discord access denied" },
    });
  });
  await expect(
    setupPage({
      context,
      path,
      featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
    }),
  ).rejects.toThrow("Discord access denied");
  await expect(
    screen.findByRole("heading", { name: "Connection failed" }),
  ).resolves.toBeInTheDocument();
  expect(getAction("link", "Back to settings")).toHaveAttribute(
    "href",
    "/works",
  );
  expect(queryAction("button", "Connect")).not.toBeInTheDocument();
});

test("A server link is independent of the workspace's previous server", async () => {
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(
      200,
      status({ guildId: "987654321098765432", isAdmin: false }),
    );
  });
  await setupPage({
    context,
    path,
    featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
  });
  expect(getAction("button", "Connect")).toBeEnabled();
});

test("A malformed server link cannot start consent", async () => {
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, status());
  });
  await setupPage({
    context,
    path: "/settings/discord?guild_id=invalid",
    featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
  });
  expect(
    screen.getByText(
      "This Discord connection link is invalid. Open a new link from Discord.",
    ),
  ).toBeInTheDocument();
  expect(queryAction("button", "Connect")).not.toBeInTheDocument();
});

test.each([
  path,
  `/settings/discord?status=pending#discord_oauth=approve&state=${"s".repeat(43)}&approval_proof=${"p".repeat(43)}`,
])(
  "A disabled Discord integration at %s offers no authorization action",
  async (disabledPath) => {
    const approvals: unknown[] = [];
    context.mocks.api(discordOauthContract.approve, ({ body, respond }) => {
      approvals.push(body);
      return respond(200, { approved: true });
    });
    await setupPage({
      context,
      path: disabledPath,
      featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: false },
    });
    expect(
      screen.getByText("Discord is not configured for this organization yet."),
    ).toBeInTheDocument();
    expect(queryAction("button", "Connect")).not.toBeInTheDocument();
    expect(approvals).toStrictEqual([]);
    expect(window.location.hash).toBe("");
  },
);

test("A Discord connection link requires sign-in and preserves its server", async () => {
  await startPage({ context, path, host: "app.okou.ai", auth: null });
  await waitFor(() => {
    expect(window.location.pathname).toBe("/sign-in");
  });
  const redirect = new URLSearchParams(window.location.hash.split("?")[1]).get(
    "redirect_url",
  );
  expect(redirect).toContain(path);
});
