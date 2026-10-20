import {
  teamsConnectContract,
  type TeamsConnectStatus,
} from "@okouai/api-contracts/contracts/teams-connect";
import { act, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getAction,
  getIntegrationCard,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
function status(
  overrides: Partial<TeamsConnectStatus> = {},
): TeamsConnectStatus {
  return {
    isInstalled: false,
    isConnected: false,
    isAdmin: true,
    pendingInstallation: false,
    linkedAccounts: [],
    connectUrl: "/api/teams/oauth/connect?orgId=org_default",
    installUrl: "https://teams.microsoft.com/l/app/app-id",
    ...overrides,
  };
}

test.each(["focus", "visibility", "realtime"])(
  "Works reconciles Teams through %s without leaving its prompt",
  async (trigger) => {
    let current = status();
    context.mocks.api(teamsConnectContract.getStatus, ({ respond }) => {
      return respond(200, current);
    });
    const visibility = context.mocks.browser.visibilityState("visible");
    const popup = context.mocks.browser.authWindow();
    const open = context.mocks.browser.open(popup);
    await setupPage({ context, path: "/works?prompt=Retain+my+work" });
    const card = getIntegrationCard("Microsoft Teams");
    expect(getAction("button", "Install in Teams", card)).toBeEnabled();
    click(getAction("button", "Install in Teams", card));
    const url = new URL(open.calls[0]?.url ?? "");
    expect(url.searchParams.get("prompt")).toBe("Retain my work");
    popup.close();
    expect(getAction("button", "Install in Teams", card)).toBeEnabled();
    await waitFor(() => {
      return expect(
        context.mocks.ably.hasSubscription("teams:changed"),
      ).toBeTruthy();
    });
    current = status({
      isInstalled: true,
      isConnected: true,
      teamName: "Verified team",
      connectUrl: null,
    });
    if (trigger === "focus") {
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
    } else if (trigger === "visibility") {
      act(() => {
        return visibility.changeTo("hidden");
      });
      act(() => {
        return visibility.changeTo("visible");
      });
    } else {
      act(() => {
        return context.mocks.ably.trigger("teams:changed");
      });
    }
    await expect(
      screen.findByText("Connected (Verified team)"),
    ).resolves.toBeInTheDocument();
    expect(window.location.pathname).toBe("/works");
    expect(new URLSearchParams(window.location.search).get("prompt")).toBe(
      "Retain my work",
    );
  },
);

test("Works sends prepared installations to the canonical page and does not mark them connected", async () => {
  context.mocks.api(teamsConnectContract.getStatus, ({ respond }) => {
    return respond(200, status({ pendingInstallation: true }));
  });
  const open = context.mocks.browser.open();
  await setupPage({ context, path: "/works" });
  const card = getIntegrationCard("Microsoft Teams");
  click(getAction("button", "Install in Teams", card));
  expect(new URL(open.calls[0]?.url ?? "").pathname).toBe("/settings/teams");
  expect(card).not.toHaveTextContent("Connected");
  expect(window.location.pathname).toBe("/works");
});

test("Returning to Works retries a failed Teams read without hiding the other integrations", async () => {
  let failed = true;
  context.mocks.api(teamsConnectContract.getStatus, ({ respond }) => {
    if (failed) {
      throw Response.error();
    }
    return respond(200, status());
  });
  await setupPage({ context, path: "/works" });
  const card = getIntegrationCard("Microsoft Teams");
  expect(card).toHaveTextContent("Unable to check your Teams connection.");
  expect(getIntegrationCard("Slack")).toBeInTheDocument();
  failed = false;
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await waitFor(() => {
    return expect(getAction("button", "Install in Teams", card)).toBeEnabled();
  });
});

test("Teams actions preserve prompt and protected preview access", async () => {
  context.mocks.api(teamsConnectContract.getStatus, ({ respond }) => {
    return respond(
      200,
      status({
        connectUrl:
          "https://pr-431-api.vm6.ai/api/teams/oauth/connect?orgId=org_default",
      }),
    );
  });
  const open = context.mocks.browser.open();
  await setupPage({
    context,
    host: "pr-431-app-okou-app-preview.vm0.workers.dev",
    path: "/works?prompt=Retain+my+work&x-vercel-protection-bypass=preview-secret",
  });
  click(
    getAction(
      "button",
      "Install in Teams",
      getIntegrationCard("Microsoft Teams"),
    ),
  );
  const url = new URL(open.calls[0]?.url ?? "");
  expect(url.origin).toBe("https://pr-431-api.vm6.ai");
  expect(url.searchParams.get("prompt")).toBe("Retain my work");
  expect(url.searchParams.get("x-vercel-protection-bypass")).toBe(
    "preview-secret",
  );
  expect(window.location.pathname).toBe("/works");
});

test("An overlapping focus refresh keeps later realtime notifications active", async () => {
  const started = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  let blockNext = false;
  let current = status();
  context.mocks.api(teamsConnectContract.getStatus, async ({ respond }) => {
    const snapshot = current;
    if (blockNext) {
      blockNext = false;
      started.resolve();
      await release.promise;
    }
    return respond(200, snapshot);
  });
  await setupPage({ context, path: "/works" });
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription("teams:changed")).toBeTruthy();
  });
  blockNext = true;
  act(() => {
    context.mocks.ably.trigger("teams:changed");
  });
  await started.promise;
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await waitFor(() => {
    expect(
      getAction(
        "button",
        "Install in Teams",
        getIntegrationCard("Microsoft Teams"),
      ),
    ).toBeEnabled();
  });
  release.resolve();
  current = status({
    isInstalled: true,
    isConnected: true,
    teamName: "Later installation",
  });
  act(() => {
    context.mocks.ably.trigger("teams:changed");
  });
  await waitFor(() => {
    expect(
      screen.getByText("Connected (Later installation)"),
    ).toBeInTheDocument();
  });
});
