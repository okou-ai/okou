import {
  integrationsDiscordContract,
  type DiscordOrgStatus,
} from "@okouai/api-contracts/contracts/integrations-discord";
import { discordOauthContract } from "@okouai/api-contracts/contracts/discord-oauth";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
  startPage,
} from "../../../__tests__/page-helper.ts";
import { initSentry } from "../../../lib/sentry.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { bootstrapSkeleton } from "../../../test/bootstrap-skeleton.ts";
import {
  getAction,
  getIntegrationCard,
  mockSlack,
  queryAction,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();

function status(overrides: Partial<DiscordOrgStatus> = {}): DiscordOrgStatus {
  return {
    isAvailable: true,
    isConnected: true,
    isAdmin: false,
    guildId: "123456789012345678",
    guildName: "Design team",
    discordUserId: "234567890123456789",
    defaultAgentId: null,
    defaultAgentName: null,
    onboarding: "oauth",
    dmSelectionConnectionId: null,
    dmBindings: [],
    contextMode: "mentions_only",
    ...overrides,
  };
}

function setupDiscordPage() {
  return setupPage({
    context,
    path: "/works",
    featureSwitches: {
      [FeatureSwitchKey.FeishuIntegration]: false,
      [FeatureSwitchKey.LarkIntegration]: false,
    },
  });
}

test.each([
  {
    name: "unconfigured admin",
    data: {
      isAvailable: false,
      isAdmin: true,
      contextMode: "unavailable" as const,
    },
    message: "Discord is not configured for this organization yet.",
    action: null,
  },
  {
    name: "configured admin without a server",
    data: { isAdmin: true },
    message: "Mention Okou in a server or send the bot a direct message.",
    action: "Connect",
  },
  {
    name: "member without a server",
    data: { isAdmin: false },
    message: "Mention Okou in a server or send the bot a direct message.",
    action: "Connect",
  },
  {
    name: "member without a verified connection",
    data: {
      guildId: "123456789012345678",
      guildName: "Design team",
    },
    message: "Mention Okou in a server or send the bot a direct message.",
    action: "Connect",
  },
])("Discord explains setup to a $name", async ({ data, message, action }) => {
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(
      200,
      status({
        isConnected: false,
        guildId: null,
        guildName: null,
        discordUserId: null,
        ...data,
      }),
    );
  });
  await setupDiscordPage();

  await expect(screen.findByText(message)).resolves.toBeInTheDocument();
  const card = getIntegrationCard("Discord");
  const visibleActions = ["Connect", "Install to Discord"].filter((name) => {
    return queryAction("button", name, card) !== null;
  });
  expect(visibleActions).toStrictEqual(action ? [action] : []);
  for (const name of visibleActions) {
    expect(getAction("button", name, card)).toBeEnabled();
  }
  expect(queryAction("button", "More options", card)).toBeNull();
});

function authorizationWindow() {
  const popup = context.mocks.browser.authWindow();
  vi.spyOn(popup, "postMessage");
  Object.defineProperty(popup, "location", {
    configurable: true,
    value: { href: "" },
  });
  const opened = context.mocks.browser.open(popup);
  return { popup, opened };
}

const attemptState = "s".repeat(43);
const completionToken = "c".repeat(43);
const approvalProof = "p".repeat(43);
const authorizationUrl = `https://discord.com/oauth2/authorize?client_id=123456789012345678&state=${attemptState}&scope=identify`;

function consentReady(popup: Window, state = attemptState) {
  context.mocks.browser.message(
    { type: "discord-oauth-ready", state },
    { origin: window.location.origin, source: popup },
  );
}

function approvalRequired() {
  return {
    error: {
      code: "DISCORD_OAUTH_APPROVAL_REQUIRED",
      message:
        "Approve this Discord authorization in the consent browser before completing it.",
    },
  };
}

test.each([true, false])(
  "Discord updates Works and notifies the separate authorization tab of success (admin: %s)",
  async (isAdmin) => {
    let approved = false;
    const approvalPending = context.mocks.deferred<void>();
    let current = status({
      isAdmin,
      isConnected: false,
      discordUserId: null,
      ...(isAdmin ? { guildId: null, guildName: null } : {}),
    });
    const { popup, opened } = authorizationWindow();
    let requestBody: unknown;
    let authorization: string | null = null;
    let query: string | undefined;
    let credentials: RequestCredentials | undefined;
    let completeBody: unknown;
    let completeAuthorization: string | null = null;
    let completeCredentials: RequestCredentials | undefined;
    context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
      return respond(200, current);
    });
    context.mocks.api(
      discordOauthContract.start,
      ({ body, request, respond }) => {
        requestBody = body;
        authorization = request.headers.get("Authorization");
        query = new URL(request.url).search;
        credentials = request.credentials;
        return respond(200, { authorizationUrl, completionToken });
      },
    );
    context.mocks.api(
      discordOauthContract.complete,
      ({ body, request, respond }) => {
        completeBody = body;
        completeAuthorization = request.headers.get("Authorization");
        completeCredentials = request.credentials;
        if (!approved) {
          if (!approvalPending.settled()) {
            approvalPending.resolve();
          }
          return respond(409, approvalRequired());
        }
        current = {
          ...current,
          guildId: "123456789012345678",
          guildName: "Verified team",
          isConnected: true,
          discordUserId: "234567890123456789",
        };
        return respond(200, {
          status: "connected",
        });
      },
    );
    await setupDiscordPage();
    await expect(
      screen.findByText(
        "Mention Okou in a server or send the bot a direct message.",
      ),
    ).resolves.toBeInTheDocument();
    const card = getIntegrationCard("Discord");
    click(getAction("button", "Connect", card));
    await waitFor(() => {
      expect(popup.location.href).toBe(authorizationUrl);
    });
    await approvalPending.promise;
    expect(opened.calls[0]?.url).toBe("about:blank");
    expect(requestBody).toStrictEqual({});
    expect(authorization).toMatch(/^Bearer /u);
    expect(query).toBe("");
    expect(credentials).toBe("include");
    expect(getAction("button", "Connect", card)).toBeDisabled();
    expect(within(card).queryByRole("alert")).toBeNull();
    expect(
      within(card).queryByText(
        "This authorization was interrupted or refreshed.",
      ),
    ).toBeNull();
    expect(within(card).queryByText(/^Connected(?: \(.+\))?$/u)).toBeNull();
    expect(window.location.href).not.toContain(completionToken);
    expect(popup.location.href).not.toContain(completionToken);
    consentReady(popup);
    approved = true;
    await expect(
      within(card).findByText("Connected"),
    ).resolves.toBeInTheDocument();
    expect(completeBody).toStrictEqual({
      state: attemptState,
      completionToken,
    });
    expect(completeAuthorization).toMatch(/^Bearer /u);
    expect(completeCredentials).toBe("include");
    expect(window.location.pathname).toBe("/works");
    expect(window.location.search).toBe("");
    expect(getAction("button", "More options", card)).toBeEnabled();
    expect(queryAction("button", "Connect", card)).toBeNull();
    expect(queryAction("button", "Disconnect Discord")).toBeNull();
    expect(popup.closed).toBeFalsy();
    expect(popup.location.href).toBe(authorizationUrl);
    expect(popup.postMessage).toHaveBeenCalledWith(
      {
        type: "discord-oauth-result",
        state: attemptState,
        status: "connected",
      },
      window.location.origin,
    );
    click(
      getAction(
        "link",
        "Chat",
        screen.getByRole("navigation", { name: "Sidebar" }),
      ),
    );
    await waitFor(() => {
      expect(screen.queryByText("Discord")).toBeNull();
    });
    expect(popup.closed).toBeFalsy();
  },
);

