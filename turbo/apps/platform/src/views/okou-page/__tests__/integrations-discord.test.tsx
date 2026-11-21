import { expect, test, vi } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { discordOauthContract } from "@okouai/api-contracts/contracts/discord-oauth";
import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { click, setupPage, startPage } from "../../../__tests__/page-helper.ts";
import { initSentry } from "../../../lib/sentry.ts";
import { bootstrapSkeleton } from "../../../test/bootstrap-skeleton.ts";
import {
  getIntegrationCard,
  findAction,
  queryAction,
  mockSlack,
} from "./connector-integrations-test-helpers.ts";
import {
  authorizationService,
  authorizeUrl,
  browserPeer,
  harbor,
  consentOpener,
  consentFragment,
  consentState,
  statusService,
  watchApproval,
} from "./discord-consent-fixtures.ts";
const context = testContext();
const description =
  "Mention Okou in a server or send the bot a direct message.";
function visit(path = "/works") {
  return setupPage({ context, path, auth: harbor.auth });
}
function card() {
  return getIntegrationCard("Discord");
}
function findDiscordButton(name: string) {
  return findAction("button", name, card());
}
function queryDiscordButton(name: string) {
  return queryAction("button", name, card());
}
function notifyStatusChanged() {
  context.mocks.ably.trigger("discord:changed");
}

test("integrations-discord-002 offers the first administrator a connection on Works", async () => {
  statusService(context, () => {
    return { isAdmin: true };
  });
  await visit();
  expect(within(card()).getByText(description)).toBeInTheDocument();
  await expect(findDiscordButton("Connect")).resolves.toBeEnabled();
  expect(queryDiscordButton("More options")).toBeNull();
});

test.each([
  ["integrations-discord-005", true],
  ["integrations-discord-006", false],
] as const)(
  "%s completes authorization in Works for the current role",
  async (_id, isAdmin) => {
    const user = isAdmin
      ? { id: "harbor-admin", fullName: "Morgan" }
      : { id: "harbor-member", fullName: "Lee" };
    const session = { token: "session-" + user.id };
    const remote = authorizationService(
      context,
      {},
      { isAdmin },
      session.token,
    );
    const popup = browserPeer(context);
    context.mocks.browser.open(popup);
    const reply = vi.spyOn(popup, "postMessage");
    remote.release.resolve();
    await setupPage({
      context,
      path: "/works",
      auth: { ...harbor.auth, user, session },
    });
    click(await findDiscordButton("Connect"));
    await remote.pending.promise;
    context.mocks.browser.message(
      { type: "discord-oauth-ready", state: consentState },
      { source: popup, origin: location.origin },
    );
    remote.approve();
    await expect(findDiscordButton("More options")).resolves.toBeEnabled();
    expect(card()).toHaveTextContent(/\bConnected\b/u);
    expect(location.pathname + location.search).toBe("/works");
    expect(popup.closed).toBeFalsy();
    expect(popup.location.href).toBe(authorizeUrl);
    expect(reply).toHaveBeenCalledWith(
      {
        type: "discord-oauth-result",
        state: consentState,
        status: "connected",
      },
      location.origin,
    );
  },
);

test("integrations-discord-010 closes the new tab and allows a retry when authorization is unavailable", async () => {
  statusService(context, () => {
    return {};
  });
  const tab = browserPeer(context);
  context.mocks.browser.open(tab);
  context.mocks.api(discordOauthContract.start, ({ respond }) => {
    return respond(503, {
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Discord OAuth is not configured",
      },
    });
  });
  await visit();
  click(await findDiscordButton("Connect"));
  await screen.findByText("Discord OAuth is not configured");
  expect(tab.closed).toBeTruthy();
  await expect(findDiscordButton("Connect")).resolves.toBeEnabled();
  expect(within(card()).queryByText("Connected")).toBeNull();
});

test("integrations-discord-013 leaving a waiting authorization closes consent and restores setup on return", async () => {
  const remote = authorizationService(context, {});
  const tab = browserPeer(context);
  context.mocks.browser.open(tab);
  remote.release.resolve();
  await visit();
  click(await findDiscordButton("Connect"));
  await remote.pending.promise;
  click(await screen.findByText("New chat"));
  await waitFor(() => {
    return expect(tab.closed).toBeTruthy();
  });
  expect(location.pathname).toBe("/");
  history.back();
  await screen.findByText(description);
  await expect(findDiscordButton("Connect")).resolves.toBeEnabled();
  expect(within(card()).queryByText("Connected")).toBeNull();
});

