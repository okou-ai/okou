import {
  teamsConnectContract,
  type TeamsConnectStatus,
} from "@okouai/api-contracts/contracts/teams-connect";
import { act, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage, startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { getAction } from "./connector-integrations-test-helpers.ts";

const context = testContext();
const account = {
  tenantId: "tenant-acme",
  teamsUserId: "teams-user-42",
  teamsAadObjectId: "aad-42",
  displayName: "Verified Avery",
  userPrincipalName: "avery@acme.example",
} as const;
const target = {
  tenantId: account.tenantId,
  teamsUserId: account.teamsUserId,
  teamsAadObjectId: account.teamsAadObjectId,
  orgId: "org_default",
} as const;
function status(
  overrides: Partial<TeamsConnectStatus> = {},
): TeamsConnectStatus {
  return {
    isInstalled: true,
    isConnected: false,
    isAdmin: true,
    connectUrl: "/api/teams/oauth/connect?orgId=org_default",
    installUrl: null,
    tenantId: "tenant-acme",
    tenantName: "Acme Tenant",
    teamId: null,
    teamName: null,
    botName: "Verified Assistant",
    pendingInstallation: false,
    linkedAccounts: [],
    ...overrides,
  };
}
function path(params: Record<string, string> = {}) {
  return `/settings/teams?${new URLSearchParams(params)}`;
}
function mockStatus(initial: TeamsConnectStatus) {
  let current = initial;
  context.mocks.api(teamsConnectContract.getStatus, ({ respond }) => {
    return respond(200, current);
  });
  return (next: TeamsConnectStatus) => {
    current = next;
  };
}
async function expectConnected() {
  await expect(
    screen.findByRole("heading", { name: "Connected to Microsoft Teams" }),
  ).resolves.toBeInTheDocument();
}

test.each(["bare", "connected", "error"])(
  "Every %s entry reads actual status",
  async (entry) => {
    const open = context.mocks.browser.open();
    mockStatus(status({ isConnected: true, linkedAccounts: [account] }));
    await setupPage({
      context,
      path: path({
        ...target,
        status: entry,
        ...(entry === "error"
          ? { error: "Microsoft declined this attempt" }
          : {}),
        teamName: "Forged team",
        botName: "Forged bot",
      }),
    });
    await expectConnected();
    expect(
      screen.getByText("Your Teams account is connected."),
    ).toBeInTheDocument();
    expect(
      screen.queryAllByText("Microsoft declined this attempt"),
    ).toHaveLength(entry === "error" ? 1 : 0);
    expect(screen.queryByText(/Forged/u)).not.toBeInTheDocument();
    expect(open.calls).toStrictEqual([]);
    expect(getAction("link", "Open Teams")).toHaveAttribute("target", "_blank");
    expect(getAction("link", "Open Teams")).toHaveAttribute(
      "href",
      "https://teams.microsoft.com/",
    );
  },
);

test("A forged success marker cannot connect an account or launch Teams", async () => {
  const open = context.mocks.browser.open();
  mockStatus(status());
  await setupPage({ context, path: path({ ...target, status: "connected" }) });
  expect(
    screen.getByRole("heading", { name: "Connect Microsoft Teams" }),
  ).toBeInTheDocument();
  expect(getAction("button", "Authorize Microsoft Teams")).toBeEnabled();
  expect(open.calls).toStrictEqual([]);
});

test.each([
  {
    label: "another Teams user",
    overrides: {},
    query: { ...target, teamsUserId: "other" },
    message: /does not match/u,
  },
  {
    label: "contradictory AAD pair",
    overrides: {},
    query: { ...target, teamsAadObjectId: "aad-other" },
    message: /does not match/u,
  },
  {
    label: "another tenant",
    overrides: {},
    query: { ...target, tenantId: "tenant-other" },
    message: /does not match/u,
  },
])(
  "A connected boolean cannot certify $label",
  async ({ overrides, query, message }) => {
    mockStatus(
      status({ isConnected: true, linkedAccounts: [account], ...overrides }),
    );
    await setupPage({ context, path: path({ ...query, status: "connected" }) });
    expect(
      screen.getByRole("heading", { name: "Connect Microsoft Teams" }),
    ).toBeInTheDocument();
    expect(screen.getByText(message)).toBeInTheDocument();
  },
);

test("Bare setup opts in without treating a blocked window as connection or cancellation", async () => {
  mockStatus(status({ isInstalled: false, tenantId: null, teamId: null }));
  const open = context.mocks.browser.open();
  await setupPage({ context, path: "/settings/teams?prompt=Keep+my+draft" });
  expect(
    screen.getByRole("heading", { name: "Connect Microsoft Teams" }),
  ).toBeInTheDocument();
  click(getAction("button", "Authorize Microsoft Teams"));
  const opened = new URL(open.calls[0]?.url ?? "");
  expect(opened.searchParams.get("prompt")).toBe("Keep my draft");
  expect(window.location.pathname).toBe("/settings/teams");
  expect(
    screen.getByRole("heading", { name: "Connect Microsoft Teams" }),
  ).toBeInTheDocument();
  expect(getAction("button", "Authorize Microsoft Teams")).toBeEnabled();
});

test("Prepared installation stays pending and reconciles on visibility return", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const setStatus = mockStatus(
    status({
      isInstalled: false,
      isConnected: false,
      pendingInstallation: true,
      tenantId: null,
      teamId: null,
      linkedAccounts: [account],
      installUrl:
        "https://teams.microsoft.com/l/app/app-id?tenantId=tenant-acme",
    }),
  );
  const open = context.mocks.browser.open();
  await setupPage({
    context,
    path: path({ tenantId: "tenant-acme", status: "pending" }),
  });
  expect(
    screen.getByRole("heading", { name: "Install in Teams to finish" }),
  ).toBeInTheDocument();
  expect(getAction("link", "Install in Teams")).toHaveAttribute(
    "target",
    "_blank",
  );
  expect(getAction("link", "Install in Teams")).toHaveAttribute(
    "href",
    "https://teams.microsoft.com/l/app/app-id?tenantId=tenant-acme",
  );
  expect(open.calls).toStrictEqual([]);
  act(() => {
    return visibility.changeTo("hidden");
  });
  setStatus(status({ isConnected: true, linkedAccounts: [account] }));
  act(() => {
    return visibility.changeTo("visible");
  });
  await expectConnected();
  expect(window.location.pathname).toBe("/settings/teams");
});

