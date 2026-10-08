import {
  integrationsDiscordContract,
  type DiscordOrgStatus,
} from "@okouai/api-contracts/contracts/integrations-discord";
import { discordOauthContract } from "@okouai/api-contracts/contracts/discord-oauth";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getAction,
  getIntegrationCard,
  queryAction,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();

function status(overrides: Partial<DiscordOrgStatus> = {}): DiscordOrgStatus {
  return {
    isAvailable: true,
    isInstalled: true,
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

function setupDiscordPage(enabled = true) {
  return setupPage({
    context,
    path: "/works",
    featureSwitches: {
      [FeatureSwitchKey.DiscordIntegration]: enabled,
      [FeatureSwitchKey.FeishuIntegration]: false,
      [FeatureSwitchKey.LarkIntegration]: false,
    },
  });
}

test("Discord is hidden while its feature switch is off", async () => {
  await setupDiscordPage(false);
  expect(screen.getByText("Slack")).toBeInTheDocument();
  expect(screen.queryByText("Discord")).not.toBeInTheDocument();
});

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
    message: "Install Okou to your Discord server, then connect your account.",
    action: "Install to Discord",
  },
  {
    name: "member without a server",
    data: { isAdmin: false },
    message:
      "Ask an organization admin to install Okou to your Discord server.",
    action: null,
  },
  {
    name: "member without a verified connection",
    data: {
      isInstalled: true,
      guildId: "123456789012345678",
      guildName: "Design team",
    },
    message: "Connect your Discord account through official browser consent.",
    action: "Connect",
  },
])("Discord explains setup to a $name", async ({ data, message, action }) => {
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(
      200,
      status({
        isInstalled: false,
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
  expect(queryAction("button", "More Discord options", card)).toBeNull();
});

function authorizationWindow() {
  const popup = context.mocks.browser.authWindow();
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

test.each(["install", "connect"] as const)(
  "Discord completes authenticated %s with retained opener proof before refreshing public status",
  async (flow) => {
    let current = status({
      isAdmin: flow === "install",
      isInstalled: flow === "connect",
      isConnected: false,
      discordUserId: null,
      ...(flow === "install" ? { guildId: null, guildName: null } : {}),
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
        current = {
          ...current,
          isInstalled: true,
          guildId: "123456789012345678",
          guildName: "Verified team",
          isConnected: flow === "connect",
          discordUserId: flow === "connect" ? "234567890123456789" : null,
        };
        return respond(200, {
          status: flow === "install" ? "installed" : "connected",
        });
      },
    );
    await setupDiscordPage();
    await expect(
      screen.findByText(
        flow === "install"
          ? "Install Okou to your Discord server, then connect your account."
          : "Connect your Discord account through official browser consent.",
      ),
    ).resolves.toBeInTheDocument();
    const card = getIntegrationCard("Discord");
    click(
      getAction(
        "button",
        flow === "install" ? "Install to Discord" : "Connect",
        card,
      ),
    );
    await waitFor(() => {
      expect(popup.location.href).toBe(authorizationUrl);
    });
    expect(opened.calls[0]?.url).toBe("about:blank");
    expect(requestBody).toStrictEqual({
      flow,
      ...(flow === "connect" ? { guildId: current.guildId } : {}),
    });
    expect(authorization).toMatch(/^Bearer /u);
    expect(query).toBe("");
    expect(credentials).toBe("include");
    expect(getAction("button", "Authorizing…", card)).toBeDisabled();
    expect(within(card).queryByText("Connected")).toBeNull();
    expect(completeBody).toBeUndefined();
    expect(window.location.href).not.toContain(completionToken);
    expect(popup.location.href).not.toContain(completionToken);
    popup.close();
    await expect(
      screen.findByText("Server: Verified team"),
    ).resolves.toBeInTheDocument();
    expect(completeBody).toStrictEqual({
      state: attemptState,
      completionToken,
    });
    expect(completeAuthorization).toMatch(/^Bearer /u);
    expect(completeCredentials).toBe("include");
    await waitFor(() => {
      const outcome =
        flow === "connect"
          ? within(card).getByText("Connected")
          : getAction("button", "Connect", card);
      expect(outcome).toBeInTheDocument();
      expect(outcome).not.toBeDisabled();
    });
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
    let startUrl: string | undefined;
    let completeUrl: string | undefined;
    let credentials: RequestCredentials | undefined;
    const consent = new URL(authorizationUrl);
    const callback = `${apiOrigin}/api/integrations/discord/oauth/callback`;
    consent.searchParams.set("redirect_uri", callback);
    context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
      return respond(200, status({ isConnected: false, discordUserId: null }));
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
      return respond(200, { status: "connected" });
    });
    await setupPage({
      context,
      host,
      path: "/works",
      featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
    });
    await expect(
      screen.findByText("Server: Design team"),
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
    popup.close();
    await waitFor(() => {
      expect(
        getAction("button", "Connect", getIntegrationCard("Discord")),
      ).toBeEnabled();
    });
    expect(completeUrl).toBe(
      `${apiOrigin}/api/integrations/discord/oauth/complete`,
    );
  },
);

test("A failed authorization start closes its tab, reports the error, and permits retry without claiming success", async () => {
  const { popup } = authorizationWindow();
  let denied = true;
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, status({ isConnected: false, discordUserId: null }));
  });
  context.mocks.api(discordOauthContract.start, ({ respond }) => {
    return denied
      ? respond(503, {
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "Discord OAuth is not configured",
          },
        })
      : respond(200, { authorizationUrl, completionToken });
  });
  context.mocks.api(discordOauthContract.complete, ({ respond }) => {
    return respond(200, { status: "connected" });
  });
  await setupDiscordPage();
  await expect(
    screen.findByText("Server: Design team"),
  ).resolves.toBeInTheDocument();
  const card = getIntegrationCard("Discord");
  click(getAction("button", "Connect", card));
  await expect(
    screen.findByText("Discord OAuth is not configured"),
  ).resolves.toBeInTheDocument();
  await expect(within(card).findByRole("alert")).resolves.toHaveTextContent(
    "Discord authorization could not be completed",
  );
  expect(popup.closed).toBeTruthy();
  const retryPopup = authorizationWindow().popup;
  denied = false;
  click(getAction("button", "Retry", card));
  await waitFor(() => {
    expect(retryPopup.location.href).toBe(authorizationUrl);
  });
  retryPopup.close();
  await waitFor(() => {
    expect(getAction("button", "Connect", card)).toBeEnabled();
  });
  expect(within(card).queryByText("Connected")).toBeNull();
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
      screen.findByText("Server: Design team"),
    ).resolves.toBeInTheDocument();
    click(getAction("button", "Connect", getIntegrationCard("Discord")));
    await expect(
      screen.findByText("Allow popups to authorize Discord, then try again."),
    ).resolves.toBeInTheDocument();
    expect(
      getAction("button", "Retry", getIntegrationCard("Discord")),
    ).toBeEnabled();
  },
);

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
    screen.findByText("Server: Design team"),
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
      featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
    });
    await expect(
      screen.findByText("Server: Design team"),
    ).resolves.toBeInTheDocument();
    const card = getIntegrationCard("Discord");
    expect(getAction("button", "Connect", card)).toBeEnabled();
    expect(within(card).queryByText("Connected")).toBeNull();
    expect(screen.queryByText("private-provider-detail")).toBeNull();
    expect(completionRequests).toStrictEqual([]);
    expect(within(card).queryByRole("alert") !== null).toBe(
      indicator === "error",
    );
    expect(
      within(card).queryByText(
        "Discord authorization could not be completed. Try again from this card.",
      ) !== null,
    ).toBe(indicator === "error");
  },
);