test.each([
  { host: "app.okou.ai", apiOrigin: "https://api.okou.ai" },
  { host: "pr-37968-app.omby.ai", apiOrigin: "https://pr-37968-api.vm6.ai" },
  {
    host: "pr-37968-app-okou-app-preview.vm0.workers.dev",
    apiOrigin: "https://pr-37968-api.vm6.ai",
  },
])(
  "Discord starts at the canonical API host from $host, not an App proxy or web host",
  async ({ host, apiOrigin }) => {
    const { popup } = authorizationWindow();
    let approved = false;
    let current = status({ isConnected: false, discordUserId: null });
    let startUrl: string | undefined;
    let completeUrl: string | undefined;
    let credentials: RequestCredentials | undefined;
    const consent = new URL(authorizationUrl);
    const callback = `${apiOrigin}/api/integrations/discord/oauth/callback`;
    consent.searchParams.set("redirect_uri", callback);
    context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
      return respond(200, current);
    });
    context.mocks.api(discordOauthContract.start, ({ request, respond }) => {
      startUrl = request.url;
      credentials = request.credentials;
      return respond(200, {
        authorizationUrl: consent.toString(),
        completionToken,
      });
    });
    context.mocks.api(discordOauthContract.complete, ({ request, respond }) => {
      completeUrl = request.url;
      if (!approved) {
        return respond(409, approvalRequired());
      }
      current = status();
      return respond(200, { status: "connected" });
    });
    await setupPage({
      context,
      host,
      path: "/works",
    });
    await expect(
      screen.findByText(
        "Mention Okou in a server or send the bot a direct message.",
      ),
    ).resolves.toBeInTheDocument();
    click(getAction("button", "Connect", getIntegrationCard("Discord")));
    await waitFor(() => {
      expect(popup.location.href).toBe(consent.toString());
    });
    expect(startUrl).toBe(`${apiOrigin}/api/integrations/discord/oauth/start`);
    expect(credentials).toBe("include");
    expect(new URL(popup.location.href).searchParams.get("redirect_uri")).toBe(
      callback,
    );
    consentReady(popup);
    approved = true;
    await expect(
      within(getIntegrationCard("Discord")).findByText("Connected"),
    ).resolves.toBeInTheDocument();
    expect(completeUrl).toBe(
      `${apiOrigin}/api/integrations/discord/oauth/complete`,
    );
    expect(popup.postMessage).toHaveBeenCalledWith(
      {
        type: "discord-oauth-result",
        state: attemptState,
        status: "connected",
      },
      `https://${host}`,
    );
    expect(popup.closed).toBeFalsy();
    expect(window.location.pathname).toBe("/works");
  },
);

test("A failed authorization start closes its tab, reports the error, without claiming success", async () => {
  const { popup } = authorizationWindow();
  const current = status({ isConnected: false, discordUserId: null });
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, current);
  });
  context.mocks.api(discordOauthContract.start, ({ respond }) => {
    return respond(503, {
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Discord OAuth is not configured",
      },
    });
  });
  await setupDiscordPage();
  await expect(
    screen.findByText(
      "Mention Okou in a server or send the bot a direct message.",
    ),
  ).resolves.toBeInTheDocument();
  const card = getIntegrationCard("Discord");
  click(getAction("button", "Connect", card));
  await expect(
    screen.findByText("Discord OAuth is not configured"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(getAction("button", "Connect", card)).toBeEnabled();
  });
  expect(popup.closed).toBeTruthy();
  expect(within(card).queryByText(/^Connected(?: \(.+\))?$/u)).toBeNull();
});

test.each([false, true])(
  "Blocked popups explain recovery without same-window fallback (standalone: %s)",
  async (standalone) => {
    context.mocks.browser.standaloneDisplayMode(standalone);
    context.mocks.browser.open(null);
    context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
      return respond(200, status({ isConnected: false, discordUserId: null }));
    });
    await setupDiscordPage();
    await expect(
      screen.findByText(
        "Mention Okou in a server or send the bot a direct message.",
      ),
    ).resolves.toBeInTheDocument();
    click(getAction("button", "Connect", getIntegrationCard("Discord")));
    await expect(
      screen.findByText("The Discord authorization popup was blocked."),
    ).resolves.toBeInTheDocument();
    expect(
      getAction("button", "Connect", getIntegrationCard("Discord")),
    ).toBeEnabled();
  },
);