test("integrations-discord-017 reports an interrupted pending return on Discord settings", async () => {
  statusService(context, () => {
    return {};
  });
  const completed = context.mocks.deferred<void>();
  context.mocks.api(discordOauthContract.complete, ({ respond }) => {
    completed.resolve();
    return respond(200, { status: "connected" });
  });
  await visit("/works?discord=pending&discord_error=harbor-private-diagnostic");
  await screen.findByText("Connection failed");
  expect(location.pathname + location.search).toBe(
    "/settings/discord?status=pending",
  );
  expect(queryAction("button", "Connect")).toBeNull();
  expect(queryAction("link", "Open Discord")).toBeNull();
  expect(
    screen.queryByText("Discord authorization could not be completed."),
  ).toBeNull();
  expect(screen.queryByText(/harbor-private-diagnostic/u)).toBeNull();
  expect(completed.settled()).toBeFalsy();
});

test("integrations-discord-019 the consent page stays open after approving and waits for completion", async () => {
  const close = vi.spyOn(window, "close");
  statusService(context, () => {
    return {};
  });
  consentOpener(context);
  const signed = watchApproval(context);
  await visit("/works?discord=pending" + consentFragment);
  await signed.promise;
  await screen.findByText("Checking account status...");
  expect(location.hash).toBe("");
  expect(location.pathname).toBe("/settings/discord");
  expect(close).not.toHaveBeenCalled();
  expect(queryAction("link", "Open Discord")).toBeNull();
});

test("integrations-discord-021 incomplete consent is discarded on entry", async () => {
  statusService(context, () => {
    return {};
  });
  consentOpener(context);
  const submission = context.mocks.deferred<void>();
  context.mocks.api(discordOauthContract.approve, ({ respond }) => {
    submission.resolve();
    return respond(200, { approved: true });
  });
  await visit(
    "/settings/discord?status=pending#discord_oauth=approve&state=" +
      consentState +
      "&approval_proof=",
  );
  await screen.findByText("This authorization was interrupted or refreshed.");
  expect(location.hash).toBe("");
  expect(queryAction("link", "Open Discord")).toBeNull();
  expect(submission.settled()).toBeFalsy();
});

test("integrations-discord-023 rejected consent identifies the original account as the recovery path", async () => {
  const close = vi.spyOn(window, "close");
  consentOpener(context);
  statusService(context, () => {
    return {};
  });
  context.mocks.api(
    discordOauthContract.approve,
    ({ request, body, respond }) => {
      expect(request.headers.get("authorization")).toBe(
        "Bearer harbor-session",
      );
      expect(body.state).toBe(consentState);
      expect(body.approvalProof).toBe(
        new URLSearchParams(consentFragment.slice(1)).get("approval_proof"),
      );
      return respond(403, {
        error: {
          code: "FORBIDDEN",
          message: "Consent belongs to another owner",
        },
      });
    },
  );
  const page = await startPage({
    context,
    path: "/settings/discord?status=pending" + consentFragment,
    auth: harbor.auth,
  });
  await page.content;
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Connection failed");
  expect(alert).toHaveTextContent(
    "Sign in with the original Okou account and organization, or restart authorization.",
  );
  expect(screen.queryByText("Connected to Discord")).toBeNull();
  expect(queryAction("link", "Open Discord")).toBeNull();
  expect(close).not.toHaveBeenCalled();
});

test("integrations-discord-029 Works delivers the verification failure to the ready authorization tab", async () => {
  const telemetry = context.mocks.sentry();
  initSentry();
  const remote = authorizationService(context, {});
  const tab = browserPeer(context);
  context.mocks.browser.open(tab);
  const reply = vi.spyOn(tab, "postMessage");
  await visit();
  click(await findDiscordButton("Connect"));
  await remote.checking.promise;
  remote.fail("forbidden", "Discord could not complete authorization.");
  remote.release.resolve();
  await screen.findByText("Discord could not complete authorization.");
  context.mocks.browser.message(
    { type: "discord-oauth-ready", state: consentState },
    { source: tab, origin: location.origin },
  );
  expect(reply.mock.calls).toStrictEqual([
    [
      { type: "discord-oauth-result", state: consentState, status: "error" },
      location.origin,
    ],
  ]);
  expect(tab.closed).toBeFalsy();
  await expect(findDiscordButton("Connect")).resolves.toBeEnabled();
  expect(within(card()).queryByText("Connected")).toBeNull();
  await waitFor(() => {
    return expect(telemetry.reports).toContainEqual(
      expect.objectContaining({
        type: "exception",
        error: expect.objectContaining({
          status: 403,
          code: "FORBIDDEN",
          expected: false,
          message: "Discord could not complete authorization.",
        }),
      }),
    );
  });
});