test("Consent browser clears its fragment and approves with current authentication without completing or claiming connected", async () => {
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
    path: `/works?discord=pending#discord_oauth=approve&state=${attemptState}&approval_proof=${approvalProof}`,
    featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
  });
  await expect(
    screen.findByText("Server: Design team"),
  ).resolves.toBeInTheDocument();
  expect(window.location.hash).toBe("");
  expect(window.location.href).not.toContain(approvalProof);
  expect(approvalBody).toBeUndefined();
  const card = getIntegrationCard("Discord");
  click(getAction("button", "Confirm Discord consent", card));
  await expect(
    screen.findByText(
      "Browser consent approved. Close this tab to finish in the original Works tab.",
    ),
  ).resolves.toBeInTheDocument();
  expect(approvalBody).toStrictEqual({ state: attemptState, approvalProof });
  expect(authorization).toMatch(/^Bearer /u);
  expect(approvalUrl).toBe(
    "https://pr-37968-api.vm6.ai/api/integrations/discord/oauth/approve",
  );
  expect(credentials).toBe("include");
  expect(closed).toHaveBeenCalledOnce();
  expect(within(card).queryByText("Connected")).toBeNull();
  expect(queryAction("button", "Confirm Discord consent", card)).toBeNull();
});

test("A rejected consent-browser owner or proof shows restart guidance without connected state", async () => {
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
    featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
  });
  await expect(
    screen.findByText("Server: Design team"),
  ).resolves.toBeInTheDocument();
  const card = getIntegrationCard("Discord");
  click(getAction("button", "Confirm Discord consent", card));
  await expect(within(card).findByRole("alert")).resolves.toHaveTextContent(
    "Approval failed. Sign in with the original Okou account and organization, or restart authorization.",
  );
  expect(within(card).queryByText("Connected")).toBeNull();
  expect(getAction("button", "Confirm Discord consent", card)).toBeEnabled();
});

