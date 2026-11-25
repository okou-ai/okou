import { initSentry } from "../../../lib/sentry.ts";
import { test, expect, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { click, setupPage, startPage } from "../../../__tests__/page-helper.ts";
import { queryBootstrapSkeleton } from "../../../test/bootstrap-skeleton.ts";
import {
  findAction,
  queryAction,
  getIntegrationCard,
} from "./connector-integrations-test-helpers.ts";
import {
  authorizationService,
  authorizeUrl,
  browserPeer,
  consentFragment,
  consentOpener,
  consentState,
  harbor,
  statusService,
  watchApproval,
} from "./discord-consent-fixtures.ts";
import { logsByIdContract } from "@okouai/api-contracts/contracts/logs";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

const settings = "/settings/discord";
function visit(path: string) {
  return setupPage({ context, path, auth: harbor.auth });
}

test.each([
  ["discord-connect-page-001", "Join new server", "/install"],
  ["discord-connect-page-003", "Connect", ""],
] as const)(
  "%s authorizes the requested server and lands on its verified settings",
  async (_id, action, suffix) => {
    const install = suffix === "/install";
    const service = authorizationService(
      context,
      {
        guildId: harbor.guild,
        ...(install ? { flow: "install" as const } : {}),
      },
      install
        ? {
            isConnected: true,
            guildId: harbor.previousGuild,
            guildName: "Old workshop",
          }
        : {},
    );
    const tab = browserPeer(context);
    context.mocks.browser.open(tab);
    const delivered = vi.spyOn(tab, "postMessage");
    await visit(settings + suffix + "?guild_id=" + harbor.guild);
    click(await findAction("button", action));
    await service.checking.promise;
    expect(tab.location.href).toBe(authorizeUrl);
    context.mocks.browser.message(
      { type: "discord-oauth-ready", state: consentState },
      { source: tab, origin: location.origin },
    );
    service.approve();
    service.release.resolve();
    await expect(
      screen.findByText("Connected to Discord"),
    ).resolves.toBeInTheDocument();
    await expect(findAction("link", "Open Discord")).resolves.toHaveAttribute(
      "href",
      "discord://-/channels/" + harbor.guild,
    );
    await waitFor(() => {
      return expect(location.pathname).toBe(settings);
    });
    expect(new URL(location.href).searchParams.get("status")).toBe("connected");
    expect(new URL(location.href).searchParams.get("guild_id")).toBe(
      harbor.guild,
    );
    expect(delivered).toHaveBeenCalledWith(
      {
        type: "discord-oauth-result",
        state: consentState,
        status: "connected",
      },
      location.origin,
    );
    expect(tab.closed).toBeFalsy();
  },
);

test("discord-connect-page-005 the consent page discards the previous server on completion", async () => {
  let guild: string = harbor.previousGuild;
  statusService(context, () => {
    return {
      isConnected: true,
      guildId: guild,
      guildName: "Session guild",
    };
  });
  watchApproval(context);
  const finish = consentOpener(context);
  await visit(settings + "?status=pending" + consentFragment);
  expect(screen.getByText("Checking account status...")).toBeInTheDocument();
  guild = harbor.guild;
  finish("connected");
  await expect(findAction("link", "Open Discord")).resolves.toHaveAttribute(
    "href",
    "discord://-/channels/" + guild,
  );
  expect(screen.getByText("Connected to Discord")).toBeInTheDocument();
  expect(location.pathname).toBe(settings);
  expect(location.hash).toBe("");
});

test.each([
  ["discord-connect-page-010", "connected", "Connected to Discord", "error"],
  ["discord-connect-page-012", "error", "Connection failed", "connected"],
] as const)(
  "%s keeps the result received before the approval response",
  async (_id, first, title, later) => {
    statusService(context, () => {
      return {
        isConnected: true,
        guildId: harbor.guild,
      };
    });
    const gate = context.mocks.deferred<void>();
    const verifying = watchApproval(context, gate.promise);
    const finish = consentOpener(context);
    const page = await startPage({
      context,
      path: settings + "?status=pending" + consentFragment,
      auth: harbor.auth,
    });
    await verifying.promise;
    finish(first);
    await expect(screen.findByText(title)).resolves.toBeInTheDocument();
    gate.resolve();
    await page.ready;
    act(() => {
      finish(later);
    });
    expect(screen.getByText(title)).toBeInTheDocument();
    expect(new URL(location.href).searchParams.get("status")).toBe(first);
    expect(queryAction("button", "Connect")).toBeNull();
    expect(
      queryBootstrapSkeleton()?.getAttribute("aria-hidden") ?? "true",
    ).toBe("true");
  },
);

test("discord-connect-page-014 a connection claim cannot override the disconnected account", async () => {
  statusService(context, () => {
    return {};
  });
  await visit(settings + "?status=connected&workspace=Unverified+outpost");
  expect(screen.getByText("Connect to Discord")).toBeInTheDocument();
  await expect(findAction("button", "Connect")).resolves.toBeEnabled();
  expect(queryAction("link", "Open Discord")).toBeNull();
  expect(screen.queryByText(/Unverified outpost/u)).toBeNull();
});

test("discord-connect-page-015 the success action uses the verified guild instead of the URL label", async () => {
  statusService(context, () => {
    return { isConnected: true, guildId: harbor.guild };
  });
  await visit(settings + "?status=connected&workspace=Unverified+outpost");
  expect(screen.getByText("Connected to Discord")).toBeInTheDocument();
  await expect(findAction("link", "Open Discord")).resolves.toHaveAttribute(
    "href",
    "discord://-/channels/" + harbor.guild,
  );
  expect(screen.queryByText(/Unverified outpost/u)).toBeNull();
});

test("discord-connect-page-016 a blocked popup leaves an actionable error on Discord settings", async () => {
  statusService(context, () => {
    return {};
  });
  context.mocks.browser.open(null);
  await visit(settings);
  click(await findAction("button", "Connect"));
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "The Discord authorization popup was blocked.",
  );
  expect(queryAction("link", "Open Discord")).toBeNull();
});

