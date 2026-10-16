import { discordOauthContract } from "@okouai/api-contracts/contracts/discord-oauth";
import {
  integrationsDiscordContract,
  type DiscordOrgStatus,
} from "@okouai/api-contracts/contracts/integrations-discord";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { click, setupPage, startPage } from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { initSentry } from "../../../lib/sentry.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getAction,
  getIntegrationCard,
  queryAction,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
const state = "s".repeat(43);
const proof = "p".repeat(43);
const completionToken = "c".repeat(43);
const guildId = "123456789012345678";
const authorizationUrl = `https://discord.com/oauth2/authorize?state=${state}`;
const callback = `/settings/discord?status=pending#discord_oauth=approve&state=${state}&approval_proof=${proof}`;
const NOW = 1_800_000_000_000;

function status(connected = false): DiscordOrgStatus {
  return {
    isAvailable: true,
    isConnected: connected,
    isAdmin: true,
    guildId: connected ? guildId : null,
    guildName: connected ? "Verified server" : null,
    discordUserId: connected ? "234567890123456789" : null,
    defaultAgentId: null,
    defaultAgentName: null,
    onboarding: "oauth",
    dmSelectionConnectionId: null,
    dmBindings: [],
    contextMode: "mentions_only",
  };
}

// Browser-boundary behaviors pinned to the released scripts, not inferred from
// absence of ready: 0.1018 (888fd05) closes after approval; 0.1025 (71b9ec7)
// stays open without a message listener. Current consent sends ready.
test.each(["0.1018", "0.1025", "current"] as const)(
  "The current Works opener completes safely with %s consent",
  async (generation) => {
    mockNow(NOW, context.signal);
    let approved = false;
    let connected = false;
    const pending = context.mocks.deferred<void>();
    const popup = context.mocks.browser.authWindow();
    Object.defineProperty(popup, "location", {
      configurable: true,
      value: { href: "" },
    });
    const messages = vi.spyOn(popup, "postMessage");
    context.mocks.browser.open(popup);
    context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
      return respond(200, status(connected));
    });
    context.mocks.api(discordOauthContract.start, ({ respond }) => {
      return respond(200, { authorizationUrl, completionToken });
    });
    context.mocks.api(discordOauthContract.complete, ({ body, respond }) => {
      expect(body).toStrictEqual({ state, completionToken });
      if (!approved) {
        if (!pending.settled()) {
          pending.resolve();
        }
        return respond(409, {
          error: {
            code: "DISCORD_OAUTH_APPROVAL_REQUIRED",
            message: "Approval required",
          },
        });
      }
      connected = true;
      return respond(200, { status: "connected" });
    });
    await setupPage({
      context,
      path: "/works",
      featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
    });
    const card = getIntegrationCard("Discord");
    click(getAction("button", "Connect", card));
    await pending.promise;
    expect(popup.location.href).toBe(authorizationUrl);
    expect(within(card).queryByText("Connected")).toBeNull();
    if (generation === "0.1018") {
      popup.close();
    }
    approved = true;
    await expect(
      within(card).findByText("Connected"),
    ).resolves.toBeInTheDocument();
    expect(window.location.pathname).toBe("/works");
    expect(window.location.search).toBe("");
    expect(popup.location.href).toBe(authorizationUrl);
    if (generation === "current") {
      // Ready after completion still wins over the bounded navigation bridge.
      context.mocks.browser.message(
        { type: "discord-oauth-ready", state },
        { origin: window.location.origin, source: popup },
      );
    }
    mockNow(NOW + 5001, context.signal);
    await waitFor(() => {
      expect(popup.location.href).toBe(
        generation === "0.1025"
          ? `${window.location.origin}/settings/discord?status=connected`
          : authorizationUrl,
      );
    });
    expect(messages.mock.calls).toStrictEqual(
      generation === "current"
        ? [
            [
              { type: "discord-oauth-result", state, status: "connected" },
              window.location.origin,
            ],
          ]
        : [],
    );
    expect(popup.closed).toBe(generation === "0.1018");
    expect(popup.location.href).not.toContain(completionToken);
  },
);

