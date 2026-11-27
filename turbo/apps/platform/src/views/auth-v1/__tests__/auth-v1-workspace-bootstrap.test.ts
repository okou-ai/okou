import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { onboardingStatusContract } from "@okouai/api-contracts/contracts/onboarding";
import { marketingHandoffsContract } from "@okouai/api-contracts/contracts/marketing-handoffs";
import {
  mockedClerk,
  mockClerkSessionTransitioning,
  installMockedClerkBootstrap,
} from "../../../__tests__/mock-auth.ts";
import {
  click,
  setupPage,
  startPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { installPlatformLifecycle } from "../../../test/platform-lifecycle.ts";
import {
  createTestRuntime,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { bootstrapSkeleton } from "../../../test/bootstrap-skeleton.ts";
import { featureGuidesContract } from "@okouai/api-contracts/contracts/feature-guides";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";

const context = testContext();

const workflows = {
  context,
  path: "/workflows",
} as const;
test("authentication-startup-011 Workflows reuses the identity load already in progress", async () => {
  const sdk = context.mocks.clerk();
  const pending = sdk.runtimePending();
  installMockedClerkBootstrap(context.signal);
  await waitFor(() => {
    return expect(sdk.loads).toHaveLength(1);
  });
  const opening = await startPage(workflows);

  pending.resolve();
  await opening.ready;
  await expect(
    screen.findByRole("heading", { name: "Workflows" }),
  ).resolves.toBeVisible();
  expect(sdk.loads).toHaveLength(1);
  expect(sdk.resourceRequests).toStrictEqual([]);
  expect(sdk.uiRequests).toStrictEqual([]);
});

test("authentication-startup-012 Unavailable identity service replaces the startup screen with an error", async () => {
  const sdk = context.mocks.clerk();

  const failure = new Error("Identity core unavailable during sign-in");
  sdk.resourceUnavailable(failure);
  const opening = await startPage({ context, path: "/sign-in", auth: null });
  await opening.content;
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Oops! Something went sideways",
  );
  await expect(opening.ready).rejects.toBe(failure);
  expect(bootstrapSkeleton()).toHaveAttribute("aria-hidden", "true");
  expect(sdk.loads).toStrictEqual([]);
  expect(screen.queryByTestId("clerk-sign-in")).toBeNull();
});

test.each([
  ["authentication-startup-014", "app.okou.ai", "test_production_key"],
  ["authentication-startup-015", "pr-30199-app.omby.ai", "test_preview_key"],
  ["authentication-startup-016", "okou.ai.evil.example", "test_preview_key"],
])("%s opens the hosted sign-in form for %s", async (_id, host, key) => {
  const sdk = context.mocks.clerk();
  await setupPage({ context, path: "/sign-in", host, auth: null });
  await expect(screen.findByTestId("clerk-sign-in")).resolves.toBeVisible();
  expect(sdk.resourceRequests).toStrictEqual([{ publishableKey: key }]);
  expect(sdk.loads).toContainEqual(
    expect.objectContaining({
      signInUrl: new URL("/sign-in", "https://" + host).href,
      signUpUrl: new URL("/sign-up", "https://" + host).href,
    }),
  );
  expect(sdk.uiRequests).toContain(
    document.querySelector<HTMLMetaElement>('meta[name="okou-clerk-ui-script"]')
      ?.content,
  );
});

test("authentication-startup-003 Workflows leaves foreground presence while the tab is hidden and keeps realtime", async () => {
  const tab = context.mocks.browser.visibilityState("visible");
  const realtime = context.mocks.ably;
  const presence = "user-org-foreground:test-user-123:org_default";
  await setupPage(workflows);
  await expect(
    screen.findByRole("heading", { name: "Workflows" }),
  ).resolves.toBeVisible();
  for (const state of ["visible", "hidden", "visible"] as const) {
    tab.changeTo(state);
    await waitFor(() => {
      return expect(realtime.getPresenceCount(presence)).toBe(
        state === "visible" ? 1 : 0,
      );
    });
    expect(
      realtime.hasSubscriptionOnChannel(
        "user:test-user-123",
        "connectorPermissionUpdated",
      ),
    ).toBeTruthy();
  }
});

test("authentication-startup-018 Changing the workspace leaves Workflows for home", async () => {
  const sdk = context.mocks.clerk();
  await setupPage(workflows);
  await expect(
    screen.findByRole("heading", { name: "Workflows" }),
  ).resolves.toBeVisible();
  expect(location.pathname).toBe("/workflows");
  sdk.organization({
    activeOrg: { id: "org_beta", name: "Beta" },
    memberships: [{ id: "org_beta" }],
  });
  sdk.stateChanged();
  await waitFor(() => {
    return expect(location.pathname).toBe("/");
  });
});

test("Changing the signed-in account in the same workspace reloads without changing the route", async () => {
  const reload = vi.spyOn(window.location, "reload");
  const sdk = context.mocks.clerk();
  await setupPage(workflows);
  await expect(
    screen.findByRole("heading", { name: "Workflows" }),
  ).resolves.toBeVisible();
  sdk.user(
    { id: "next-member", fullName: "Next member" },
    { token: "next-session" },
  );
  sdk.stateChanged();
  await waitFor(() => {
    return expect(reload).toHaveBeenCalledTimes(1);
  });
  expect(location.pathname).toBe("/workflows");
});

test("A chat database catch-up aborts before fetching when Clerk changes accounts during token retrieval", async () => {
  const reload = vi.spyOn(window.location, "reload");
  const sentry = context.mocks.sentry();
  const sdk = context.mocks.clerk();
  let armed = false;
  let eventsRequestsAfterArm = 0;
  let requestedOrganizationId: string | undefined;
  const tokenRequested = context.mocks.deferred<void>();
  const tokenDelivery = context.mocks.deferred<string>();

  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    if (armed) {
      eventsRequestsAfterArm += 1;
    }
    return respond(200, { events: [], hasMore: false });
  });

  await setupPage(workflows);
  await expect(
    screen.findByRole("heading", { name: "Workflows" }),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    return expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
  });

  armed = true;
  mockedClerk.sessionGetToken.mockImplementationOnce((options) => {
    requestedOrganizationId = options?.organizationId;
    if (!tokenRequested.settled()) {
      tokenRequested.resolve();
    }
    return tokenDelivery.promise;
  });

  context.mocks.ably.trigger("threadListChanged");
  await tokenRequested.promise;

  // Clerk mutates the active user before emitting its state-change listener.
  sdk.user(
    { id: "next-member", fullName: "Next member" },
    { id: "next-session", token: "next-session-token" },
  );
  tokenDelivery.resolve("stale-member-token");
  sdk.stateChanged();

  await waitFor(() => {
    return expect(reload).toHaveBeenCalledTimes(1);
  });
  expect(requestedOrganizationId).toBe("org_default");
  expect(eventsRequestsAfterArm).toBe(0);
  expect(sentry.reports).toStrictEqual([]);
});