test("discord-connect-page-019 verification failure survives the consent window closing", async () => {
  const sentry = context.mocks.sentry();
  initSentry();
  const tab = browserPeer(context);
  context.mocks.browser.open(tab);
  const service = authorizationService(context, {});
  await visit(settings);
  click(await findAction("button", "Connect"));
  await service.checking.promise;
  tab.close();
  service.fail("forbidden");
  service.release.resolve();
  await expect(
    screen.findByText("Discord authorization could not be completed."),
  ).resolves.toBeInTheDocument();
  await expect(
    screen.findByText("Harbor could not verify this identity"),
  ).resolves.toBeInTheDocument();
  expect(queryAction("link", "Open Discord")).toBeNull();
  expect(screen.queryByText("Connected to Discord")).toBeNull();
  await waitFor(() => {
    return expect(sentry.reports).toContainEqual(
      expect.objectContaining({
        type: "exception",
        error: expect.objectContaining({
          message: "Harbor could not verify this identity",
          expected: false,
          code: "FORBIDDEN",
          status: 403,
        }),
      }),
    );
  });
});

test.each([
  ["discord-connect-page-022", false],
  ["discord-connect-page-024", true],
] as const)(
  "%s offers Connect after loading available Discord settings",
  async (_id, hinted) => {
    statusService(context, () => {
      return {
        guildId: hinted ? harbor.previousGuild : null,
        isAdmin: false,
      };
    });
    await visit(settings + (hinted ? "?guild_id=" + harbor.guild : ""));
    await expect(findAction("button", "Connect")).resolves.toBeEnabled();
  },
);

test("discord-connect-page-023 a forbidden status exposes the Works recovery link", async () => {
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(403, {
      error: { code: "FORBIDDEN", message: "Workspace membership expired" },
    });
  });
  const page = await startPage({ context, path: settings, auth: harbor.auth });
  await page.content;
  await expect(
    screen.findByText("Connection failed"),
  ).resolves.toBeInTheDocument();
  await expect(findAction("link", "Back to settings")).resolves.toHaveAttribute(
    "href",
    "/works",
  );
  expect(queryAction("button", "Connect")).toBeNull();
});

test("discord-connect-page-025 a malformed server link asks the user to return to Discord", async () => {
  statusService(context, () => {
    return {};
  });
  await visit(settings + "?guild_id=broken-link");
  await expect(
    screen.findByText(
      "This Discord connection link is invalid. Open a new link from Discord.",
    ),
  ).resolves.toBeInTheDocument();
  expect(queryAction("button", "Connect")).toBeNull();
});