test.each(["/works", "/settings/discord"])(
  "Approval and closure while a pending response is in flight still completes from %s",
  async (path) => {
    const sentry = context.mocks.sentry();
    initSentry();
    let approved = false;
    let connected = false;
    const pending = context.mocks.deferred<void>();
    const releasePending = context.mocks.deferred<void>();
    const popup = context.mocks.browser.authWindow();
    Object.defineProperty(popup, "location", {
      configurable: true,
      value: { href: "" },
    });
    context.mocks.browser.open(popup);
    context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
      return respond(200, status(connected));
    });
    context.mocks.api(discordOauthContract.start, ({ respond }) => {
      return respond(200, { authorizationUrl, completionToken });
    });
    context.mocks.api(
      discordOauthContract.complete,
      async ({ body, respond }) => {
        expect(body).toStrictEqual({ state, completionToken });
        if (!approved) {
          pending.resolve();
          await releasePending.promise;
          return respond(409, {
            error: {
              code: "DISCORD_OAUTH_APPROVAL_REQUIRED",
              message: "Approval required",
            },
          });
        }
        connected = true;
        return respond(200, { status: "connected" });
      },
    );
    await setupPage({
      context,
      path,
      featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
    });
    const container =
      path === "/works" ? getIntegrationCard("Discord") : document.body;
    click(getAction("button", "Connect", container));
    await pending.promise;
    expect(popup.location.href).toBe(authorizationUrl);
    // The API has already decided pending when the 0.1018 tab approves and
    // closes. Only a subsequent owned completion request can observe approval.
    approved = true;
    popup.close();
    releasePending.resolve();
    await expect(
      within(container).findByText(
        path === "/works" ? "Connected" : "Connected to Discord",
      ),
    ).resolves.toBeInTheDocument();
    expect(window.location.pathname).toBe(path);
    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get("status")).toBe(
        path === "/works" ? null : "connected",
      );
    });
    expect(popup.closed).toBeTruthy();
    expect(
      screen.queryByText(
        "Discord authorization was cancelled. You can start again.",
      ),
    ).toBeNull();
    expect(sentry.reports).toStrictEqual([]);
  },
);

test.each(["blocked", "open"] as const)(
  "A 0.1018 close-wait opener can continue only after approval and a successful explicit status-tab open (%s)",
  async (outcome) => {
    const opener = context.mocks.browser.authWindow();
    vi.stubGlobal("opener", opener);
    const cleanTab = context.mocks.browser.authWindow();
    const opened = context.mocks.browser.open(
      outcome === "open" ? cleanTab : null,
    );
    let consentClosed = false;
    // The 888fd05 opener ignores messages and calls complete only after closed.
    vi.spyOn(window, "close").mockImplementation(() => {
      consentClosed = true;
    });
    const approvals: unknown[] = [];
    context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
      return respond(200, status());
    });
    context.mocks.api(discordOauthContract.approve, ({ body, respond }) => {
      approvals.push(body);
      return respond(200, { approved: true });
    });
    await setupPage({
      context,
      path: callback,
      featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
    });
    expect(consentClosed).toBeFalsy();
    expect(opened.calls).toStrictEqual([]);
    expect(approvals).toStrictEqual([{ state, approvalProof: proof }]);
    click(getAction("button", "Continue in a new tab"));
    await waitFor(() => {
      expect(
        screen.queryByText(
          "Allow popups to authorize Discord, then try again.",
        ) !== null,
      ).toBe(outcome === "blocked");
    });
    expect(consentClosed).toBe(outcome === "open");
    let retryCalls: unknown[] = [];
    if (outcome === "blocked") {
      // Retrying the browser action does not reapprove the consumed operation.
      const retry = context.mocks.browser.open(cleanTab);
      click(getAction("button", "Continue in a new tab"));
      retryCalls = retry.calls;
    }
    await waitFor(() => {
      expect(consentClosed).toBeTruthy();
    });
    expect(retryCalls).toStrictEqual(
      outcome === "blocked"
        ? [{ url: "/settings/discord", target: "_blank", features: null }]
        : [],
    );
    expect(opened.calls).toStrictEqual([
      { url: "/settings/discord", target: "_blank", features: null },
    ]);
    expect(cleanTab.opener).toBeNull();
    expect(approvals).toStrictEqual([{ state, approvalProof: proof }]);
    expect(queryAction("link", "Open Discord")).toBeNull();
    expect(window.location.hash).toBe("");
  },
);

test.each(["missing", "closed", "closes after approval"] as const)(
  "A %s opener offers a truthful restart without proof recovery",
  async (kind) => {
    const opener = context.mocks.browser.authWindow();
    if (kind === "closed") {
      opener.close();
    }
    vi.stubGlobal("opener", kind === "missing" ? null : opener);
    const approvals: unknown[] = [];
    context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
      return respond(200, status(true));
    });
    context.mocks.api(discordOauthContract.approve, ({ body, respond }) => {
      approvals.push(body);
      return respond(200, { approved: true });
    });
    await setupPage({
      context,
      path: callback,
      featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
    });
    expect(queryAction("button", "Continue in a new tab") !== null).toBe(
      kind === "closes after approval",
    );
    if (kind === "closes after approval") {
      opener.close();
    }
    await expect(
      screen.findByText(
        "This authorization was interrupted or refreshed. Start again to verify a new connection.",
      ),
    ).resolves.toBeInTheDocument();
    expect(getAction("button", "Restart authorization")).toBeEnabled();
    expect(queryAction("link", "Open Discord")).toBeNull();
    expect(approvals).toHaveLength(kind === "closes after approval" ? 1 : 0);
    expect(window.location.href).not.toContain(proof);
  },
);