test("Leaving Works after consent opens cancels the retained opener proof without completing", async () => {
  const { popup } = authorizationWindow();
  const approvalPending = context.mocks.deferred<void>();
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, status({ isConnected: false, discordUserId: null }));
  });
  context.mocks.api(discordOauthContract.start, ({ respond }) => {
    return respond(200, { authorizationUrl, completionToken });
  });
  context.mocks.api(discordOauthContract.complete, ({ respond }) => {
    if (!approvalPending.settled()) {
      approvalPending.resolve();
    }
    return respond(409, approvalRequired());
  });
  await setupDiscordPage();
  await expect(
    screen.findByText(
      "Mention Okou in a server or send the bot a direct message.",
    ),
  ).resolves.toBeInTheDocument();
  click(getAction("button", "Connect", getIntegrationCard("Discord")));
  await waitFor(() => {
    expect(popup.location.href).toBe(authorizationUrl);
  });
  await approvalPending.promise;
  click(
    getAction(
      "link",
      "Chat",
      screen.getByRole("navigation", { name: "Sidebar" }),
    ),
  );
  await waitFor(() => {
    expect(screen.queryByText("Discord")).toBeNull();
    expect(popup.closed).toBeTruthy();
  });
  click(getAction("link", "Where Okou works"));
  await expect(
    screen.findByText(
      "Mention Okou in a server or send the bot a direct message.",
    ),
  ).resolves.toBeInTheDocument();
  expect(
    getAction("button", "Connect", getIntegrationCard("Discord")),
  ).toBeEnabled();
});

test("Leaving Works aborts an in-flight authenticated completion request", async () => {
  const { popup } = authorizationWindow();
  const completing = context.mocks.deferred<void>();
  let completionSignal: AbortSignal | undefined;
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, status({ isConnected: false, discordUserId: null }));
  });
  context.mocks.api(discordOauthContract.start, ({ respond }) => {
    return respond(200, { authorizationUrl, completionToken });
  });
  context.mocks.api(discordOauthContract.complete, ({ request, never }) => {
    completionSignal = request.signal;
    completing.resolve();
    return never();
  });
  await setupDiscordPage();
  await expect(
    screen.findByText(
      "Mention Okou in a server or send the bot a direct message.",
    ),
  ).resolves.toBeInTheDocument();
  click(getAction("button", "Connect", getIntegrationCard("Discord")));
  await waitFor(() => {
    expect(popup.location.href).toBe(authorizationUrl);
  });
  await completing.promise;
  expect(
    getAction("button", "Connect", getIntegrationCard("Discord")),
  ).toBeDisabled();
  click(
    getAction(
      "link",
      "Chat",
      screen.getByRole("navigation", { name: "Sidebar" }),
    ),
  );
  await waitFor(() => {
    expect(screen.queryByText("Discord")).toBeNull();
    expect(completionSignal?.aborted).toBeTruthy();
    expect(popup.closed).toBeTruthy();
  });
});

test("Leaving Works cancels a pending authorization request and closes its blank tab", async () => {
  const { popup } = authorizationWindow();
  const started = context.mocks.deferred<void>();
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, status({ isConnected: false, discordUserId: null }));
  });
  context.mocks.api(discordOauthContract.start, ({ never }) => {
    started.resolve();
    return never();
  });
  await setupDiscordPage();
  await expect(
    screen.findByText(
      "Mention Okou in a server or send the bot a direct message.",
    ),
  ).resolves.toBeInTheDocument();
  click(getAction("button", "Connect", getIntegrationCard("Discord")));
  await started.promise;
  expect(popup.closed).toBeFalsy();
  click(
    getAction(
      "link",
      "Chat",
      screen.getByRole("navigation", { name: "Sidebar" }),
    ),
  );
  await waitFor(() => {
    expect(screen.queryByText("Discord")).toBeNull();
    expect(popup.closed).toBeTruthy();
  });
});

test.each(["connected", "pending", "error"])(
  "A Discord callback indicator %s is not proof of a verified connection",
  async (indicator) => {
    const completionRequests: unknown[] = [];
    context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
      return respond(200, status({ isConnected: false, discordUserId: null }));
    });
    context.mocks.api(discordOauthContract.complete, ({ body, respond }) => {
      completionRequests.push(body);
      return respond(200, { status: "connected" });
    });
    await setupPage({
      context,
      path: `/works?discord=${indicator}&discord_error=private-provider-detail&state=${attemptState}&completionToken=${completionToken}`,
    });
    expect(window.location.pathname).toBe("/settings/discord");
    expect(new URLSearchParams(window.location.search).get("status")).toBe(
      indicator,
    );
    expect(
      screen.getByRole("heading", {
        name:
          indicator === "connected"
            ? "Connect to Discord"
            : "Connection failed",
      }),
    ).toBeInTheDocument();
    expect(queryAction("button", "Connect") !== null).toBe(
      indicator === "connected",
    );
    expect(getAction("link", "Back to settings")).toHaveAttribute(
      "href",
      "/works",
    );
    expect(queryAction("link", "Open Discord")).toBeNull();
    expect(screen.queryByText("private-provider-detail")).toBeNull();
    expect(completionRequests).toStrictEqual([]);
    expect(
      screen.queryByText("Discord authorization could not be completed.") !==
        null,
    ).toBe(indicator === "error");
  },
);

