import { initSentry } from "../../../lib/sentry.ts";
import { test, expect, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { click, setupPage, startPage } from "../../../__tests__/page-helper.ts";
import { queryBootstrapSkeleton } from "../../../test/bootstrap-skeleton.ts";
import {
  findAction,
  queryAction,
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