test("Leaving the consent route destroys approval memory and callback queries cannot recover it", async () => {
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
    path: `/works?discord=pending#discord_oauth=approve&state=${attemptState}&approval_proof=${approvalProof}`,
    featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
  });
  await expect(
    screen.findByText("Server: Design team"),
  ).resolves.toBeInTheDocument();
  expect(
    getAction(
      "button",
      "Confirm Discord consent",
      getIntegrationCard("Discord"),
    ),
  ).toBeEnabled();
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
  click(getAction("link", "Where Okou works"));
  await expect(
    screen.findByText("Server: Design team"),
  ).resolves.toBeInTheDocument();
  expect(
    queryAction(
      "button",
      "Confirm Discord consent",
      getIntegrationCard("Discord"),
    ),
  ).toBeNull();
  expect(approvals).toStrictEqual([]);
});

test("Popup closure without approved evidence fails completion instead of manufacturing a connection", async () => {
  const { popup } = authorizationWindow();
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, status({ isConnected: false, discordUserId: null }));
  });
  context.mocks.api(discordOauthContract.start, ({ respond }) => {
    return respond(200, { authorizationUrl, completionToken });
  });
  context.mocks.api(discordOauthContract.complete, ({ respond }) => {
    return respond(400, {
      error: {
        code: "BAD_REQUEST",
        message: "Discord consent has not been approved",
      },
    });
  });
  await setupDiscordPage();
  await expect(
    screen.findByText("Server: Design team"),
  ).resolves.toBeInTheDocument();
  const card = getIntegrationCard("Discord");
  click(getAction("button", "Connect", card));
  await waitFor(() => {
    expect(popup.location.href).toBe(authorizationUrl);
  });
  popup.close();
  await expect(within(card).findByRole("alert")).resolves.toHaveTextContent(
    "Discord authorization could not be completed",
  );
  expect(within(card).queryByText("Connected")).toBeNull();
  expect(getAction("button", "Retry", card)).toBeEnabled();
});

test("A connected member sees server and context limits and can disconnect", async () => {
  let current = status();
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, current);
  });
  context.mocks.api(integrationsDiscordContract.disconnect, ({ respond }) => {
    current = { ...current, isConnected: false, discordUserId: null };
    return respond(200, { ok: true });
  });
  await setupDiscordPage();

  await expect(
    screen.findByText("Server: Design team"),
  ).resolves.toBeInTheDocument();
  const card = getIntegrationCard("Discord");
  expect(within(card).getByText("Connected")).toBeInTheDocument();
  expect(within(card).getByText(/Limited context:/u)).toBeInTheDocument();
  click(getAction("button", "More Discord options", card));
  expect(queryAction("button", "Remove Discord")).toBeNull();
  click(getAction("button", "Disconnect Discord"));

  await expect(
    screen.findByText(
      "Connect your Discord account through official browser consent.",
    ),
  ).resolves.toBeInTheDocument();
  expect(within(card).queryByText("Connected")).not.toBeInTheDocument();
});

test("A failed disconnect preserves the connection and allows retry", async () => {
  let current = status();
  let denied = true;
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, current);
  });
  context.mocks.api(integrationsDiscordContract.disconnect, ({ respond }) => {
    if (denied) {
      return respond(403, {
        error: { code: "FORBIDDEN", message: "Discord disconnect denied" },
      });
    }
    current = { ...current, isConnected: false, discordUserId: null };
    return respond(200, { ok: true });
  });
  await setupDiscordPage();
  await expect(
    screen.findByText("Server: Design team"),
  ).resolves.toBeInTheDocument();
  click(
    getAction("button", "More Discord options", getIntegrationCard("Discord")),
  );
  click(getAction("button", "Disconnect Discord"));

  await expect(
    screen.findByText("Discord disconnect denied"),
  ).resolves.toBeInTheDocument();
  expect(
    within(getIntegrationCard("Discord")).getByText("Connected"),
  ).toBeInTheDocument();
  denied = false;
  await waitFor(() => {
    return expect(getAction("button", "Disconnect Discord")).toBeEnabled();
  });
  click(getAction("button", "Disconnect Discord"));
  await expect(
    screen.findByText(/Connect your Discord account/u),
  ).resolves.toBeInTheDocument();
});