test.each(["/works?discord=pending", "/settings/discord?status=pending"])(
  "Consent browser at %s verifies the current account and stays open while completion is pending",
  async (callbackPath) => {
    vi.stubGlobal("opener", context.mocks.browser.authWindow());
    const closed = vi.spyOn(window, "close").mockImplementation(() => {});
    let approvalBody: unknown;
    let authorization: string | null = null;
    let approvalUrl: string | undefined;
    let credentials: RequestCredentials | undefined;
    context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
      return respond(200, status({ isConnected: false, discordUserId: null }));
    });
    context.mocks.api(
      discordOauthContract.approve,
      ({ body, request, respond }) => {
        approvalBody = body;
        authorization = request.headers.get("Authorization");
        approvalUrl = request.url;
        credentials = request.credentials;
        return respond(200, { approved: true });
      },
    );
    await setupPage({
      context,
      host: "pr-37968-app.omby.ai",
      path: `${callbackPath}#discord_oauth=approve&state=${attemptState}&approval_proof=${approvalProof}`,
    });
    await expect(
      screen.findByRole("heading", { name: "Checking account status..." }),
    ).resolves.toBeInTheDocument();
    expect(window.location.pathname).toBe("/settings/discord");
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(approvalProof);
    await expect(
      screen.findByText("Please wait while we verify your connection."),
    ).resolves.toBeInTheDocument();
    expect(approvalBody).toStrictEqual({ state: attemptState, approvalProof });
    expect(authorization).toMatch(/^Bearer /u);
    expect(approvalUrl).toBe(
      "https://pr-37968-api.vm6.ai/api/integrations/discord/oauth/approve",
    );
    expect(credentials).toBe("include");
    expect(closed).not.toHaveBeenCalled();
    expect(queryAction("link", "Open Discord")).toBeNull();
  },
);

test.each(["", "invalid-proof"])(
  "Malformed approval fragment %s is cleared and cannot authorize from callback markers",
  async (invalidProof) => {
    const approvals: unknown[] = [];
    context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
      return respond(200, status({ isConnected: false, discordUserId: null }));
    });
    context.mocks.api(discordOauthContract.approve, ({ body, respond }) => {
      approvals.push(body);
      return respond(200, { approved: true });
    });
    await setupPage({
      context,
      path: `/works?discord=pending#discord_oauth=approve&state=${attemptState}&approval_proof=${invalidProof}`,
    });
    await expect(
      screen.findByText("This authorization was interrupted or refreshed."),
    ).resolves.toBeInTheDocument();
    expect(window.location.hash).toBe("");
    expect(queryAction("link", "Open Discord")).toBeNull();
    expect(approvals).toStrictEqual([]);
  },
);

test("A rejected consent-browser owner or proof shows restart guidance without connected state", async () => {
  const opener = context.mocks.browser.authWindow();
  vi.stubGlobal("opener", opener);
  const closed = vi.spyOn(window, "close").mockImplementation(() => {});
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, status({ isConnected: false, discordUserId: null }));
  });
  context.mocks.api(discordOauthContract.approve, ({ respond }) => {
    return respond(403, {
      error: {
        code: "FORBIDDEN",
        message: "Discord approval owner does not match",
      },
    });
  });
  await setupPage({
    context,
    path: `/works?discord=pending#discord_oauth=approve&state=${attemptState}&approval_proof=${approvalProof}`,
  });
  await expect(
    screen.findByRole("heading", { name: "Connection failed" }),
  ).resolves.toBeInTheDocument();
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Approval failed. Sign in with the original Okou account and organization, or restart authorization.",
  );
  expect(queryAction("link", "Open Discord")).toBeNull();
  expect(closed).not.toHaveBeenCalled();
  expect(bootstrapSkeleton()).toHaveAttribute("aria-hidden", "true");
});

test("Leaving the consent route cancels automatic verification and destroys its proof", async () => {
  const opener = context.mocks.browser.authWindow();
  vi.stubGlobal("opener", opener);
  const closed = vi.spyOn(window, "close").mockImplementation(() => {});
  const approvals: unknown[] = [];
  const approving = context.mocks.deferred<void>();
  let approvalSignal: AbortSignal | undefined;
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, status({ isConnected: false, discordUserId: null }));
  });
  context.mocks.api(
    discordOauthContract.approve,
    ({ body, request, never }) => {
      approvals.push(body);
      approvalSignal = request.signal;
      approving.resolve();
      return never();
    },
  );
  const page = await startPage({
    context,
    path: `/works?discord=pending#discord_oauth=approve&state=${attemptState}&approval_proof=${approvalProof}`,
  });
  await page.content;
  await approving.promise;
  await expect(
    screen.findByRole("heading", { name: "Checking account status..." }),
  ).resolves.toBeInTheDocument();
  expect(queryAction("link", "Open Discord")).toBeNull();
  click(getAction("link", "Back to settings"));
  await waitFor(() => {
    expect(
      screen.queryByRole("heading", { name: "Checking account status..." }),
    ).toBeNull();
    expect(approvalSignal?.aborted).toBeTruthy();
  });
  await expect(
    screen.findByText(
      "Mention Okou in a server or send the bot a direct message.",
    ),
  ).resolves.toBeInTheDocument();
  await act(() => {
    context.mocks.browser.message(
      {
        type: "discord-oauth-result",
        state: attemptState,
        status: "connected",
      },
      { origin: window.location.origin, source: opener },
    );
    context.mocks.browser.message(
      { type: "discord-oauth-result", state: attemptState, status: "error" },
      { origin: window.location.origin, source: opener },
    );
  });
  expect(window.location.pathname).toBe("/works");
  expect(window.location.search).toBe("");
  expect(approvals).toStrictEqual([{ state: attemptState, approvalProof }]);
  expect(closed).not.toHaveBeenCalled();
});

test("Unapproved popup closure shows cancellation without failure capture", async () => {
  const sentry = context.mocks.sentry();
  initSentry();
  const { popup } = authorizationWindow();
  const current = status({ isConnected: false, discordUserId: null });
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, current);
  });
  context.mocks.api(discordOauthContract.start, ({ respond }) => {
    return respond(200, {
      authorizationUrl,
      completionToken,
    });
  });
  context.mocks.api(discordOauthContract.complete, ({ respond }) => {
    return respond(409, approvalRequired());
  });
  await setupDiscordPage();
  await expect(
    screen.findByText(
      "Mention Okou in a server or send the bot a direct message.",
    ),
  ).resolves.toBeInTheDocument();
  const card = getIntegrationCard("Discord");
  click(getAction("button", "Connect", card));
  await waitFor(() => {
    expect(popup.location.href).toBe(authorizationUrl);
  });
  popup.close();
  await expect(
    screen.findByText("Discord authorization was cancelled."),
  ).resolves.toBeInTheDocument();
  expect(within(card).queryByText(/^Connected(?: \(.+\))?$/u)).toBeNull();
  await waitFor(() => {
    expect(getAction("button", "Connect", card)).toBeEnabled();
  });
  expect(screen.queryByText(approvalRequired().error.message)).toBeNull();
  expect(window.location.pathname).toBe("/works");
  expect(window.location.search).toBe("");
  expect(sentry.reports).toStrictEqual([]);
});