test("Switching accounts while Debug IndexedDB diagnostics are open reloads without runtime-uninitialized errors", async () => {
  const reload = vi.spyOn(window.location, "reload");
  const sentry = context.mocks.sentry();
  const sdk = context.mocks.clerk();

  await setupPage({
    context,
    path: "/?settings=debug",
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });
  const settings = await screen.findByRole("dialog");
  const details = await within(settings).findByText("IndexedDB storage", {
    selector: "summary span",
  });
  click(details);
  await expect(
    within(settings).findByText("chat_thread_snapshot", { selector: "dt" }),
  ).resolves.toBeInTheDocument();

  sdk.user(
    { id: "next-member", fullName: "Next member" },
    { id: "next-session", token: "next-session-token" },
  );
  sdk.stateChanged();

  await waitFor(() => {
    return expect(reload).toHaveBeenCalledTimes(1);
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(sentry.reports).toStrictEqual([]);
});

test("A known member without an active Clerk session does not unblock chat database queries before runtime setup", async () => {
  const sentry = context.mocks.sentry();
  const preferencesChecked = context.mocks.deferred<void>();
  let snapshotRequests = 0;

  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    snapshotRequests += 1;
    return respond(401, {
      error: { code: "UNAUTHORIZED", message: "Unauthorized" },
    });
  });
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    if (!preferencesChecked.settled()) {
      preferencesChecked.resolve();
    }
    return respond(200, {
      timezone: "UTC",
      locale: "en-US",
      supportedLocales: ["en-US"],
      sendMode: "enter",
      cloudBrowserEnabledByDefault: true,
      chatResourcesEnabledByDefault: false,
      forYouCoverId: null,
      theme: "system",
      colorTheme: null,
      captureNetworkBodiesRemaining: 0,
      memoryInitialized: true,
    });
  });

  const opening = await startPage({
    context,
    path: "/workflows",
    auth: {
      user: { id: "sessionless-member", fullName: "Sessionless Member" },
      session: null,
    },
  });
  await preferencesChecked.promise;

  await expect(
    Promise.race([
      opening.ready.then(() => {
        return "resolved";
      }),
      Promise.resolve("pending"),
    ]),
  ).resolves.toBe("pending");
  expect(snapshotRequests).toBe(0);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(sentry.reports).toStrictEqual([]);
});