test("integrations-discord-033 keyboard users can dismiss and reopen the connected account options", async () => {
  statusService(context, () => {
    return {
      isConnected: true,
      isAdmin: true,
      guildId: harbor.guild,
    };
  });
  await visit();
  const keys = userEvent.setup();
  const trigger = await findDiscordButton("More options");
  trigger.focus();
  await keys.keyboard("{Enter}");
  await expect(findAction("button", "Join new server")).resolves.toBeEnabled();
  await expect(
    findAction("button", "Disconnect Discord"),
  ).resolves.toBeEnabled();
  expect(queryAction("button", "Uninstall")).toBeNull();
  await keys.keyboard("{Escape}");
  await waitFor(() => {
    return expect(trigger).toHaveFocus();
  });
  expect(queryAction("button", "Join new server")).toBeNull();
  await keys.keyboard("{Enter}");
  await expect(
    findAction("button", "Disconnect Discord"),
  ).resolves.toBeEnabled();
});

test("integrations-discord-036 Works follows both changes to a server connection", async () => {
  let connected = false;
  statusService(context, () => {
    return {
      isAdmin: true,
      isConnected: connected,
      guildName: connected ? "Updated team" : null,
    };
  });
  await visit();
  await expect(findDiscordButton("Connect")).resolves.toBeEnabled();
  connected = true;
  notifyStatusChanged();
  await within(card()).findByText(/^Connected/u);
  connected = false;
  notifyStatusChanged();
  await expect(findDiscordButton("Connect")).resolves.toBeEnabled();
  expect(queryDiscordButton("More options")).toBeNull();
});

test("integrations-discord-044 keeps disconnection available for a suspended administrator", async () => {
  statusService(context, () => {
    return {
      isAvailable: false,
      isConnected: true,
      isAdmin: true,
      guildId: harbor.guild,
      guildName: "Harbor workshop",
      contextMode: "unavailable",
    };
  });
  await visit();
  expect(
    within(card()).getByText(
      "Discord is temporarily unavailable. Existing connections are kept.",
    ),
  ).toBeInTheDocument();
  expect(card()).toHaveTextContent(/\bConnected\b/u);
  expect(queryDiscordButton("Disconnect Discord")).toBeNull();
  click(await findDiscordButton("More options"));
  await expect(
    findAction("button", "Disconnect Discord"),
  ).resolves.toBeEnabled();
  expect(queryAction("button", "Join new server")).toBeNull();
  expect(queryDiscordButton("Disconnect Discord")).toBeNull();
});
test("integrations-discord-046 explains an unavailable integration to a disconnected member", async () => {
  statusService(context, () => {
    return {
      isAvailable: false,
      guildId: harbor.guild,
      guildName: "Harbor workshop",
      contextMode: "unavailable",
    };
  });
  await visit();
  expect(
    within(card()).getByText(
      "Discord is not configured for this organization yet.",
    ),
  ).toBeInTheDocument();
  expect(within(card()).queryByText("Connected")).toBeNull();
  for (const name of [
    "More options",
    "Disconnect Discord",
    "Join new server",
  ]) {
    expect(queryDiscordButton(name)).toBeNull();
  }
});
test.each([
  ["integrations-discord-007", "app.okou.ai", "https://api.okou.ai"],
  [
    "integrations-discord-008",
    "pr-37968-app.omby.ai",
    "https://pr-37968-api.vm6.ai",
  ],
  [
    "integrations-discord-009",
    "pr-37968-app-okou-app-preview.vm0.workers.dev",
    "https://pr-37968-api.vm6.ai",
  ],
] as const)(
  "%s sends OAuth to the canonical service and delivers its provider URL intact",
  async (_id, host, api) => {
    let connected = false;
    statusService(context, () => {
      return { isConnected: connected };
    });
    const token = "x".repeat(43);
    const tab = browserPeer(context);
    context.mocks.browser.open(tab);
    const result = vi.spyOn(tab, "postMessage");
    const start = context.mocks.deferred<URL>();
    const complete = context.mocks.deferred<URL>();
    const consent = context.mocks.deferred<void>();
    context.mocks.api(discordOauthContract.start, ({ request, respond }) => {
      const actual = new URL(request.url);
      start.resolve(actual);
      const provider = new URL("https://discord.com/oauth2/authorize");
      provider.searchParams.set("state", consentState);
      provider.searchParams.set(
        "redirect_uri",
        new URL(discordOauthContract.callback.path, actual).href,
      );
      return respond(200, {
        authorizationUrl: provider.href,
        completionToken: token,
      });
    });
    context.mocks.api(
      discordOauthContract.complete,
      async ({ request, body, respond }) => {
        complete.resolve(new URL(request.url));
        await consent.promise;
        if (body.completionToken !== token || body.state !== consentState) {
          return respond(403, {
            error: { code: "FORBIDDEN", message: "Wrong attempt" },
          });
        }
        connected = true;
        return respond(200, { status: "connected" });
      },
    );
    await setupPage({ context, path: "/works", auth: harbor.auth, host });
    click(await findDiscordButton("Connect"));
    const checking = await complete.promise;
    const started = await start.promise;
    const authorization = new URL(tab.location.href);
    context.mocks.browser.message(
      { type: "discord-oauth-ready", state: consentState },
      { source: tab, origin: "https://" + host },
    );
    consent.resolve();
    await within(card()).findByText(/^Connected/u);
    expect(started.href).toBe(api + discordOauthContract.start.path);
    expect(checking.href).toBe(api + discordOauthContract.complete.path);
    expect(authorization.origin).toBe("https://discord.com");
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      api + discordOauthContract.callback.path,
    );
    expect(result).toHaveBeenCalledWith(
      {
        type: "discord-oauth-result",
        state: consentState,
        status: "connected",
      },
      "https://" + host,
    );
    expect(tab.closed).toBeFalsy();
  },
);