test("An admin confirms server removal and can retry a failed removal", async () => {
  let current = status({
    isAdmin: true,
    isConnected: false,
    discordUserId: null,
    contextMode: "full",
  });
  let denied = true;
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, current);
  });
  context.mocks.api(
    integrationsDiscordContract.disconnect,
    ({ query, respond }) => {
      if (query.action !== "uninstall") {
        throw new Error("Server removal must request the admin action");
      }
      if (denied) {
        return respond(403, {
          error: { code: "FORBIDDEN", message: "Discord removal denied" },
        });
      }
      current = {
        ...current,
        isInstalled: false,
        guildId: null,
        guildName: null,
      };
      return respond(200, { ok: true });
    },
  );
  await setupDiscordPage();
  await expect(
    screen.findByText("Server: Design team"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText(/Limited context:/u)).not.toBeInTheDocument();
  click(
    getAction("button", "More Discord options", getIntegrationCard("Discord")),
  );
  click(getAction("button", "Remove Discord"));
  const dialog = await screen.findByRole("dialog", {
    name: "Remove Discord from this organization?",
  });
  expect(dialog).toHaveAccessibleDescription(
    "This disconnects everyone in this organization from Discord. Other organizations keep their connections.",
  );
  click(getAction("button", "Uninstall", dialog));

  await expect(
    screen.findByText("Discord removal denied"),
  ).resolves.toBeInTheDocument();
  expect(dialog).toBeInTheDocument();
  denied = false;
  await waitFor(() => {
    return expect(getAction("button", "Uninstall", dialog)).toBeEnabled();
  });
  click(getAction("button", "Uninstall", dialog));
  await expect(
    screen.findByText(/Install Okou to your Discord server/u),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

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
  await expect(
    screen.findByText(/Connect your Discord account/u),
  ).resolves.toBeInTheDocument();

  current = {
    ...current,
    isConnected: true,
    discordUserId: "234567890123456789",
    guildName: "Updated team",
  };
  context.mocks.ably.trigger("discord:changed");
  await expect(
    screen.findByText("Server: Updated team"),
  ).resolves.toBeInTheDocument();
  expect(
    within(getIntegrationCard("Discord")).getByText("Connected"),
  ).toBeInTheDocument();

  current = {
    ...current,
    isConnected: false,
    isInstalled: false,
    guildId: null,
    guildName: null,
    discordUserId: null,
  };
  context.mocks.ably.trigger("discord:changed");
  await expect(
    screen.findByText(/Install Okou to your Discord server/u),
  ).resolves.toBeInTheDocument();
  expect(
    queryAction(
      "button",
      "More Discord options",
      getIntegrationCard("Discord"),
    ),
  ).toBeNull();
});

test("A status error is visible and retry recovers the card", async () => {
  let denied = true;
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    if (denied) {
      return respond(403, {
        error: { code: "FORBIDDEN", message: "Discord access denied" },
      });
    }
    return respond(200, status());
  });
  await setupDiscordPage();
  await expect(
    screen.findByText("Unable to load Discord status."),
  ).resolves.toBeInTheDocument();
  const card = getIntegrationCard("Discord");
  expect(queryAction("button", "More Discord options", card)).toBeNull();
  denied = false;
  click(getAction("button", "Retry", card));
  await expect(
    screen.findByText("Server: Design team"),
  ).resolves.toBeInTheDocument();
});