test("A repeated signed-in member notification keeps Workflows and its account menu available", async () => {
  const clerk = context.mocks.clerk();
  const member = { id: "user-a", fullName: "Avery Coast" };
  const session = { id: "field-session", token: "fixture-session" };
  await setupPage({ ...workflows, auth: { user: member, session } });
  await screen.findByRole("heading", { name: "Workflows" });
  const account = await screen.findByLabelText("Avery Coast");
  act(() => {
    clerk.user(member, session);
    clerk.stateChanged();
  });
  click(account);
  await screen.findByRole("menu");
  expect(screen.getByRole("heading", { name: "Workflows" })).toBeVisible();
  expect(location.pathname).toBe("/workflows");
});

test("A refreshed profile for the same member remains usable from the Workflows account menu", async () => {
  const sdk = context.mocks.clerk();
  const session = { id: "summit-session", token: "summit-token" };
  await setupPage({
    ...workflows,
    auth: { user: { id: "user-a", fullName: "Sam West" }, session },
  });
  await expect(screen.findByLabelText("Sam West")).resolves.toBeInTheDocument();
  act(() => {
    sdk.user({ id: "user-a", fullName: "Sam Calder" }, session);
    sdk.stateChanged();
  });
  const updated = await screen.findByLabelText("Sam Calder");
  click(updated);
  await expect(screen.findByRole("menu")).resolves.toBeVisible();
  expect(screen.getByRole("heading", { name: "Workflows" })).toBeVisible();
});

const handoffTask = "Prepare the bathymetry index";
async function resolvePendingHandoff(
  change: "profile refresh" | "transition back to the same member",
) {
  const sdk = context.mocks.clerk();
  const session = { id: "lake-session", token: "lake-test-token" };
  const received = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  const statusStarted = context.mocks.deferred<void>();
  const allowStatus = context.mocks.deferred<void>();
  context.mocks.api(onboardingStatusContract.getStatus, async ({ respond }) => {
    if (!statusStarted.settled()) {
      statusStarted.resolve();
    }
    await allowStatus.promise;
    return respond(200, {
      needsOnboarding: true,
      onboardingComplete: false,
      isAdmin: true,
      hasOrg: false,
    });
  });
  context.mocks.api(marketingHandoffsContract.resolve, async ({ respond }) => {
    if (!received.settled()) {
      received.resolve();
    }
    await release.promise;
    return respond(200, {
      version: 1,
      prompt: handoffTask,
      options: {},
      files: [],
    });
  });
  const entry = await startPage({
    context,
    path: "/onboarding?handoff=" + "4".repeat(64),
    auth: {
      user: { id: "user-a", fullName: "Lake Survey" },
      session,
    },
  });
  await statusStarted.promise;
  act(() => {
    sdk.organization({ activeOrg: null, memberships: [] });
    sdk.stateChanged();
  });
  allowStatus.resolve();
  await received.promise;
  act(() => {
    if (change === "transition back to the same member") {
      mockClerkSessionTransitioning(true);
    }
    sdk.user({ id: "user-a", fullName: "Lake Surveyor" }, session);
    sdk.stateChanged();
    if (change === "transition back to the same member") {
      mockClerkSessionTransitioning(false);
    }
  });
  release.resolve();
  return entry.ready;
}
test("clerk-user-005 The same member's refreshed profile can finish its original pending handoff", async () => {
  await resolvePendingHandoff("profile refresh");
  await expect(
    screen.findByLabelText("Onboarding prompt"),
  ).resolves.toHaveTextContent(handoffTask);
});
test("Replacing the member read during a transition cancels the original handoff", async () => {
  await expect(
    resolvePendingHandoff("transition back to the same member"),
  ).rejects.toMatchObject({ name: "AbortError", message: "Session changed" });
  expect(screen.queryByText(handoffTask)).toBeNull();
});