test("Subscription catch-up sees installation completed before attachment", async () => {
  let snapshot = status();
  context.mocks.api(teamsConnectContract.getStatus, ({ respond }) => {
    const response = respond(200, snapshot);
    // The installation changes after the baseline snapshot, before the page
    // attaches its subscription. No notification is delivered for this gap.
    snapshot = status({ isConnected: true, linkedAccounts: [account] });
    return response;
  });
  await setupPage({ context, path: path(target) });
  await expectConnected();
  expect(getAction("link", "Open Teams")).toHaveAttribute("target", "_blank");
});

test("Reinstall remains explicit and returns to Teams", async () => {
  mockStatus(
    status({
      isConnected: true,
      linkedAccounts: [account],
      permissionMismatch: true,
      reinstallUrl: "https://teams.microsoft.com/l/app/app-id",
    }),
  );
  await setupPage({
    context,
    path: path({
      ...target,
      teamId: "team-core",
      channelId: "19:channel@thread.tacv2",
      activityId: "123",
      threadId: "122",
      serviceUrl: "https://evil.example/",
    }),
  });
  await expectConnected();
  expect(getAction("link", "Reinstall in Teams")).toHaveAttribute(
    "href",
    "https://teams.microsoft.com/l/app/app-id",
  );
  expect(getAction("link", "Open Teams")).toHaveAttribute(
    "href",
    "https://teams.microsoft.com/",
  );
});