test.each([
  { statusCode: 409 as const, code: "CONFLICT" },
  { statusCode: 400 as const, code: "DISCORD_OAUTH_FAILED" },
  { statusCode: 503 as const, code: "DISCORD_OAUTH_UNAVAILABLE" },
  { statusCode: 403 as const, code: "FORBIDDEN" },
  { statusCode: 503 as const, code: "DISCORD_OAUTH_APPROVAL_REQUIRED" },
])(
  "A terminal completion error $code shows the result in the authorization tab",
  async ({ statusCode, code }) => {
    const sentry = context.mocks.sentry();
    initSentry();
    const { popup } = authorizationWindow();
    context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
      return respond(200, status({ isConnected: false, discordUserId: null }));
    });
    context.mocks.api(discordOauthContract.start, ({ respond }) => {
      return respond(200, { authorizationUrl, completionToken });
    });
    context.mocks.api(discordOauthContract.complete, ({ respond }) => {
      return respond(statusCode, {
        error: { code, message: "Discord could not complete authorization" },
      });
    });
    await setupDiscordPage();
    const card = getIntegrationCard("Discord");
    click(getAction("button", "Connect", card));
    await expect(
      screen.findByText("Discord could not complete authorization"),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(getAction("button", "Connect", card)).toBeEnabled();
    });
    expect(within(card).queryByText("Connected")).toBeNull();
    expect(window.location.pathname).toBe("/works");
    expect(popup.location.href).toBe(authorizationUrl);
    expect(popup.postMessage).not.toHaveBeenCalled();
    // The failure can precede callback bootstrap. Only this popup's readiness
    // for this attempt may receive the retained terminal result.
    await act(() => {
      context.mocks.browser.message(
        { type: "discord-oauth-ready", state: attemptState },
        { origin: "https://untrusted.example", source: popup },
      );
      consentReady(context.mocks.browser.authWindow());
      consentReady(popup, "another-attempt");
    });
    expect(popup.postMessage).not.toHaveBeenCalled();
    consentReady(popup);
    expect(popup.postMessage).toHaveBeenCalledExactlyOnceWith(
      { type: "discord-oauth-result", state: attemptState, status: "error" },
      window.location.origin,
    );
    expect(popup.closed).toBeFalsy();
    expect(sentry.reports).toMatchObject([
      {
        type: "exception",
        error: { code, status: statusCode, expected: false },
      },
    ]);
  },
);

test("A connected member disconnects from the overflow menu on Works", async () => {
  let current = status();
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, current);
  });
  context.mocks.api(integrationsDiscordContract.disconnect, ({ respond }) => {
    current = { ...current, isConnected: false, discordUserId: null };
    return respond(200, { ok: true });
  });
  await setupDiscordPage();

  await expect(screen.findByText("Connected")).resolves.toBeInTheDocument();
  const card = getIntegrationCard("Discord");
  expect(
    within(card).getByText(/^Connected(?: \(.+\))?$/u),
  ).toBeInTheDocument();
  expect(queryAction("button", "Disconnect Discord")).toBeNull();
  click(getAction("button", "More options", card));
  click(getAction("button", "Disconnect Discord"));

  await waitFor(() => {
    expect(getAction("button", "Connect", card)).toBeEnabled();
  });
  expect(
    within(card).queryByText(/^Connected(?: \(.+\))?$/u),
  ).not.toBeInTheDocument();
  expect(queryAction("button", "More options", card)).toBeNull();
  expect(queryAction("button", "Disconnect Discord")).toBeNull();
});

test("A failed disconnect preserves the connection", async () => {
  const current = status();
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, current);
  });
  context.mocks.api(integrationsDiscordContract.disconnect, ({ respond }) => {
    return respond(403, {
      error: { code: "FORBIDDEN", message: "Discord disconnect denied" },
    });
  });
  await setupDiscordPage();
  await expect(screen.findByText("Connected")).resolves.toBeInTheDocument();
  click(getAction("button", "More options", getIntegrationCard("Discord")));
  click(getAction("button", "Disconnect Discord"));

  await expect(
    screen.findByText("Discord disconnect denied"),
  ).resolves.toBeInTheDocument();
  expect(
    within(getIntegrationCard("Discord")).getByText(/^Connected(?: \(.+\))?$/u),
  ).toBeInTheDocument();
});

test("A connected admin can open and dismiss their account menu with the keyboard", async () => {
  const user = userEvent.setup();
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, status({ isAdmin: true }));
  });
  await setupDiscordPage();
  const card = getIntegrationCard("Discord");
  const more = getAction("button", "More options", card);
  expect(queryAction("button", "Disconnect Discord")).toBeNull();
  await user.click(more);
  expect(getAction("button", "Join new server")).toBeEnabled();
  expect(getAction("button", "Disconnect Discord")).toBeEnabled();
  expect(queryAction("button", "Uninstall")).toBeNull();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(more).toHaveFocus();
    expect(queryAction("button", "Disconnect Discord")).toBeNull();
  });
  await user.keyboard("{Enter}");
  expect(getAction("button", "Join new server")).toBeEnabled();
  expect(getAction("button", "Disconnect Discord")).toBeEnabled();
});