test("Completion wins over the legacy continuation action, including duplicate results", async () => {
  const opener = context.mocks.browser.authWindow();
  vi.stubGlobal("opener", opener);
  const opened = context.mocks.browser.open(context.mocks.browser.authWindow());
  const closed = vi.spyOn(window, "close").mockImplementation(() => {});
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, status(true));
  });
  context.mocks.api(discordOauthContract.approve, ({ respond }) => {
    return respond(200, { approved: true });
  });
  await setupPage({
    context,
    path: callback,
    featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
  });
  const continueButton = getAction("button", "Continue in a new tab");
  await act(() => {
    context.mocks.browser.message(
      { type: "discord-oauth-result", state, status: "connected" },
      { origin: window.location.origin, source: opener },
    );
    click(continueButton);
    context.mocks.browser.message(
      { type: "discord-oauth-result", state, status: "error" },
      { origin: window.location.origin, source: opener },
    );
  });
  await expect(
    screen.findByText("Connected to Discord"),
  ).resolves.toBeInTheDocument();
  expect(opened.calls).toStrictEqual([]);
  expect(closed).not.toHaveBeenCalled();
  expect(window.location.search).toBe("?status=connected");
});

test.each(["connected", "error"] as const)(
  "A 0.1025 navigation-based opener's %s destination reads actual state on reload",
  async (result) => {
    // 71b9ec7 navigates only after its private-token completion settles. The
    // receiver cannot authenticate that query, even when an older link exists.
    context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
      return respond(200, status(true));
    });
    await setupPage({
      context,
      path: `/settings/discord?status=${result}&workspace=Forged`,
      featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
    });
    expect(screen.queryByText("Forged")).toBeNull();
    expect(
      screen.getByRole("heading", {
        name:
          result === "connected" ? "Connected to Discord" : "Connection failed",
      }),
    ).toBeInTheDocument();
    expect(queryAction("button", "Restart authorization") !== null).toBe(
      result === "error",
    );
  },
);

test.each(["/works?discord=error", "/settings/discord?status=error"])(
  "Known callback errors at %s retain only public server context",
  async (entry) => {
    const telemetry = context.mocks.posthog();
    context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
      return respond(200, status());
    });
    await setupPage({
      context,
      path: `${entry}&status=connected&discord_error=cancelled&guild_id=${guildId}&state=private-proof&code=private-proof&approval_proof=private-proof&completionToken=private-proof&return=https://evil.example`,
      featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
    });
    expect(window.location.pathname).toBe("/settings/discord");
    expect(
      Object.fromEntries(new URLSearchParams(window.location.search)),
    ).toStrictEqual({
      status: "error",
      discord_error: "cancelled",
      guild_id: guildId,
    });
    expect(
      screen.getByText(
        "Discord authorization was cancelled. You can start again.",
      ),
    ).toBeInTheDocument();
    expect(getAction("button", "Restart authorization")).toBeEnabled();
    expect(JSON.stringify(telemetry.events)).not.toContain("private-proof");
    expect(JSON.stringify(telemetry.events)).not.toContain("evil.example");
  },
);

test("Login continuation keeps the callback destination and server but never the consent proof", async () => {
  await startPage({
    context,
    path: `/settings/discord?status=pending&guild_id=${guildId}&completionToken=private-token#discord_oauth=approve&state=${state}&approval_proof=${proof}`,
    host: "app.okou.ai",
    auth: null,
  });
  await waitFor(() => {
    expect(window.location.pathname).toBe("/sign-in");
  });
  const redirect = new URLSearchParams(window.location.hash.split("?")[1]).get(
    "redirect_url",
  );
  expect(redirect).toBe(
    `https://app.okou.ai/settings/discord?status=pending&guild_id=${guildId}`,
  );
  expect(window.location.href).not.toContain(proof);
  expect(window.location.href).not.toContain("private-token");
});