test("discord-oauth-compatibility-001 approving and closing consent connects the original Works card", async () => {
  const tab = browserPeer(context);
  context.mocks.browser.open(tab);
  const service = authorizationService(context, {});
  service.release.resolve();
  await setupPage({ context, path: "/works", auth: harbor.auth });
  const card = getIntegrationCard("Discord");
  click(await findAction("button", "Connect", card));
  await service.pending.promise;
  expect(tab.location.href).toBe(authorizeUrl);
  service.approve();
  tab.close();
  await waitFor(() => {
    return expect(card).toHaveTextContent(/\bConnected\b/u);
  });
  expect(location.pathname).toBe("/works");
  expect(tab.closed).toBeTruthy();
  expect(tab.location.href).toBe(authorizeUrl);
});

test("discord-oauth-compatibility-002 a ready consent tab receives the matching result once after Works connects", async () => {
  const tab = browserPeer(context);
  context.mocks.browser.open(tab);
  const delivery = vi.spyOn(tab, "postMessage");
  const service = authorizationService(context, {});
  service.release.resolve();
  await setupPage({ context, path: "/works", auth: harbor.auth });
  const card = getIntegrationCard("Discord");
  click(await findAction("button", "Connect", card));
  await service.pending.promise;
  expect(tab.location.href).toBe(authorizeUrl);
  service.approve();
  await waitFor(() => {
    return expect(card).toHaveTextContent(/\bConnected\b/u);
  });
  const ready = { type: "discord-oauth-ready", state: consentState };
  context.mocks.browser.message(ready, {
    origin: location.origin,
    source: tab,
  });
  context.mocks.browser.message(ready, {
    origin: location.origin,
    source: tab,
  });
  expect(delivery.mock.calls).toStrictEqual([
    [
      {
        type: "discord-oauth-result",
        state: consentState,
        status: "connected",
      },
      location.origin,
    ],
  ]);
  expect(tab.location.href).toBe(authorizeUrl);
  expect(location.pathname).toBe("/works");
});

test.each([
  ["discord-oauth-compatibility-003", "/works"],
  ["discord-oauth-compatibility-004", "/settings/discord"],
] as const)(
  "%s recovers a pending response delivered after consent closes",
  async (_id, path) => {
    const telemetry = context.mocks.sentry();
    initSentry();
    const service = authorizationService(context, {});
    const tab = browserPeer(context);
    context.mocks.browser.open(tab);
    await setupPage({ context, path, auth: harbor.auth });
    const surface =
      path === "/works" ? getIntegrationCard("Discord") : document.body;
    click(await findAction("button", "Connect", surface));
    await service.checking.promise;
    expect(tab.location.href).toBe(authorizeUrl);
    service.approve();
    tab.close();
    service.release.resolve();
    const confirmation =
      path === "/works" ? /^Connected\b/u : "Connected to Discord";
    await expect(
      within(surface).findByText(confirmation),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      return expect(new URL(location.href).searchParams.get("status")).toBe(
        path === "/works" ? null : "connected",
      );
    });
    expect(location.pathname).toBe(path);
    expect(tab.closed).toBeTruthy();
    expect(
      screen.queryByText("Discord authorization was cancelled."),
    ).toBeNull();
    expect(telemetry.reports).toStrictEqual([]);
  },
);

test("discord-oauth-compatibility-005 a callback without an opener discards the proof without redeeming it", async () => {
  vi.stubGlobal("opener", null);
  const approval = watchApproval(context);
  statusService(context, () => {
    return {};
  });
  await setupPage({
    context,
    auth: harbor.auth,
    path: "/settings/discord?status=pending" + consentFragment,
  });
  expect(
    screen.getByText("This authorization was interrupted or refreshed."),
  ).toBeInTheDocument();
  expect(location.hash).toBe("");
  expect(queryAction("link", "Open Discord")).toBeNull();
  expect(approval.settled()).toBeFalsy();
});

test("discord-oauth-compatibility-008 the first matching completion settles the consent page", async () => {
  statusService(context, () => {
    return { isConnected: true, guildId: harbor.guild };
  });
  const receipt = watchApproval(context);
  const finish = consentOpener(context);
  await setupPage({
    context,
    path: "/settings/discord?status=pending" + consentFragment,
    auth: harbor.auth,
  });
  await receipt.promise;
  finish("connected");
  finish("error");
  await expect(
    screen.findByText("Connected to Discord"),
  ).resolves.toBeInTheDocument();
  expect(new URL(location.href).searchParams.get("status")).toBe("connected");
});

