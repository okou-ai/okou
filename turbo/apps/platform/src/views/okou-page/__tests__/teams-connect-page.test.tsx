import {
  teamsConnectContract,
  type TeamsConnectBody,
  type TeamsConnectStatus,
} from "@okouai/api-contracts/contracts/teams-connect";
import { act, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage, startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";

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
    teamId: "team-core",
    teamName: "Core Team",
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
      screen.getByText(
        "You are connected to Core Team. Mention @Verified Assistant in Teams to start chatting.",
      ),
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
  expect(getAction("button", "Connect")).toBeEnabled();
  expect(open.calls).toStrictEqual([]);
});

test.each([
  {
    label: "another Teams user",
    overrides: {},
    query: { ...target, teamsUserId: "other" },
    message: /does not match/u,
    blocked: false,
  },
  {
    label: "contradictory AAD pair",
    overrides: {},
    query: { ...target, teamsAadObjectId: "aad-other" },
    message: /does not match/u,
    blocked: false,
  },
  {
    label: "another tenant",
    overrides: {},
    query: { ...target, tenantId: "tenant-other" },
    message: /does not match/u,
    blocked: true,
  },
  {
    label: "another team",
    overrides: {},
    query: { ...target, teamId: "team-other" },
    message: /does not match/u,
    blocked: true,
  },
  {
    label: "another organization",
    overrides: {},
    query: { ...target, orgId: "org_other" },
    message: /another organization/u,
    blocked: true,
  },
])(
  "A connected boolean cannot certify $label",
  async ({ overrides, query, message, blocked }) => {
    mockStatus(
      status({ isConnected: true, linkedAccounts: [account], ...overrides }),
    );
    await setupPage({ context, path: path({ ...query, status: "connected" }) });
    expect(
      screen.getByRole("heading", { name: "Connect Microsoft Teams" }),
    ).toBeInTheDocument();
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(queryAction("button", "Connect") === null).toBe(blocked);
  },
);

test("All supplied identity fields match one of multiple caller-owned accounts", async () => {
  mockStatus(
    status({
      isConnected: true,
      linkedAccounts: [
        { ...account, teamsUserId: "other", teamsAadObjectId: "other-aad" },
        account,
      ],
    }),
  );
  await setupPage({ context, path: path(target) });
  await expectConnected();
  expect(getAction("link", "Open Teams")).toHaveAttribute("target", "_blank");
});

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

test("A provider link binds with aliases and full context, then reads actual status", async () => {
  let bodySent: TeamsConnectBody | undefined;
  const setStatus = mockStatus(status());
  context.mocks.api(teamsConnectContract.connect, ({ body, respond }) => {
    bodySent = body;
    setStatus(status({ isConnected: true, linkedAccounts: [account] }));
    return respond(200, {
      success: true,
      connectionId: "connection-core",
      role: "admin",
    });
  });
  const metadata = {
    tenantName: "Acme",
    teamId: "team-core",
    teamName: "Core",
    serviceUrl: "https://smba.trafficmanager.net/amer/",
    conversationId: "a:bot-framework-conversation",
    conversationType: "personal",
    activityId: "88",
    channelId: "channel-99",
    threadId: "100",
  };
  const open = context.mocks.browser.open();
  await setupPage({
    context,
    path: path({
      ...target,
      ...metadata,
      displayName: "Avery",
      upn: "avery@acme.example",
      error: "Previous attempt failed",
    }),
  });
  expect(getAction("button", "Connect")).toBeEnabled();
  click(getAction("button", "Connect"));
  await expectConnected();
  expect(bodySent).toStrictEqual({
    tenantId: target.tenantId,
    teamsUserId: target.teamsUserId,
    teamsAadObjectId: target.teamsAadObjectId,
    ...metadata,
    teamsUserDisplayName: "Avery",
    teamsUserPrincipalName: "avery@acme.example",
  });
  await waitFor(() => {
    return expect(
      new URLSearchParams(window.location.search).has("error"),
    ).toBeFalsy();
  });
  expect(new URLSearchParams(window.location.search).get("orgId")).toBe(
    target.orgId,
  );
  expect(
    new URLSearchParams(window.location.search).get("conversationId"),
  ).toBe(metadata.conversationId);
  expect(getAction("link", "Open Teams")).toHaveAttribute(
    "href",
    "https://teams.microsoft.com/",
  );
  expect(open.calls).toStrictEqual([]);
});

test("A successful POST without connected readback does not claim completion", async () => {
  mockStatus(status());
  context.mocks.api(teamsConnectContract.connect, ({ respond }) => {
    return respond(200, {
      success: true,
      connectionId: "accepted",
      role: "admin",
    });
  });
  await setupPage({ context, path: path(target) });
  click(getAction("button", "Connect"));
  await waitFor(() => {
    return expect(getAction("button", "Connect")).toBeEnabled();
  });
  expect(
    screen.getByRole("heading", { name: "Connect Microsoft Teams" }),
  ).toBeInTheDocument();
});