test("Route departure cancels a pending read and keeps the next page", async () => {
  const request = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  let blocked = false;
  context.mocks.api(teamsConnectContract.getStatus, async ({ respond }) => {
    if (blocked) {
      request.resolve();
      await release.promise;
    }
    return respond(
      200,
      status({ isConnected: blocked, linkedAccounts: [account] }),
    );
  });
  await setupPage({ context, path: path(target) });
  blocked = true;
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await request.promise;
  click(getAction("link", "Back to settings"));
  release.resolve();
  await expect(
    screen.findByText("Microsoft Teams"),
  ).resolves.toBeInTheDocument();
  expect(window.location.pathname).toBe("/works");
  expect(
    screen.queryByRole("heading", { name: "Connected to Microsoft Teams" }),
  ).not.toBeInTheDocument();
});

test.each([false, true])(
  "Login and organization choice retain all Teams context: %s",
  async (chooseOrg) => {
    const query = {
      ...target,
      displayName: "Avery",
      upn: "a@acme.example",
      teamId: "team-core",
      conversationId: "a:conversation",
      serviceUrl: "https://smba.trafficmanager.net/amer/",
      activityId: "88",
      channelId: "channel",
      threadId: "77",
      error: "Denied",
    };
    await startPage({
      context,
      host: "app.okou.ai",
      path: path(query),
      auth: chooseOrg
        ? {
            user: { id: "integration-user", fullName: "Avery" },
            organization: { activeOrg: null, memberships: [] },
          }
        : null,
    });
    await waitFor(() => {
      return expect(window.location.pathname).toBe(
        chooseOrg ? "/sign-in/tasks/choose-organization" : "/sign-in",
      );
    });
    window.history.replaceState(null, "", window.location.href);
    window.dispatchEvent(new PopStateEvent("popstate"));
    const signIn = await screen.findByTestId("clerk-sign-in");
    const returnUrl = new URL(
      signIn.dataset.clerkForceRedirectUrl ?? "",
      window.location.origin,
    );
    expect(returnUrl.pathname).toBe("/settings/teams");
    expect(Object.fromEntries(returnUrl.searchParams)).toStrictEqual(query);
  },
);

test("A late status read cannot publish the previous actor's connection", async () => {
  const started = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  let pending = false;
  let changedOwner = false;
  context.mocks.api(teamsConnectContract.getStatus, async ({ respond }) => {
    const oldOwner = !changedOwner;
    if (pending && oldOwner) {
      started.resolve();
      await release.promise;
    }
    return respond(
      200,
      oldOwner
        ? status({ isConnected: pending, linkedAccounts: [account] })
        : status({
            tenantId: "new-tenant",
            tenantName: "New owner's tenant",
            linkedAccounts: [],
          }),
    );
  });
  await setupPage({ context, path: path(target) });
  pending = true;
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await started.promise;
  const clerk = context.mocks.clerk();
  changedOwner = true;
  act(() => {
    clerk.user(
      { id: "replacement-owner", fullName: "Replacement" },
      { id: "replacement-session", token: "replacement-token" },
    );
    clerk.stateChanged();
  });
  release.resolve();
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Connect Microsoft Teams" }),
    ).toBeInTheDocument();
  });
  expect(screen.getByText(/does not match/u)).toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "Connected to Microsoft Teams" }),
  ).not.toBeInTheDocument();
});

test("Conflicting repeated identity parameters display an invalid account context", async () => {
  mockStatus(status({ isConnected: true, linkedAccounts: [account] }));
  await setupPage({
    context,
    path: `${path(target)}&teamsUserId=someone-else`,
  });
  expect(
    screen.getByText(/incomplete Teams account context/u),
  ).toBeInTheDocument();
});

test("An OAuth identity connects independently of the receiving bot's organization", async () => {
  mockStatus(
    status({
      isConnected: true,
      isInstalled: false,
      isAdmin: false,
      teamId: null,
      teamName: null,
      linkedAccounts: [{ ...account, teamsUserId: null }],
      connectUrl: null,
    }),
  );
  await setupPage({
    context,
    path: path({
      ...target,
      orgId: "external-installation-org",
      teamId: "external-team",
    }),
  });
  await expectConnected();
  expect(
    screen.getByText("Your Teams account is connected."),
  ).toBeInTheDocument();
});