test("Direct messages require an explicit server choice and a failed save keeps the prior choice", async () => {
  const first = "e0000000-0000-4000-a000-000000000001";
  const second = "e0000000-0000-4000-a000-000000000002";
  let current = status({
    dmBindings: [
      {
        connectionId: first,
        guildId: "123456789012345678",
        guildName: "Design team",
      },
      {
        connectionId: second,
        guildId: "345678901234567890",
        guildName: "Operations",
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
    name: "Default server for direct messages",
  });
  expect(select).toHaveTextContent("Choose a server");
  click(select);
  click(await screen.findByRole("option", { name: "Operations" }));

  await expect(
    screen.findByText("Discord choice denied"),
  ).resolves.toBeInTheDocument();
  expect(select).toHaveTextContent("Choose a server");
  denied = false;
  await waitFor(() => {
    expect(select).toBeEnabled();
  });
  click(select);
  click(await screen.findByRole("option", { name: "Operations" }));
  await waitFor(() => {
    expect(
      screen.getByRole("combobox", {
        name: "Default server for direct messages",
      }),
    ).toHaveTextContent("Operations");
  });

  current = { ...current, dmSelectionConnectionId: first };
  context.mocks.ably.trigger("discord:changed");
  await waitFor(() => {
    expect(
      screen.getByRole("combobox", {
        name: "Default server for direct messages",
      }),
    ).toHaveTextContent("Design team");
  });
});

test.each([
  {
    name: "successful refresh",
    refreshError: false,
    refreshMessage: "Server: Updated team",
  },
  {
    name: "failed refresh and retry",
    refreshError: true,
    refreshMessage: "Unable to load Discord status.",
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
        },
        {
          connectionId: second,
          guildId: "345678901234567890",
          guildName: "Operations",
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
      name: "Default server for direct messages",
    });
    click(initialSelect);
    click(await screen.findByRole("option", { name: "Operations" }));
    await saveStarted.promise;

    current = { ...current, guildName: "Updated team" };
    deferNextRefresh = true;
    denyRefresh = refreshError;
    context.mocks.ably.trigger("discord:changed");
    await refreshStarted.promise;
    expect(
      screen.getByRole("combobox", {
        name: "Default server for direct messages",
      }),
    ).toBeDisabled();
    refreshReady.resolve();
    await expect(
      screen.findByText(refreshMessage),
    ).resolves.toBeInTheDocument();
    if (denyRefresh) {
      denyRefresh = false;
      click(getAction("button", "Retry", getIntegrationCard("Discord")));
    }
    await expect(
      screen.findByText("Server: Updated team"),
    ).resolves.toBeInTheDocument();
    const select = screen.getByRole("combobox", {
      name: "Default server for direct messages",
    });
    expect(select).toBeDisabled();
    expect(select).toHaveTextContent("Design team");
    click(select);
    expect(screen.queryByRole("option", { name: "Design team" })).toBeNull();

    saveReady.resolve();
    await waitFor(() => {
      const saved = screen.getByRole("combobox", {
        name: "Default server for direct messages",
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
    actions: ["Disconnect Discord", "Remove Discord"],
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
        "Discord is temporarily unavailable. Existing connections are kept.",
      ),
    ).resolves.toBeInTheDocument();
    const card = getIntegrationCard("Discord");
    expect(
      within(card).queryByText(
        "Discord is not configured for this organization yet.",
      ),
    ).toBeNull();
    expect(within(card).getByText("Server: Design team")).toBeInTheDocument();
    expect(within(card).queryByText(/Limited context:/u)).toBeNull();
    expect(within(card).queryAllByText("Connected")).toHaveLength(
      connected ? 1 : 0,
    );
    const menu = queryAction("button", "More Discord options", card);
    expect(menu === null).toBe(actions.length === 0);
    if (menu) {
      click(menu);
    }
    for (const action of ["Disconnect Discord", "Remove Discord"]) {
      expect(queryAction("button", action) !== null).toBe(
        actions.includes(action),
      );
    }
  },
);

test("Saving a DM server stays pending until the refreshed choice arrives", async () => {
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
      },
      {
        connectionId: second,
        guildId: "345678901234567890",
        guildName: "Operations",
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
      name: "Default server for direct messages",
    }),
  );
  click(await screen.findByRole("option", { name: "Operations" }));

  await refreshStarted.promise;
  const pending = screen.getByRole("combobox", {
    name: "Default server for direct messages",
  });
  expect(pending).toBeDisabled();
  refreshReady.resolve();
  await waitFor(() => {
    const saved = screen.getByRole("combobox", {
      name: "Default server for direct messages",
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
  await expect(
    screen.findByText("Server: Design team"),
  ).resolves.toBeInTheDocument();
  click(
    getAction("button", "More Discord options", getIntegrationCard("Discord")),
  );
  click(getAction("button", "Disconnect Discord"));

  await refreshStarted.promise;
  expect(getAction("button", "Disconnect Discord")).toBeDisabled();
  refreshReady.resolve();
  await expect(
    screen.findByText(/Connect your Discord account/u),
  ).resolves.toBeInTheDocument();
  expect(
    within(getIntegrationCard("Discord")).queryByText("Connected"),
  ).toBeNull();
});