test.each([true, false])(
  "Joining a server from the shared Works menu retains the connection (approved: %s)",
  async (approved) => {
    let finished = false;
    let current = status();
    const { popup } = authorizationWindow();
    let requestBody: unknown;
    context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
      return respond(200, current);
    });
    context.mocks.api(discordOauthContract.start, ({ body, respond }) => {
      requestBody = body;
      return respond(200, { authorizationUrl, completionToken });
    });
    context.mocks.api(discordOauthContract.complete, ({ respond }) => {
      if (!finished) {
        return respond(409, approvalRequired());
      }
      if (!approved) {
        return respond(400, {
          error: { code: "BAD_REQUEST", message: "Consent was not completed" },
        });
      }
      current = {
        ...current,
        guildId: "345678901234567890",
        guildName: "New server",
      };
      return respond(200, { status: "connected" });
    });
    await setupDiscordPage();
    const card = getIntegrationCard("Discord");
    const more = getAction("button", "More options", card);
    expect(queryAction("button", "Join new server")).toBeNull();
    click(more);
    expect(getAction("button", "Disconnect Discord")).toBeEnabled();
    click(getAction("button", "Join new server"));
    await waitFor(() => {
      expect(popup.location.href).toBe(authorizationUrl);
    });
    expect(requestBody).toStrictEqual({ flow: "install" });
    expect(getAction("button", "Join new server")).toBeDisabled();
    expect(getAction("button", "Disconnect Discord")).toBeDisabled();
    expect(within(card).getByText("Connected")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/works");
    consentReady(popup);
    finished = true;
    await waitFor(() => {
      expect(getAction("button", "Join new server")).toBeEnabled();
    });
    expect(popup.postMessage).toHaveBeenCalledExactlyOnceWith(
      {
        type: "discord-oauth-result",
        state: attemptState,
        status: approved ? "connected" : "error",
      },
      window.location.origin,
    );
    expect(popup.location.href).toBe(authorizationUrl);
    expect(getAction("button", "Disconnect Discord")).toBeEnabled();
    expect(within(card).getByText("Connected")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/works");
    expect(window.location.search).toBe("");
    expect(popup.closed).toBeFalsy();
    expect(screen.queryByText("Consent was not completed") !== null).toBe(
      !approved,
    );
  },
);

test("Discord status converges after a connection change from another surface", async () => {
  let current = status({
    isConnected: false,
    discordUserId: null,
    isAdmin: true,
  });
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, current);
  });
  await setupDiscordPage();
  await waitFor(() => {
    expect(
      getAction("button", "Connect", getIntegrationCard("Discord")),
    ).toBeEnabled();
  });

  current = {
    ...current,
    isConnected: true,
    discordUserId: "234567890123456789",
    guildName: "Updated team",
  };
  context.mocks.ably.trigger("discord:changed");
  await expect(screen.findByText("Connected")).resolves.toBeInTheDocument();
  expect(
    within(getIntegrationCard("Discord")).getByText(/^Connected(?: \(.+\))?$/u),
  ).toBeInTheDocument();

  current = {
    ...current,
    isConnected: false,
    guildId: null,
    guildName: null,
    discordUserId: null,
  };
  context.mocks.ably.trigger("discord:changed");
  await waitFor(() => {
    expect(
      getAction("button", "Connect", getIntegrationCard("Discord")),
    ).toBeEnabled();
  });
  expect(
    queryAction("button", "More options", getIntegrationCard("Discord")),
  ).toBeNull();
});

test.each([false, true])(
  "Returning to Works preserves Discord status while refreshing (connected: %s)",
  async (isConnected) => {
    const refreshStarted = context.mocks.deferred<void>();
    const refreshReady = context.mocks.deferred<void>();
    let refreshing = false;
    context.mocks.api(
      integrationsDiscordContract.getStatus,
      async ({ respond, withSignal }) => {
        if (refreshing) {
          refreshStarted.resolve();
          await withSignal(refreshReady.promise);
          return respond(200, status({ guildName: "Updated team" }));
        }
        return respond(
          200,
          status({
            isConnected,
            discordUserId: isConnected ? "234567890123456789" : null,
          }),
        );
      },
    );
    await setupDiscordPage();
    const description =
      "Mention Okou in a server or send the bot a direct message.";
    await expect(screen.findByText(description)).resolves.toBeInTheDocument();

    click(
      getAction(
        "link",
        "Chat",
        screen.getByRole("navigation", { name: "Sidebar" }),
      ),
    );
    await waitFor(() => {
      expect(screen.queryByText("Discord")).not.toBeInTheDocument();
    });
    refreshing = true;
    click(getAction("link", "Where Okou works"));
    await refreshStarted.promise;
    const card = await screen.findByRole("region", { name: "Discord" });
    expect(within(card).getByText(description)).toBeInTheDocument();
    const connection = isConnected
      ? within(card).getByText("Connected")
      : getAction("button", "Connect", card);
    expect(connection).toBeInTheDocument();
    expect(connection).not.toBeDisabled();

    refreshReady.resolve();
    await expect(
      within(card).findByText("Connected"),
    ).resolves.toBeInTheDocument();
  },
);

test("Works keeps its startup screen until Discord and Slack status are ready", async () => {
  const statusReady = context.mocks.deferred<void>();
  mockSlack(context, {
    isConnected: true,
    isInstalled: true,
    workspaceName: "Okou HQ",
  });
  context.mocks.api(
    integrationsDiscordContract.getStatus,
    async ({ respond, withSignal }) => {
      await withSignal(statusReady.promise);
      return respond(200, status());
    },
  );
  const page = await startPage({
    context,
    path: "/works",
  });
  // page.content waits for the startup screen to hide, which is gated here.
  await expect(
    screen.findByText("Connected (Okou HQ)"),
  ).resolves.toBeInTheDocument();
  const discordCard = getIntegrationCard("Discord");
  expect(
    within(discordCard).getByText(
      "Mention Okou in a server or send the bot a direct message.",
    ),
  ).toBeInTheDocument();
  expect(queryAllByRoleFast("button", discordCard)).toHaveLength(0);
  const skeleton = bootstrapSkeleton();
  expect(skeleton).not.toHaveAttribute("aria-hidden", "true");
  expect(document.getElementById("root")).toHaveAttribute("inert");

  statusReady.resolve();
  await page.ready;
  await expect(screen.findByText("Connected")).resolves.toBeInTheDocument();
  expect(skeleton).toHaveAttribute("aria-hidden", "true");
  expect(document.getElementById("root")).not.toHaveAttribute("inert");
});