test("Read failures remain visible and recover through manual retry", async () => {
  let failed = true;
  context.mocks.api(teamsConnectContract.getStatus, ({ respond }) => {
    if (failed) {
      throw Response.error();
    }
    return respond(
      200,
      status({ isConnected: true, linkedAccounts: [account] }),
    );
  });
  await setupPage({ context, path: path({ ...target, status: "connected" }) });
  await expect(
    screen.findByRole("heading", { name: "Connection failed" }),
  ).resolves.toBeInTheDocument();
  failed = false;
  click(getAction("button", "Try again"));
  await expectConnected();
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

test.each([false, true])(
  "Installation help preserves admin distinction: %s",
  async (isAdmin) => {
    mockStatus(
      status({
        isInstalled: false,
        isAdmin,
        connectUrl: isAdmin ? "/api/teams/oauth/connect" : null,
      }),
    );
    await setupPage({ context, path: "/settings/teams" });
    expect(
      screen.getByRole("heading", { name: "Connect Microsoft Teams" }),
    ).toBeInTheDocument();
    expect(queryAction("button", "Authorize Microsoft Teams") !== null).toBe(
      isAdmin,
    );
    expect(screen.queryAllByText(/admin/iu)).toHaveLength(isAdmin ? 0 : 1);
  },
);

test("Reinstall remains explicit and supported channel context uses a fixed Teams destination", async () => {
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
    "https://teams.microsoft.com/l/message/19%3Achannel%40thread.tacv2/123?tenantId=tenant-acme&groupId=team-core&parentMessageId=122",
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

test("A conflict remains visible with its attempted context and can be retried", async () => {
  let denied = true;
  const setStatus = mockStatus(status());
  context.mocks.api(teamsConnectContract.connect, ({ respond }) => {
    if (denied) {
      return respond(403, {
        error: {
          code: "FORBIDDEN",
          message: "This Teams identity belongs to another account.",
        },
      });
    }
    setStatus(status({ isConnected: true, linkedAccounts: [account] }));
    return respond(200, {
      success: true,
      connectionId: "accepted",
      role: "admin",
    });
  });
  await setupPage({
    context,
    path: path({ ...target, upn: "avery@acme.example" }),
  });
  click(getAction("button", "Connect"));
  await waitFor(() => {
    return expect(
      screen.getAllByText("This Teams identity belongs to another account.")
        .length,
    ).toBeGreaterThan(0);
  });
  expect(new URLSearchParams(window.location.search).get("upn")).toBe(
    "avery@acme.example",
  );
  denied = false;
  click(getAction("button", "Connect"));
  await expectConnected();
});

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
    expect(queryAction("button", "Connect")).toBeNull();
  });
  expect(screen.getByText(/does not match/u)).toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "Connected to Microsoft Teams" }),
  ).not.toBeInTheDocument();
});

test("Identity fields cannot be combined across different owned accounts", async () => {
  mockStatus(
    status({
      isConnected: true,
      linkedAccounts: [
        account,
        {
          ...account,
          teamsUserId: "second-user",
          teamsAadObjectId: "second-aad",
        },
      ],
    }),
  );
  await setupPage({
    context,
    path: path({ ...target, teamsAadObjectId: "second-aad" }),
  });
  expect(screen.getByText(/does not match/u)).toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "Connected to Microsoft Teams" }),
  ).not.toBeInTheDocument();
});

test("Conflicting repeated identity parameters cannot enable binding", async () => {
  mockStatus(status({ isConnected: true, linkedAccounts: [account] }));
  await setupPage({
    context,
    path: `${path(target)}&teamsUserId=someone-else`,
  });
  expect(
    screen.getByText(/incomplete Teams account context/u),
  ).toBeInTheDocument();
  expect(queryAction("button", "Connect")).toBeNull();
});

test("Reloading a success link with no current connection remains read-only", async () => {
  mockStatus(status());
  // Binding is an explicit user action. Observe the mutation entry point at
  // the HTTP boundary so the default POST fixture cannot hide a replay.
  let attemptedBinding: TeamsConnectBody | undefined;
  context.mocks.api(teamsConnectContract.connect, ({ body, respond }) => {
    attemptedBinding = body;
    return respond(403, {
      error: {
        code: "FORBIDDEN",
        message: "Binding requires an explicit action",
      },
    });
  });
  await setupPage({
    context,
    path: path({
      ...target,
      status: "connected",
      displayName: "Old name",
      upn: "old@example.com",
    }),
  });
  expect(
    screen.getByRole("heading", { name: "Connect Microsoft Teams" }),
  ).toBeInTheDocument();
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await waitFor(() => {
    expect(getAction("button", "Connect")).toBeEnabled();
  });
  expect(new URLSearchParams(window.location.search).get("upn")).toBe(
    "old@example.com",
  );
  expect(attemptedBinding).toBeUndefined();
});

test("A failed readback after binding stays visible until a successful retry", async () => {
  let failed = false;
  context.mocks.api(teamsConnectContract.getStatus, ({ respond }) => {
    if (failed) {
      throw Response.error();
    }
    return respond(200, status());
  });
  context.mocks.api(teamsConnectContract.connect, ({ respond }) => {
    failed = true;
    return respond(200, {
      success: true,
      connectionId: "accepted",
      role: "admin",
    });
  });
  await setupPage({ context, path: path(target) });
  click(getAction("button", "Connect"));
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Connection failed" }),
    ).toBeInTheDocument();
  });
  mockStatus(status({ isConnected: true, linkedAccounts: [account] }));
  click(getAction("button", "Try again"));
  await expectConnected();
});