test("A protected history entry waits out the signed-out member transition", async () => {
  const clerk = context.mocks.clerk();
  await setupPage({
    context,
    host: "app.okou.ai",
    path: "/sign-in",
    auth: null,
  });
  await screen.findByTestId("app-sign-in");
  act(() => {
    mockClerkSessionTransitioning(true);
  });
  const grant = context.mocks.deferred<string | null>();
  context.mocks.http.post(
    "*" + hostContract.authorizeSiteSession.path,
    ({ request }) => {
      grant.resolve(request.headers.get("authorization"));
      return new Response(
        JSON.stringify({
          error: { code: "FORBIDDEN", message: "Synthetic denial" },
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    },
  );
  const path = "/hosted-site-authorize";
  const params = new URLSearchParams({
    siteId: "aad10111-3310-493d-a741-1f9111111111",
    origin: "https://survey.okou.app",
    state: "a".repeat(43),
    codeChallenge: "p".repeat(43),
  });
  const checked = context.mocks.deferred<void>();
  const loaded = mockedClerk.loaded;
  const boundary = vi
    .spyOn(mockedClerk, "loaded", "get")
    .mockImplementation(() => {
      if (!checked.settled() && location.pathname === path) {
        checked.resolve();
      }
      return loaded;
    });
  act(() => {
    history.pushState({}, "", path + "?" + params);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await waitFor(() => {
    return expect(checked.settled()).toBeTruthy();
  });
  boundary.mockRestore();
  expect(grant.settled()).toBeFalsy();
  expect(location.pathname).toBe(path);
  act(() => {
    clerk.user(
      { id: "user-a", fullName: "Inez Field" },
      { id: "field-trip", token: "local-field-token" },
    );
    clerk.organization({
      activeOrg: { id: "org-field", name: "Field" },
      memberships: [{ id: "org-field" }],
    });
    clerk.sessionSignedOut(false);
    mockClerkSessionTransitioning(false);
  });
  await waitFor(() => {
    return expect(grant.settled()).toBeTruthy();
  });
  await expect(grant.promise).resolves.toBe("Bearer local-field-token");
  await waitFor(() => {
    return expect(location.pathname).toBe("/hosted-site-access");
  });
  expect(new URL(location.href).searchParams.get("reason")).toBe("denied");
});

test("The workspace starts its member subscription after a delayed identity load", async () => {
  const sdk = context.mocks.clerk();
  const gate = sdk.runtimePending();
  const source = context.mocks.ably;
  try {
    const startup = await startPage({
      context,
      path: "/workflows",
      auth: { user: { id: "user-a", fullName: "Basin Member" } },
    });
    await waitFor(() => {
      return expect(sdk.loads.length).toBeGreaterThan(0);
    });
    expect(screen.queryByLabelText("Basin Member")).toBeNull();
    expect(
      source.hasSubscriptionOnChannel(
        "user:user-a",
        "connectorPermissionUpdated",
      ),
    ).toBeFalsy();
    gate.resolve();
    await startup.ready;
    await screen.findByLabelText("Basin Member");
    await waitFor(() => {
      return expect(
        source.hasSubscriptionOnChannel(
          "user:user-a",
          "connectorPermissionUpdated",
        ),
      ).toBeTruthy();
    });
  } finally {
    if (!gate.settled()) {
      gate.resolve();
    }
  }
});

test("Only the replacement workspace receives the member profile after the owner changes", async () => {
  const first = createTestRuntime(context);
  installPlatformLifecycle(first.signal);
  await setupPage({
    ...workflows,
    context: first,
    auth: { user: { id: "user-a", fullName: "First chart owner" } },
  });
  const oldMenu = await screen.findByLabelText("First chart owner");
  first.dispose();
  expect(oldMenu).not.toBeInTheDocument();
  const next = createTestRuntime(context);
  installPlatformLifecycle(next.signal);
  await setupPage({
    ...workflows,
    context: next,
    auth: { user: { id: "user-a", fullName: "Second chart owner" } },
  });
  await screen.findByLabelText("Second chart owner");
  act(() => {
    return mockClerkSessionTransitioning(true);
  });
  expect(screen.queryByLabelText("First chart owner")).toBeNull();
  act(() => {
    const sdk = next.mocks.clerk();
    sdk.user(
      { id: "user-a", fullName: "Restored chart owner" },
      { token: "local-restored" },
    );
    mockClerkSessionTransitioning(false);
  });
  await expect(
    screen.findByLabelText("Restored chart owner"),
  ).resolves.toBeInTheDocument();
  expect(oldMenu).not.toBeInTheDocument();
});

const workspace = {
  context,
  path: "/workflows",
} as const;

function startupView() {
  const skeleton = bootstrapSkeleton();
  return {
    loading:
      !skeleton.hidden && skeleton.getAttribute("aria-hidden") !== "true",
    root: document.getElementById("root")?.hasChildNodes() ?? false,
    heading: screen.queryByRole("heading", { name: "Workflows" }) !== null,
    links: queryAllByRoleFast("link").length,
  };
}

test("authentication-startup-001 Workflows stays hidden until the current member's identity is ready", async () => {
  const sdk = context.mocks.clerk();
  const identity = sdk.runtimePending();
  const page = await startPage(workspace);
  await vi.waitUntil(() => {
    return sdk.loads.length > 0;
  });
  const held = startupView();
  identity.resolve();
  await page.ready;
  await expect(
    screen.findByRole("heading", { name: "Workflows" }),
  ).resolves.toBeVisible();
  expect(held).toMatchObject({ loading: true, heading: false, links: 0 });
  expect(bootstrapSkeleton()).toHaveAttribute("aria-hidden", "true");
  expect(queryAllByRoleFast("link").length).toBeGreaterThan(0);
  expect(screen.queryByTestId("clerk-sign-in")).toBeNull();
});

test("bootstrap-feature-switch-002 Workspace features release the page and the feature guide request", async () => {
  const arrived = context.mocks.deferred<void>(),
    reply = context.mocks.deferred<void>();
  const guide = context.mocks.deferred<void>();
  const editions: string[] = [];
  context.mocks.api(featureGuidesContract.current, ({ request, respond }) => {
    editions.push(new URL(request.url).pathname);
    if (!guide.settled()) {
      guide.resolve();
    }
    return respond(200, { edition: null });
  });
  context.mocks.api(featureSwitchesContract.get, async ({ respond }) => {
    if (!arrived.settled()) {
      arrived.resolve();
    }
    await reply.promise;
    return respond(200, { switches: {}, effectiveSwitches: {} });
  });
  const page = await startPage(workspace);
  await arrived.promise;
  const held = { ...startupView(), editions: [...editions] };
  reply.resolve();
  await page.ready;
  await expect(
    screen.findByRole("heading", { name: "Workflows" }),
  ).resolves.toBeVisible();
  await guide.promise;
  expect(held).toMatchObject({ loading: true, root: false, editions: [] });
  expect(editions).toStrictEqual([featureGuidesContract.current.path]);
});

test("authentication-startup-013 An old onboarding response cannot redirect the member after the active workspace changes", async () => {
  const clerk = context.mocks.clerk();
  const held = context.mocks.deferred<void>(),
    release = context.mocks.deferred<void>();
  const identities: string[] = [];
  context.mocks.api(
    onboardingStatusContract.getStatus,
    async ({ respond, request }) => {
      identities.push(new URL(request.url).pathname);
      if (!held.settled()) {
        held.resolve();
      }
      await release.promise;
      return respond(200, {
        needsOnboarding: true,
        onboardingComplete: false,
        isAdmin: true,
        hasOrg: true,
      });
    },
  );
  const page = await startPage(workspace);
  await held.promise;
  clerk.organization({
    activeOrg: { id: "org_current", name: "Current workspace" },
    memberships: [{ id: "org_current" }],
  });
  release.resolve();
  await page.ready;
  await expect(
    screen.findByRole("heading", { name: "Workflows" }),
  ).resolves.toBeVisible();
  expect(identities).toStrictEqual([onboardingStatusContract.getStatus.path]);
  await waitFor(() => {
    return expect(location.pathname).toBe("/workflows");
  });
  expect(
    screen.queryByRole("heading", {
      name: /what do you want to make first|onboarding/i,
    }),
  ).toBeNull();
});

test("bootstrap-feature-switch-001 Workspace features stay private while the signed-out member sees sign-in", async () => {
  const unexpected = context.mocks.deferred<void>();
  context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
    unexpected.resolve();
    return respond(200, { switches: {}, effectiveSwitches: {} });
  });
  await setupPage({ context, path: "/sign-in", auth: null });
  await expect(screen.findByTestId("clerk-sign-in")).resolves.toBeVisible();
  expect(unexpected.settled()).toBeFalsy();
});