test("A status error hides stale controls and recovers when returning to Works", async () => {
  let denied = false;
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    if (denied) {
      return respond(403, {
        error: { code: "FORBIDDEN", message: "Discord access denied" },
      });
    }
    return respond(200, status());
  });
  await setupDiscordPage();
  await expect(screen.findByText("Connected")).resolves.toBeInTheDocument();
  const card = getIntegrationCard("Discord");
  denied = true;
  context.mocks.ably.trigger("discord:changed");
  await expect(
    screen.findByText("Discord access denied"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(queryAllByRoleFast("button", card)).toHaveLength(0);
  });
  expect(
    within(card).getByText(
      "Mention Okou in a server or send the bot a direct message.",
    ),
  ).toBeInTheDocument();
  expect(
    within(card).queryByText(/^Connected(?: \(.+\))?$/u),
  ).not.toBeInTheDocument();

  click(
    getAction(
      "link",
      "Chat",
      screen.getByRole("navigation", { name: "Sidebar" }),
    ),
  );
  await waitFor(() => {
    expect(screen.queryByText("Discord")).not.toBeInTheDocument();
  });
  denied = false;
  click(getAction("link", "Where Okou works"));
  const recoveredCard = await screen.findByRole("region", { name: "Discord" });
  await expect(
    within(recoveredCard).findByText("Connected"),
  ).resolves.toBeInTheDocument();
  expect(
    within(recoveredCard).getByText(/^Connected(?: \(.+\))?$/u),
  ).toBeInTheDocument();
});

test("Direct messages require an explicit workspace choice and a failed save keeps the prior choice", async () => {
  const first = "e0000000-0000-4000-a000-000000000001";
  const second = "e0000000-0000-4000-a000-000000000002";
  let current = status({
    dmBindings: [
      {
        connectionId: first,
        guildId: "123456789012345678",
        guildName: "Design team",
        workspaceName: "Design team",
      },
      {
        connectionId: second,
        guildId: "345678901234567890",
        guildName: "Operations server",
        workspaceName: "Operations",
      },
    ],
  });
  let denied = true;
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, current);
  });
  context.mocks.api(
    integrationsDiscordContract.setDmSelection,
    ({ body, respond }) => {
      if (denied) {
        return respond(403, {
          error: { code: "FORBIDDEN", message: "Discord choice denied" },
        });
      }
      current = { ...current, dmSelectionConnectionId: body.connectionId };
      return respond(200, { ok: true });
    },
  );
  await setupDiscordPage();
  const select = await screen.findByRole("combobox", {
    name: "Default workspace for Discord",
  });
  expect(select).toHaveTextContent("Choose a workspace");
  click(select);
  click(await screen.findByRole("option", { name: "Operations" }));

  await expect(
    screen.findByText("Discord choice denied"),
  ).resolves.toBeInTheDocument();
  expect(select).toHaveTextContent("Choose a workspace");
  denied = false;
  await waitFor(() => {
    expect(select).toBeEnabled();
  });
  click(select);
  click(await screen.findByRole("option", { name: "Operations" }));
  await waitFor(() => {
    expect(
      screen.getByRole("combobox", {
        name: "Default workspace for Discord",
      }),
    ).toHaveTextContent("Operations");
  });

  current = { ...current, dmSelectionConnectionId: first };
  context.mocks.ably.trigger("discord:changed");
  await waitFor(() => {
    expect(
      screen.getByRole("combobox", {
        name: "Default workspace for Discord",
      }),
    ).toHaveTextContent("Design team");
  });
});

test.each([
  {
    name: "successful refresh",
    refreshError: false,
    refreshMessage: "Connected",
  },
  {
    name: "failed refresh and recovery",
    refreshError: true,
    refreshMessage: "Discord refresh denied",
  },
])(
  "A pending DM choice remains disabled through a $name",
  async ({ refreshError, refreshMessage }) => {
    const first = "e0000000-0000-4000-a000-000000000001";
    const second = "e0000000-0000-4000-a000-000000000002";
    const saveStarted = context.mocks.deferred<void>();
    const saveReady = context.mocks.deferred<void>();
    const refreshStarted = context.mocks.deferred<void>();
    const refreshReady = context.mocks.deferred<void>();
    let current = status({
      dmSelectionConnectionId: first,
      dmBindings: [
        {
          connectionId: first,
          guildId: "123456789012345678",
          guildName: "Design team",
          workspaceName: "Design team",
        },
        {
          connectionId: second,
          guildId: "345678901234567890",
          guildName: "Operations server",
          workspaceName: "Operations",
        },
      ],
    });
    let denyRefresh = false;
    let deferNextRefresh = false;
    context.mocks.api(
      integrationsDiscordContract.getStatus,
      async ({ respond, withSignal }) => {
        if (deferNextRefresh) {
          deferNextRefresh = false;
          refreshStarted.resolve();
          await withSignal(refreshReady.promise);
        }
        if (denyRefresh) {
          return respond(403, {
            error: { code: "FORBIDDEN", message: "Discord refresh denied" },
          });
        }
        return respond(200, current);
      },
    );
    context.mocks.api(
      integrationsDiscordContract.setDmSelection,
      async ({ body, respond, withSignal }) => {
        saveStarted.resolve();
        await withSignal(saveReady.promise);
        current = { ...current, dmSelectionConnectionId: body.connectionId };
        return respond(200, { ok: true });
      },
    );
    await setupDiscordPage();
    const initialSelect = await screen.findByRole("combobox", {
      name: "Default workspace for Discord",
    });
    click(initialSelect);
    click(await screen.findByRole("option", { name: "Operations" }));
    await saveStarted.promise;

    current = { ...current, guildName: "Updated team" };
    deferNextRefresh = true;
    denyRefresh = refreshError;
    context.mocks.ably.trigger("discord:changed");
    await refreshStarted.promise;
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", {
        name: "Default workspace for Discord",
      }),
    ).toBeDisabled();
    refreshReady.resolve();
    await expect(
      screen.findByText(refreshMessage),
    ).resolves.toBeInTheDocument();
    if (denyRefresh) {
      denyRefresh = false;
      context.mocks.ably.trigger("discord:changed");
    }
    await expect(screen.findByText("Connected")).resolves.toBeInTheDocument();
    const select = screen.getByRole("combobox", {
      name: "Default workspace for Discord",
    });
    expect(select).toBeDisabled();
    expect(select).toHaveTextContent("Design team");
    click(select);
    expect(screen.queryByRole("option", { name: "Design team" })).toBeNull();

    saveReady.resolve();
    await waitFor(() => {
      const saved = screen.getByRole("combobox", {
        name: "Default workspace for Discord",
      });
      expect(saved).toBeEnabled();
      expect(saved).toHaveTextContent("Operations");
    });
  },
);