test("integrations-discord-024 leaving verification aborts the approval and ignores messages on Works", async () => {
  const close = vi.spyOn(window, "close");
  const finish = consentOpener(context);
  statusService(context, () => {
    return {};
  });
  const started = context.mocks.deferred<void>();
  const aborted = context.mocks.deferred<void>();
  const replayed = context.mocks.deferred<string>();
  const expectedProof = new URLSearchParams(consentFragment.slice(1)).get(
    "approval_proof",
  );
  context.mocks.api(
    discordOauthContract.approve,
    async ({ request, body, respond }) => {
      if (
        body.approvalProof !== expectedProof ||
        body.state !== consentState ||
        request.headers.get("authorization") !== "Bearer harbor-session"
      ) {
        return respond(403, {
          error: {
            code: "FORBIDDEN",
            message: "Invalid consent owner or proof",
          },
        });
      }
      if (aborted.settled()) {
        replayed.resolve(body.approvalProof);
        return respond(409, {
          error: { code: "CONFLICT", message: "Consent already cancelled" },
        });
      }
      if (!started.settled()) {
        started.resolve();
      }
      request.signal.addEventListener(
        "abort",
        () => {
          return aborted.resolve();
        },
        {
          once: true,
        },
      );
      await aborted.promise;
      return respond(200, { approved: true });
    },
  );
  const page = await startPage({
    context,
    path: "/settings/discord?status=pending" + consentFragment,
    auth: harbor.auth,
  });
  await started.promise;
  click(await findAction("link", "Back to settings"));
  await aborted.promise;
  await screen.findByText(description);
  finish("connected");
  finish("error");
  await expect(findDiscordButton("Connect")).resolves.toBeEnabled();
  expect(location.pathname).toBe("/works");
  expect(location.hash).toBe("");
  expect(close).not.toHaveBeenCalled();
  await page.ready;
  expect(replayed.settled()).toBeFalsy();
});

test("integrations-discord-048 disconnect remains busy until the new account status arrives", async () => {
  let disconnected = false;
  const refresh = context.mocks.deferred<void>();
  const requested = context.mocks.deferred<void>();
  statusService(context, async () => {
    if (disconnected) {
      requested.resolve();
      await refresh.promise;
    }
    return { isConnected: !disconnected };
  });
  context.mocks.api(integrationsDiscordContract.disconnect, ({ respond }) => {
    disconnected = true;
    return respond(200, { ok: true });
  });
  await visit();
  click(await findDiscordButton("More options"));
  const action = await findAction("button", "Disconnect Discord");
  click(action);
  await requested.promise;
  expect(action).toBeDisabled();
  expect(action).toHaveTextContent("Disconnecting…");
  refresh.resolve();
  await expect(findDiscordButton("Connect")).resolves.toBeEnabled();
  expect(within(card()).queryByText("Connected")).toBeNull();
});

test("integrations-discord-039 the Works root becomes interactive only after Discord is ready", async () => {
  const release = context.mocks.deferred<void>();
  statusService(context, async () => {
    await release.promise;
    return {};
  });
  mockSlack(context, {
    isInstalled: true,
    isConnected: true,
    workspaceName: "Okou HQ",
  });
  const page = await startPage({ context, path: "/works", auth: harbor.auth });
  await screen.findByText(/Okou HQ/u);
  expect(within(card()).getByText(description)).toBeInTheDocument();
  expect(bootstrapSkeleton()).not.toHaveAttribute("aria-hidden", "true");
  expect(document.getElementById("root")).toHaveAttribute("inert");
  expect(card().querySelector("button")).toBeNull();
  release.resolve();
  await page.ready;
  expect(bootstrapSkeleton()).toHaveAttribute("aria-hidden", "true");
  expect(document.getElementById("root")).not.toHaveAttribute("inert");
});