test.each([false, true])(
  "The non-handshake fallback waits for actual failure and respects route abort (%s)",
  async (abort) => {
    mockNow(NOW, context.signal);
    let finished = false;
    const pending = context.mocks.deferred<void>();
    const popup = context.mocks.browser.authWindow();
    Object.defineProperty(popup, "location", {
      configurable: true,
      value: { href: "" },
    });
    context.mocks.browser.open(popup);
    context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
      return respond(200, status(true));
    });
    context.mocks.api(discordOauthContract.start, ({ respond }) => {
      return respond(200, { authorizationUrl, completionToken });
    });
    context.mocks.api(discordOauthContract.complete, ({ respond }) => {
      if (!finished) {
        if (!pending.settled()) {
          pending.resolve();
        }
        return respond(409, {
          error: {
            code: "DISCORD_OAUTH_APPROVAL_REQUIRED",
            message: "Approval required",
          },
        });
      }
      return respond(409, {
        error: {
          code: "CONFLICT",
          message:
            "Disconnect the existing Discord account before switching accounts.",
        },
      });
    });
    await setupPage({
      context,
      path: "/settings/discord/install",
      featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
    });
    click(getAction("button", "Join new server"));
    await pending.promise;
    mockNow(NOW + 6000, context.signal);
    expect(popup.location.href).toBe(authorizationUrl);
    finished = true;
    await expect(
      screen.findByText(
        "Discord authorization could not be completed. Try again.",
      ),
    ).resolves.toBeInTheDocument();
    expect(popup.location.href).toBe(authorizationUrl);
    expect(queryAction("link", "Open Discord")).toBeNull();
    if (abort) {
      click(getAction("link", "Back to settings"));
    }
    await waitFor(() => {
      expect(window.location.pathname).toBe(
        abort ? "/works" : "/settings/discord/install",
      );
    });
    mockNow(NOW + 12_000, context.signal);
    await waitFor(() => {
      expect(popup.location.href).toBe(
        abort
          ? authorizationUrl
          : `${window.location.origin}/settings/discord?status=error`,
      );
    });
    expect(popup.closed).toBe(abort);
  },
);

test("An install route cannot consume a consent proof or claim installation from an existing account", async () => {
  vi.stubGlobal("opener", context.mocks.browser.authWindow());
  const approvals: unknown[] = [];
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, status(true));
  });
  context.mocks.api(discordOauthContract.approve, ({ body, respond }) => {
    approvals.push(body);
    return respond(200, { approved: true });
  });
  await setupPage({
    context,
    path: `/settings/discord/install?status=connected#discord_oauth=approve&state=${state}&approval_proof=${proof}`,
    featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
  });
  expect(
    screen.getByRole("heading", { name: "Add Okou to a server" }),
  ).toBeInTheDocument();
  expect(getAction("button", "Join new server")).toBeEnabled();
  expect(queryAction("link", "Open Discord")).toBeNull();
  expect(window.location.hash).toBe("");
  expect(approvals).toStrictEqual([]);
});

test("Restarting an orphaned callback keeps only the public server hint and clears the interruption after real completion", async () => {
  let body: unknown;
  let connected = false;
  let finished = false;
  vi.stubGlobal("opener", null);
  const popup = context.mocks.browser.authWindow();
  Object.defineProperty(popup, "location", {
    configurable: true,
    value: { href: "" },
  });
  context.mocks.browser.open(popup);
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, status(connected));
  });
  context.mocks.api(discordOauthContract.start, ({ body: input, respond }) => {
    body = input;
    return respond(200, { authorizationUrl, completionToken });
  });
  context.mocks.api(
    discordOauthContract.complete,
    ({ body: input, respond }) => {
      expect(input).toStrictEqual({ state, completionToken });
      if (!finished) {
        return respond(409, {
          error: {
            code: "DISCORD_OAUTH_APPROVAL_REQUIRED",
            message: "Approval required",
          },
        });
      }
      connected = true;
      return respond(200, { status: "connected" });
    },
  );
  await setupPage({
    context,
    path: `/settings/discord?status=pending&guild_id=${guildId}&state=old&completionToken=old#discord_oauth=approve&state=${"o".repeat(43)}&approval_proof=${proof}`,
    featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
  });
  click(getAction("button", "Restart authorization"));
  await waitFor(() => {
    return expect(popup.location.href).toBe(authorizationUrl);
  });
  expect(body).toStrictEqual({ guildId });
  expect(window.location.href).not.toContain("old");
  finished = true;
  await expect(
    screen.findByText("Connected to Discord"),
  ).resolves.toBeInTheDocument();
  expect(queryAction("button", "Restart authorization")).toBeNull();
  expect(getAction("link", "Open Discord")).toHaveAttribute(
    "href",
    `discord://-/channels/${guildId}`,
  );
});
