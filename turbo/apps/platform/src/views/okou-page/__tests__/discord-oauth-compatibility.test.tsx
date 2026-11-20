import { discordOauthContract } from "@okouai/api-contracts/contracts/discord-oauth";
import {
  integrationsDiscordContract,
  type DiscordOrgStatus,
} from "@okouai/api-contracts/contracts/integrations-discord";
import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
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

// A consent tab either sends ready and receives the result, or is closed by the
// user after approving while a pending completion response is in flight.
test.each(["closed after approval", "ready"] as const)(
  "The current Works opener completes safely with a %s consent tab",
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
    });
    const card = getIntegrationCard("Discord");
    click(getAction("button", "Connect", card));
    await pending.promise;
    expect(popup.location.href).toBe(authorizationUrl);
    expect(within(card).queryByText("Connected")).toBeNull();
    if (generation === "closed after approval") {
      popup.close();
    }
    approved = true;
    await expect(
      within(card).findByText("Connected"),
    ).resolves.toBeInTheDocument();
    expect(window.location.pathname).toBe("/works");
    expect(window.location.search).toBe("");
    expect(popup.location.href).toBe(authorizationUrl);
    if (generation === "ready") {
      // A ready event that arrives after completion still receives the result.
      context.mocks.browser.message(
        { type: "discord-oauth-ready", state },
        { origin: window.location.origin, source: popup },
      );
    }
    await waitFor(() => {
      expect(messages.mock.calls).toHaveLength(generation === "ready" ? 1 : 0);
    });
    expect(popup.location.href).toBe(authorizationUrl);
    expect(messages.mock.calls).toStrictEqual(
      generation === "ready"
        ? [
            [
              { type: "discord-oauth-result", state, status: "connected" },
              window.location.origin,
            ],
          ]
        : [],
    );
    expect(popup.closed).toBe(generation === "closed after approval");
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
    });
    const container =
      path === "/works" ? getIntegrationCard("Discord") : document.body;
    click(getAction("button", "Connect", container));
    await pending.promise;
    expect(popup.location.href).toBe(authorizationUrl);
    // The API has already decided pending when the consent tab approves and
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
      screen.queryByText("Discord authorization was cancelled."),
    ).toBeNull();
    expect(sentry.reports).toStrictEqual([]);
  },
);

test.each(["missing", "closes after approval"] as readonly (
  "missing" | "closed" | "closes after approval"
)[])(
  "A %s opener reports authorization interruption without retaining proof",
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
    });
    if (kind === "closes after approval") {
      opener.close();
    }
    await expect(
      screen.findByText("This authorization was interrupted or refreshed."),
    ).resolves.toBeInTheDocument();
    expect(queryAction("link", "Open Discord")).toBeNull();
    expect(approvals).toHaveLength(kind === "closes after approval" ? 1 : 0);
    expect(window.location.href).not.toContain(proof);
  },
);

test("The first completion result wins over a duplicate result", async () => {
  const opener = context.mocks.browser.authWindow();
  vi.stubGlobal("opener", opener);
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, status(true));
  });
  context.mocks.api(discordOauthContract.approve, ({ respond }) => {
    return respond(200, { approved: true });
  });
  await setupPage({
    context,
    path: callback,
  });
  await act(() => {
    context.mocks.browser.message(
      { type: "discord-oauth-result", state, status: "connected" },
      { origin: window.location.origin, source: opener },
    );
    context.mocks.browser.message(
      { type: "discord-oauth-result", state, status: "error" },
      { origin: window.location.origin, source: opener },
    );
  });
  await expect(
    screen.findByText("Connected to Discord"),
  ).resolves.toBeInTheDocument();
  expect(window.location.search).toBe("?status=connected");
});

test("A failed attempt keeps its consent popup until route abort closes it", async () => {
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
  });
  click(getAction("button", "Join new server"));
  await pending.promise;
  expect(popup.location.href).toBe(authorizationUrl);
  finished = true;
  await expect(
    screen.findByText("Discord authorization could not be completed."),
  ).resolves.toBeInTheDocument();
  expect(popup.location.href).toBe(authorizationUrl);
  expect(queryAction("link", "Open Discord")).toBeNull();
  click(getAction("link", "Back to settings"));
  await waitFor(() => {
    expect(window.location.pathname).toBe("/works");
  });
  await waitFor(() => {
    expect(popup.closed).toBeTruthy();
  });
  expect(popup.location.href).toBe(authorizationUrl);
});