test("discord-oauth-compatibility-014 leaving a failed installation closes the original consent popup", async () => {
  const tab = browserPeer(context);
  context.mocks.browser.open(tab);
  const service = authorizationService(
    context,
    { guildId: harbor.guild, flow: "install" },
    { isConnected: true, guildId: harbor.previousGuild },
  );
  await setupPage({
    context,
    path: "/settings/discord/install?guild_id=" + harbor.guild,
    auth: harbor.auth,
  });
  click(await findAction("button", "Join new server"));
  await service.checking.promise;
  service.approve();
  service.fail("conflict");
  service.release.resolve();
  await expect(
    screen.findByText("Disconnect the existing Discord identity first"),
  ).resolves.toBeInTheDocument();
  expect(queryAction("link", "Open Discord")).toBeNull();
  expect(tab.closed).toBeFalsy();
  expect(tab.location.href).toBe(authorizeUrl);
  click(await findAction("link", "Back to settings"));
  await screen.findByText("Microsoft Teams");
  expect(location.pathname).toBe("/works");
  expect(tab.closed).toBeTruthy();
});

test("discord-oauth-compatibility-007 Losing the original Discord window after approval leaves the cleaned consent page interrupted", async () => {
  const origin = browserPeer(context);
  vi.stubGlobal("opener", origin);
  const finish = context.mocks.deferred<void>();
  const accepted = watchApproval(context, finish.promise);
  statusService(context, () => {
    return {};
  });
  const opening = await startPage({
    context,
    auth: harbor.auth,
    path: "/settings/discord?status=pending" + consentFragment,
  });
  await accepted.promise;
  expect(location.hash).toBe("");
  origin.close();
  finish.resolve();
  await opening.ready;
  await expect(
    screen.findByText("This authorization was interrupted or refreshed."),
  ).resolves.toBeVisible();
  expect(queryAction("link", "Open Discord")).toBeNull();
});

test("discord-source-presentation-001 message sources distinguish a guild, a direct message and an unlinked origin", async () => {
  const threadId = crypto.randomUUID();
  const sources = [
    ["Quay meeting", "https://discord.com/channels/937615/862473/606147"],
    ["Private note", "https://discord.com/channels/@me/778911/337685"],
    ["Offline relay", null],
  ] as const;
  mockChatLifecycle(context, {
    threadId,
    chatEvents: sources.map(([text, href], index) => {
      return {
        role: "user",
        content: text,
        createdAt: new Date(Date.UTC(2026, 3, 10, 12, index)).toISOString(),
        userMessage: {
          version: 1,
          parts: [
            { type: "source", kind: "discord", ...(href ? { href } : {}) },
            { type: "text", text },
          ],
        },
      };
    }),
  });
  await setupPage({ context, path: "/chat/" + threadId });
  await screen.findByText("Offline relay");
  const sourceLink = (text: string) => {
    const message = screen
      .getByText(text)
      .closest<HTMLElement>("[data-chat-scroll-anchor-event-id]");
    if (!message) {
      throw new Error("Missing message row for " + text);
    }
    return within(message).getByText("Discord", { exact: true }).closest("a");
  };
  expect(sourceLink("Offline relay")).toBeNull();
  for (const [text, href] of [sources[0], sources[1]]) {
    const link = sourceLink(text);
    expect(link).toHaveAttribute("href", href);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  }
});

test("A completed activity identifies Discord as its trigger", async () => {
  const id = crypto.randomUUID();
  context.mocks.api(logsByIdContract.getById, ({ params, respond }) => {
    return respond(200, {
      id: params.id,
      sessionId: "harbor-session",
      framework: "claude-code",
      modelProvider: null,
      selectedModel: null,
      triggerSource: "discord",
      status: "completed",
      prompt: "Summarize the tide gauge",
      appendSystemPrompt: null,
      createdAt: "2026-04-10T12:00:00Z",
      startedAt: "2026-04-10T12:00:01Z",
      completedAt: "2026-04-10T12:00:30Z",
    });
  });
  await setupPage({ context, path: "/activities/" + id });
  const source = await screen.findByText("Source");
  expect(screen.getByRole("heading", { name: "Okou" })).toBeVisible();
  expect(source.parentElement).toHaveTextContent("Discord");
});