test.each([
  {
    name: "admin",
    data: { isAdmin: true },
    connected: true,
    actions: ["Disconnect Discord"],
  },
  {
    name: "connected member",
    data: { isAdmin: false },
    connected: true,
    actions: ["Disconnect Discord"],
  },
  {
    name: "member without a connection",
    data: { isAdmin: false, isConnected: false, discordUserId: null },
    connected: false,
    actions: [] as string[],
  },
])(
  "A missing bot configuration shows one unavailable state to an installed $name",
  async ({ data, connected, actions }) => {
    context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
      return respond(
        200,
        status({ isAvailable: false, contextMode: "unavailable", ...data }),
      );
    });
    await setupDiscordPage();

    await expect(
      screen.findByText(
        connected
          ? "Discord is temporarily unavailable. Existing connections are kept."
          : "Discord is not configured for this organization yet.",
      ),
    ).resolves.toBeInTheDocument();
    const card = getIntegrationCard("Discord");
    expect(
      within(card).queryByText(
        connected
          ? "Discord is not configured for this organization yet."
          : "Discord is temporarily unavailable. Existing connections are kept.",
      ),
    ).toBeNull();
    expect(
      within(card).queryAllByText(/^Connected(?: \(.+\))?$/u),
    ).toHaveLength(connected ? 1 : 0);
    expect(queryAction("button", "Disconnect Discord")).toBeNull();
    const menu = queryAction("button", "More options", card);
    expect(menu !== null).toBe(connected);
    if (menu) {
      click(menu);
    }
    for (const action of ["Disconnect Discord", "Join new server"]) {
      expect(queryAction("button", action) !== null).toBe(
        actions.includes(action),
      );
    }
  },
);

test("Saving a Discord workspace stays pending until the refreshed choice arrives", async () => {
  const first = "e0000000-0000-4000-a000-000000000001";
  const second = "e0000000-0000-4000-a000-000000000002";
  const refreshStarted = context.mocks.deferred<void>();
  const refreshReady = context.mocks.deferred<void>();
  let current = status({
    dmSelectionConnectionId: first,
    dmBindings: [
      {
        connectionId: first,
        guildId: "123456789012345678",
        guildName: "Design team",
        workspaceName: "Design team",
      },
      {
        connectionId: second,
        guildId: "345678901234567890",
        guildName: "Operations server",
        workspaceName: "Operations",
      },
    ],
  });
  let deferNextRefresh = false;
  context.mocks.api(
    integrationsDiscordContract.getStatus,
    async ({ respond, withSignal }) => {
      if (deferNextRefresh) {
        deferNextRefresh = false;
        refreshStarted.resolve();
        await withSignal(refreshReady.promise);
      }
      return respond(200, current);
    },
  );
  context.mocks.api(
    integrationsDiscordContract.setDmSelection,
    ({ body, respond }) => {
      current = { ...current, dmSelectionConnectionId: body.connectionId };
      deferNextRefresh = true;
      return respond(200, { ok: true });
    },
  );
  await setupDiscordPage();
  click(
    await screen.findByRole("combobox", {
      name: "Default workspace for Discord",
    }),
  );
  click(await screen.findByRole("option", { name: "Operations" }));

  await refreshStarted.promise;
  const pending = screen.getByRole("combobox", {
    name: "Default workspace for Discord",
  });
  expect(pending).toBeDisabled();
  refreshReady.resolve();
  await waitFor(() => {
    const saved = screen.getByRole("combobox", {
      name: "Default workspace for Discord",
    });
    expect(saved).toBeEnabled();
    expect(saved).toHaveTextContent("Operations");
  });
});

test("Disconnecting stays pending until the refreshed status arrives", async () => {
  const refreshStarted = context.mocks.deferred<void>();
  const refreshReady = context.mocks.deferred<void>();
  let current = status();
  let deferNextRefresh = false;
  context.mocks.api(
    integrationsDiscordContract.getStatus,
    async ({ respond, withSignal }) => {
      if (deferNextRefresh) {
        deferNextRefresh = false;
        refreshStarted.resolve();
        await withSignal(refreshReady.promise);
      }
      return respond(200, current);
    },
  );
  context.mocks.api(integrationsDiscordContract.disconnect, ({ respond }) => {
    current = { ...current, isConnected: false, discordUserId: null };
    deferNextRefresh = true;
    return respond(200, { ok: true });
  });
  await setupDiscordPage();
  await expect(screen.findByText("Connected")).resolves.toBeInTheDocument();
  click(getAction("button", "More options", getIntegrationCard("Discord")));
  click(getAction("button", "Disconnect Discord"));

  await refreshStarted.promise;
  expect(getAction("button", "Disconnect Discord")).toBeDisabled();
  expect(getAction("button", "Disconnect Discord")).toHaveTextContent(
    "Disconnecting…",
  );
  refreshReady.resolve();
  await waitFor(() => {
    expect(
      getAction("button", "Connect", getIntegrationCard("Discord")),
    ).toBeEnabled();
  });
  expect(
    within(getIntegrationCard("Discord")).queryByText(
      /^Connected(?: \(.+\))?$/u,
    ),
  ).toBeNull();
});
