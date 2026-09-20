import {
  desktopAuthHandoffContract,
  desktopAuthConsumeContract,
} from "@okouai/api-contracts/contracts/desktop-auth";
import { initSentry } from "../../../lib/sentry.ts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import {
  mockedClerk,
  type MockedMembership,
} from "../../../__tests__/mock-auth.ts";
import {
  click,
  queryAllByRoleFast,
  setupPage,
  type SetupPageAuth,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const HANDOFF = "550e8400-e29b-41d4-a716-446655440000";
const CODE = "a".repeat(43);
const TICKET = "private-clerk-ticket";
const SCHEME = "ai.okou.desktop";
const CALLBACK = `https://app.okou.ai/desktop-auth/callback?callbackScheme=${SCHEME}`;
const alpha = {
  id: "member_alpha",
  organization: { id: "org_alpha", name: "Alpha" },
} as const;
const beta = {
  id: "member_beta",
  organization: { id: "org_beta", name: "Beta" },
} as const;

function navigation() {
  const documents: string[] = [];
  vi.spyOn(location, "replace").mockImplementation((url) => {
    documents.push(String(url));
  });
  return documents;
}

function bridge(
  operation: (token: string) => Promise<void> = () => {
    return Promise.resolve();
  },
) {
  const tokens: string[] = [];
  window.vm0DesktopAuth = {
    completeSignIn: async ({ token }) => {
      tokens.push(token);
      await operation(token);
    },
  };
  context.signal.addEventListener(
    "abort",
    () => {
      delete window.vm0DesktopAuth;
    },
    { once: true },
  );
  return tokens;
}

async function page(path: string, auth?: SetupPageAuth, host = "app.okou.ai") {
  await setupPage({
    context,
    host,
    path,
    ...(auth === undefined ? {} : { auth }),
  });
  await screen.findByRole("heading", { name: "Sign in to Desktop" });
}

async function leaveDesktopAuthPage(): Promise<void> {
  window.history.pushState({}, "", "/desktop-auth/missing");
  fireEvent.popState(window);
  await screen.findByRole("heading", { name: "That page isn't here." });
}

function button(name: string) {
  const result = queryAllByRoleFast("button").find((item) => {
    return (
      item.textContent?.trim() === name ||
      item.getAttribute("aria-label") === name
    );
  });
  if (!result) {
    throw new Error(`Missing button ${name}`);
  }
  return result;
}

function signedIn(
  active: boolean,
  memberships: MockedMembership[] = [alpha, beta],
): SetupPageAuth {
  return {
    user: { id: "desktop-user", fullName: "Desktop User" },
    organization: {
      activeOrg: active ? { id: "org_alpha", name: "Alpha" } : null,
      memberships,
    },
  };
}

async function failed() {
  await screen.findByRole("region", {
    description:
      "Sign-in could not finish. Start again from Desktop, or retry in this browser.",
  });
}

test.each(["ai.okou.desktop", "ai.okou.desktop.dev"])(
  "signed-out entry preserves explicit %s in the absolute hosted auth callback",
  async (scheme) => {
    const documents = navigation();
    await page(`/desktop-auth/start?callbackScheme=${scheme}`, null);
    await waitFor(() => {
      expect(documents).toHaveLength(1);
    });
    const destination = new URL(documents[0]!);
    expect(destination.origin).toBe("https://app.okou.ai");
    expect(destination.pathname).toBe("/sign-in");
    expect(destination.searchParams.get("redirect_url")).toBe(
      `https://app.okou.ai/desktop-auth/callback?callbackScheme=${scheme}`,
    );
  },
);

test("the skeleton covers the page until the Clerk runtime resolves", async () => {
  const clerkLoad = context.mocks.clerk().runtimePending();
  const documents = navigation();

  const pageReady = setupPage({
    context,
    host: "app.okou.ai",
    path: `/desktop-auth/start?callbackScheme=${SCHEME}`,
  });

  // The app root mounts nothing before the runtime resolves, so publishing the
  // page any earlier would replace the skeleton with a blank document.
  const skeleton = await screen.findByTestId("app-skeleton");
  expect(skeleton).not.toHaveAttribute("aria-hidden", "true");
  expect(
    screen.queryByRole("heading", { name: "Sign in to Desktop" }),
  ).toBeNull();

  clerkLoad.resolve();
  await pageReady;

  await waitFor(() => {
    expect(documents).toStrictEqual([CALLBACK]);
  });
});

test("signed-in entry goes straight to the callback", async () => {
  const documents = navigation();
  await page(`/desktop-auth/start?callbackScheme=${SCHEME}`);
  await waitFor(() => {
    expect(documents).toStrictEqual([CALLBACK]);
  });
});

test.each([
  "",
  "?callbackScheme=javascript",
  "?callbackScheme=ai.okou.desktop.evil",
])("rejects missing or invalid browser schemes %s", async (query) => {
  const documents = navigation();
  await page(`/desktop-auth/start${query}`, null);
  await failed();
  expect(documents).toStrictEqual([]);
});

test.each(["sign-in", "sign-up"])(
  "%s retains the Desktop callback when changing authentication mode",
  async (mode) => {
    await setupPage({
      context,
      host: "app.okou.ai",
      path: `/${mode}?redirect_url=${encodeURIComponent(CALLBACK)}`,
      auth: null,
    });
    const auth = await screen.findByTestId(`clerk-${mode}`);
    const other = mode === "sign-in" ? "/sign-up" : "/sign-in";
    const switchUrl =
      mode === "sign-in"
        ? auth.dataset.clerkSignUpUrl
        : auth.dataset.clerkSignInUrl;
    expect(switchUrl).toBeDefined();
    const destination = new URL(switchUrl!, location.origin);
    expect(destination.pathname).toBe(other);
    expect(destination.searchParams.get("redirect_url")).toBe(CALLBACK);
  },
);

test.each(["app.okou.ai", "app.vm7.ai", "pr-31957-app.omby.ai"])(
  "signed-out consume uses the normal API origin for %s and never navigates with the ticket",
  async (host) => {
    const documents = navigation();
    const clerk = context.mocks.clerk();
    const requests: {
      url: string;
      authorization: string | null;
      body: unknown;
    }[] = [];
    context.mocks.api(
      desktopAuthConsumeContract.consume,
      async ({ request, respond }) => {
        requests.push({
          url: request.url,
          authorization: request.headers.get("Authorization"),
          body: await request.json(),
        });
        return respond(200, { token: TICKET });
      },
    );
    mockedClerk.clientSignInCreate.mockResolvedValue({
      status: "complete",
      createdSessionId: "test-session-id",
    });
    mockedClerk.setActive.mockImplementation(async () => {
      clerk.user(
        { id: "new-user", fullName: "New User" },
        { token: "fresh-session-token" },
      );
      clerk.sessionSignedOut(false);
      clerk.stateChanged();
      await Promise.resolve();
    });
    await page(
      `/desktop-auth/consume?code=${CODE}&handoffId=${HANDOFF}`,
      null,
      host,
    );
    await waitFor(() => {
      expect(documents).toHaveLength(1);
    });
    expect(requests).toStrictEqual([
      {
        url: `https://${host.replace("app.", "api.").replace("-app.", "-api.").replace("omby.ai", "vm6.ai")}/api/desktop-auth/consume`,
        authorization: null,
        body: { code: CODE },
      },
    ]);
    expect(mockedClerk.clientSignInCreate).toHaveBeenCalledWith({
      strategy: "ticket",
      ticket: TICKET,
    });
    expect(documents[0]).toBe(
      `https://${host}/desktop-auth/token?handoffId=${HANDOFF}`,
    );
    expect(location.href).not.toContain(CODE);
    expect(JSON.stringify(documents)).not.toContain(TICKET);
  },
);

test.each(["bad", "expired", "replayed"])(
  "fails closed on a %s code and does not expose the API error",
  async (kind) => {
    const documents = navigation();
    const tokens = bridge();
    context.mocks.api(desktopAuthConsumeContract.consume, ({ respond }) => {
      return respond(400, {
        error: {
          code: "BAD_REQUEST",
          message: `code=${CODE} ticket=${TICKET}`,
        },
      });
    });
    await page(
      `/desktop-auth/consume?code=${kind === "bad" ? "!" : CODE}`,
      null,
    );
    await failed();
    expect(documents).toStrictEqual([]);
    expect(tokens).toStrictEqual([]);
    expect(document.body.textContent).not.toContain(TICKET);
    expect(document.body.textContent).not.toContain(CODE);
  },
);

test("ticket session tasks preserve the handoff without exposing the ticket to hosted auth", async () => {
  const documents = navigation();
  context.mocks.clerk();
  context.mocks.api(desktopAuthConsumeContract.consume, ({ respond }) => {
    return respond(200, { token: TICKET });
  });
  mockedClerk.setActive.mockImplementation(async (params) => {
    await params.navigate?.({
      session: {
        currentTask: { key: "setup-mfa" },
      },
      decorateUrl: (url) => {
        return url;
      },
    });
  });
  await page(`/desktop-auth/consume?code=${CODE}&handoffId=${HANDOFF}`, null);
  await waitFor(() => {
    expect(documents).toHaveLength(1);
  });
  const task = new URL(documents[0]!);
  expect(task.pathname).toBe("/sign-in/tasks/setup-mfa");
  expect(task.searchParams.get("redirect_url")).toBe(
    `https://app.okou.ai/desktop-auth/token?handoffId=${HANDOFF}`,
  );
  expect(task.toString()).not.toContain(TICKET);
});

test.each(["event-before-resolution", "event-after-resolution"])(
  "bootstrap organization watcher yields through fresh-token IPC and server acknowledgement: %s",
  async (ordering) => {
    const documents = navigation();
    const clerk = context.mocks.clerk();
    const activated = context.mocks.deferred<void>();
    const ipc = context.mocks.deferred<void>();
    const acknowledgement = context.mocks.deferred<void>();
    const completionRequested = context.mocks.deferred<void>();
    const tokens = bridge(() => {
      return ipc.promise;
    });
    const headers: (string | null)[] = [];
    mockedClerk.sessionGetToken.mockImplementation((options) => {
      return Promise.resolve(
        options?.skipCache ? "fresh-org-beta" : "stale-org-alpha",
      );
    });
    mockedClerk.setActive.mockImplementation(async () => {
      if (ordering === "event-before-resolution") {
        clerk.organization({ activeOrg: { id: "org_beta", name: "Beta" } });
        clerk.stateChanged();
      }
      activated.resolve();
      await Promise.resolve();
    });
    context.mocks.api(
      desktopAuthHandoffContract.complete,
      async ({ request, respond }) => {
        headers.push(request.headers.get("Authorization"));
        completionRequested.resolve();
        await acknowledgement.promise;
        return respond(200, { status: "completed" });
      },
    );
    await page(
      `/desktop-auth/select-org?force=true&handoffId=${HANDOFF}`,
      signedIn(true),
    );
    await screen.findByRole("region", {
      description: "Choose a workspace for this computer.",
    });
    click(button("Beta"));
    click(button("Beta"));
    await activated.promise;
    if (ordering === "event-after-resolution") {
      clerk.organization({ activeOrg: { id: "org_beta", name: "Beta" } });
      clerk.stateChanged();
    }
    await waitFor(() => {
      expect(tokens).toStrictEqual(["fresh-org-beta"]);
    });
    expect(location.pathname).toBe("/desktop-auth/select-org");
    expect(documents).toStrictEqual([]);
    expect(headers).toStrictEqual([]);
    ipc.resolve();
    await completionRequested.promise;
    expect(documents).toStrictEqual([]);
    expect(location.pathname).toBe("/desktop-auth/select-org");
    expect(headers).toStrictEqual(["Bearer fresh-org-beta"]);
    acknowledgement.resolve();
    await waitFor(() => {
      expect(documents).toStrictEqual(["/"]);
    });
    expect(mockedClerk.setActive).toHaveBeenCalledTimes(1);
  },
);

test("ordinary Web organization switching still refreshes and navigates home", async () => {
  const clerk = context.mocks.clerk();
  const freshToken = context.mocks.deferred<string>();
  const requested = context.mocks.deferred<void>();
  await setupPage({
    context,
    host: "app.okou.ai",
    path: "/agents",
  });
  await screen.findByRole("heading", { name: "Agents" });
  mockedClerk.sessionGetToken.mockImplementation((options) => {
    if (options?.skipCache) {
      requested.resolve();
      return freshToken.promise;
    }
    return Promise.resolve("current-web-token");
  });
  clerk.organization({ activeOrg: { id: "org_beta", name: "Beta" } });
  clerk.stateChanged();
  await requested.promise;
  expect(location.pathname).toBe("/agents");
  freshToken.resolve("fresh-web-token");
  await waitFor(() => {
    expect(location.pathname).toBe("/");
  });
});

test("existing session restoration uses a fresh token without requiring a handoff", async () => {
  const documents = navigation();
  const tokens = bridge();
  context.mocks.clerk();
  mockedClerk.sessionGetToken.mockImplementation((options) => {
    return Promise.resolve(
      options?.skipCache ? "fresh-restore" : "stale-restore",
    );
  });
  await page("/desktop-auth/token");
  await waitFor(() => {
    expect(documents).toStrictEqual(["/"]);
  });
  expect(tokens).toStrictEqual(["fresh-restore"]);
});

test.each([0, 2])(
  "token restoration with %s memberships makes the native select-org transition",
  async (count) => {
    const documents = navigation();
    const tokens = bridge();
    await page(
      `/desktop-auth/token?handoffId=${HANDOFF}`,
      signedIn(false, [alpha, beta].slice(0, count)),
    );
    await waitFor(() => {
      expect(documents).toStrictEqual([
        `https://app.okou.ai/desktop-auth/select-org?handoffId=${HANDOFF}`,
      ]);
    });
    expect(tokens).toStrictEqual([]);
  },
);

test("a sole workspace is activated before token restoration completes", async () => {
  const documents = navigation();
  const clerk = context.mocks.clerk();
  const tokens = bridge();
  mockedClerk.setActive.mockImplementation(async () => {
    clerk.organization({ activeOrg: { id: "org_alpha", name: "Alpha" } });
    clerk.stateChanged();
    await Promise.resolve();
  });
  await page("/desktop-auth/token", signedIn(false, [alpha]));
  await waitFor(() => {
    expect(documents).toStrictEqual(["/"]);
  });
  expect(tokens).toStrictEqual(["test-token"]);
  expect(location.pathname).toBe("/desktop-auth/token");
});

test("missing session makes a native-observable start transition without opening interactive sign-in", async () => {
  const documents = navigation();
  await page("/desktop-auth/token", null);
  await waitFor(() => {
    expect(documents).toStrictEqual(["https://app.okou.ai/desktop-auth/start"]);
  });
});

test("no workspaces is actionable and does not enter onboarding or complete", async () => {
  const documents = navigation();
  await page("/desktop-auth/select-org", signedIn(false, []));
  await screen.findByRole("region", {
    description:
      "Create or join a workspace in the web app, then sign in again from Desktop.",
  });
  expect(documents).toStrictEqual([]);
});

test.each(["bridge", "completion"])(
  "%s failure cannot signal successful native navigation",
  async (failure) => {
    const documents = navigation();
    if (failure === "completion") {
      bridge();
    }
    context.mocks.api(desktopAuthHandoffContract.complete, ({ respond }) => {
      return respond(500, {
        error: { code: "INTERNAL_SERVER_ERROR", message: TICKET },
      });
    });
    await page(`/desktop-auth/token?handoffId=${HANDOFF}`);
    await failed();
    expect(documents).toStrictEqual([]);
    expect(document.body.textContent).not.toContain(TICKET);
  },
);

test("cancelling a delayed token read prevents late IPC", async () => {
  const documents = navigation();
  const tokens = bridge();
  const token = context.mocks.deferred<string>();
  const requested = context.mocks.deferred<void>();
  context.mocks.clerk();
  mockedClerk.sessionGetToken.mockImplementation(() => {
    requested.resolve();
    return token.promise;
  });
  await page("/desktop-auth/token");
  await requested.promise;
  await leaveDesktopAuthPage();
  token.resolve("too-late-token");
  await token.promise;
  expect(tokens).toStrictEqual([]);
  expect(documents).toStrictEqual([]);
});

test("browser completion waits through pending and consumed, and manual reopen never creates a second handoff", async () => {
  const opened = context.mocks.browser.locationAssign();
  const consumed = context.mocks.deferred<void>();
  const completed = context.mocks.deferred<void>();
  let creates = 0;
  let polls = 0;
  context.mocks.api(desktopAuthHandoffContract.create, ({ body, respond }) => {
    creates += 1;
    expect(body).toStrictEqual({ callbackScheme: SCHEME });
    return respond(200, {
      callbackUrl: `${SCHEME}://auth/callback?code=${CODE}&handoffId=${HANDOFF}`,
      handoffId: HANDOFF,
    });
  });
  context.mocks.api(desktopAuthHandoffContract.status, async ({ respond }) => {
    polls += 1;
    if (polls === 1) {
      return respond(200, { status: "pending" });
    }
    if (polls === 2) {
      await consumed.promise;
      return respond(200, { status: "consumed" });
    }
    await completed.promise;
    return respond(200, { status: "completed" });
  });
  await page(`/desktop-auth/callback?callbackScheme=${SCHEME}`);
  await screen.findByRole("region", {
    description: "Open Desktop to continue signing in.",
  });
  click(button("Open Desktop"));
  expect(opened.calls).toStrictEqual([
    `${SCHEME}://auth/callback?code=${CODE}&handoffId=${HANDOFF}`,
    `${SCHEME}://auth/callback?code=${CODE}&handoffId=${HANDOFF}`,
  ]);
  consumed.resolve();
  await screen.findByRole("region", {
    description: "Finishing sign-in in Desktop. Keep this window open.",
  });
  expect(queryAllByRoleFast("button")).toStrictEqual([]);
  completed.resolve();
  await screen.findByRole("region", {
    description: "Desktop is signed in. You can close this window.",
  });
  expect(creates).toBe(1);
  expect(polls).toBe(3);
});

test("browser polling stops on an unusable status and retry explicitly navigates to a fresh callback attempt", async () => {
  const documents = navigation();
  context.mocks.browser.locationAssign();
  const unusable = context.mocks.deferred<void>();
  let polls = 0;
  let creates = 0;
  context.mocks.api(desktopAuthHandoffContract.create, ({ respond }) => {
    creates += 1;
    return respond(200, {
      callbackUrl: `${SCHEME}://auth/callback?code=${CODE}&handoffId=${HANDOFF}`,
      handoffId: HANDOFF,
    });
  });
  context.mocks.api(desktopAuthHandoffContract.status, async ({ respond }) => {
    polls += 1;
    if (polls === 1) {
      return respond(200, { status: "pending" });
    }
    await unusable.promise;
    return respond(500, {
      error: { code: "INTERNAL_SERVER_ERROR", message: TICKET },
    });
  });
  await page(`/desktop-auth/callback?callbackScheme=${SCHEME}`);
  await screen.findByRole("region", {
    description: "Open Desktop to continue signing in.",
  });
  unusable.resolve();
  await failed();
  expect(polls).toBe(2);
  expect(creates).toBe(1);
  expect(document.body.textContent).not.toContain(TICKET);
  click(button("Try again"));
  expect(documents).toStrictEqual([CALLBACK]);
});

test.each([
  "https://evil.example/",
  "ai.vm0.zero.desktop://auth/callback",
  "ai.okou.desktop://evil/callback",
])(
  "browser rejects the unexpected custom-protocol destination %s",
  async (destination) => {
    const opened = context.mocks.browser.locationAssign();
    context.mocks.api(desktopAuthHandoffContract.create, ({ respond }) => {
      return respond(200, {
        callbackUrl: `${destination}?code=${CODE}&handoffId=${HANDOFF}`,
        handoffId: HANDOFF,
      });
    });
    await page(`/desktop-auth/callback?callbackScheme=${SCHEME}`);
    await failed();
    expect(opened.calls).toStrictEqual([]);
  },
);

test("route replacement cancels consume and a late reply cannot activate Clerk or deliver IPC", async () => {
  const documents = navigation();
  const tokens = bridge();
  const requested = context.mocks.deferred<void>();
  const response = context.mocks.deferred<void>();
  let consumes = 0;
  context.mocks.api(desktopAuthConsumeContract.consume, async ({ respond }) => {
    consumes += 1;
    requested.resolve();
    await response.promise;
    return respond(200, { token: TICKET });
  });
  await page(`/desktop-auth/consume?code=${CODE}&handoffId=${HANDOFF}`, null);
  await requested.promise;
  // A repeated history event sees the scrubbed URL, so it cannot replay the code.
  fireEvent.popState(window);
  await failed();
  response.resolve();
  await response.promise;
  expect(consumes).toBe(1);
  expect(mockedClerk.clientSignInCreate).not.toHaveBeenCalled();
  expect(documents).toStrictEqual([]);
  expect(tokens).toStrictEqual([]);
});

test("cancellation after IPC starts discards its delayed acknowledgement", async () => {
  const documents = navigation();
  const pending = context.mocks.deferred<void>();
  const tokens = bridge(() => {
    return pending.promise;
  });
  let completions = 0;
  context.mocks.api(desktopAuthHandoffContract.complete, ({ respond }) => {
    completions += 1;
    return respond(200, { status: "completed" });
  });
  await page(`/desktop-auth/token?handoffId=${HANDOFF}`);
  await waitFor(() => {
    expect(tokens).toStrictEqual(["test-token"]);
  });
  await leaveDesktopAuthPage();
  pending.resolve();
  await pending.promise;
  expect(completions).toBe(0);
  expect(documents).toStrictEqual([]);
});

test("a required organization task stays in hosted auth with its Desktop callback", async () => {
  const destination = CALLBACK.replace(SCHEME, "ai.okou.desktop.dev");
  await setupPage({
    context,
    host: "app.okou.ai",
    path: `/sign-in/tasks/choose-organization?redirect_url=${encodeURIComponent(destination)}`,
    auth: null,
  });

  const signIn = await screen.findByTestId("clerk-sign-in");
  expect(location.pathname).toBe("/sign-in/tasks/choose-organization");
  expect(signIn).toHaveAttribute("data-clerk-force-redirect-url", destination);
  expect(mockedClerk.setActive).not.toHaveBeenCalled();
});

test("protocol errors, navigation and telemetry do not capture credentials", async () => {
  const documents = navigation();
  const analytics = context.mocks.posthog();
  const sentry = context.mocks.sentry();
  const logs: unknown[][] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args);
  });
  initSentry();
  context.mocks.api(desktopAuthConsumeContract.consume, ({ respond }) => {
    return respond(200, { token: TICKET });
  });
  context.mocks.clerk();
  mockedClerk.clientSignInCreate.mockRejectedValue(
    new Error(`${CODE} ${TICKET} private-jwt`),
  );
  await setupPage({
    context,
    host: "app.okou.ai",
    path: `/desktop-auth/consume?code=${CODE}`,
    auth: null,
    debugLoggers: ["*"],
  });
  await failed();
  expect(analytics.events).toStrictEqual([]);
  expect(documents).toStrictEqual([]);
  expect(JSON.stringify(logs)).not.toContain(CODE);
  expect(JSON.stringify(logs)).not.toContain(TICKET);
  expect(JSON.stringify(sentry.reports)).not.toContain(TICKET);
  const options = sentry.initializations.find(({ runtime }) => {
    return runtime === "page";
  })?.options;
  expect(
    options?.beforeBreadcrumb?.(
      {
        category: "navigation",
        data: { from: `/desktop-auth/consume?code=${CODE}`, to: "/" },
      },
      {},
    ),
  ).toBeNull();
  await expect(
    Promise.resolve(
      options?.beforeSend?.({ type: undefined, message: TICKET }, {}),
    ),
  ).resolves.toBeNull();
});

test("signed-out browser callback returns to hosted auth with the explicit scheme", async () => {
  const documents = navigation();
  await page(`/desktop-auth/callback?callbackScheme=${SCHEME}`, null);
  await waitFor(() => {
    expect(documents).toHaveLength(1);
  });
  expect(new URL(documents[0]!).searchParams.get("redirect_url")).toBe(
    CALLBACK,
  );
});

test("forced token selection preserves the native force transition even with an active workspace", async () => {
  const documents = navigation();
  const tokens = bridge();
  await page(
    `/desktop-auth/token?force=true&handoffId=${HANDOFF}`,
    signedIn(true),
  );
  await waitFor(() => {
    expect(documents).toStrictEqual([
      `https://app.okou.ai/desktop-auth/select-org?handoffId=${HANDOFF}&force=true`,
    ]);
  });
  expect(tokens).toStrictEqual([]);
});

test("non-forced workspace route reuses the active workspace", async () => {
  const documents = navigation();
  const tokens = bridge();
  await page("/desktop-auth/select-org", signedIn(true));
  await waitFor(() => {
    expect(documents).toStrictEqual(["/"]);
  });
  expect(tokens).toStrictEqual(["test-token"]);
});

test("workspace selection includes memberships beyond the first Clerk page", async () => {
  const memberships = Array.from({ length: 101 }, (_, i) => {
    return {
      id: `membership_${i}`,
      organization: { id: `org_${i}`, name: `Workspace ${i}` },
    };
  });
  await page(
    "/desktop-auth/select-org?force=true",
    signedIn(false, memberships),
  );
  await screen.findByRole("region", {
    description: "Choose a workspace for this computer.",
  });
  expect(button("Workspace 100")).toBeEnabled();
});

test("a cancelled ticket activation cannot navigate after the Clerk response arrives", async () => {
  const documents = navigation();
  const ticket = context.mocks.deferred<{
    status: string;
    createdSessionId: string;
  }>();
  const requested = context.mocks.deferred<void>();
  context.mocks.clerk();
  context.mocks.api(desktopAuthConsumeContract.consume, ({ respond }) => {
    return respond(200, { token: TICKET });
  });
  mockedClerk.clientSignInCreate.mockImplementation(() => {
    requested.resolve();
    return ticket.promise;
  });
  await page(`/desktop-auth/consume?code=${CODE}`, null);
  await requested.promise;
  await leaveDesktopAuthPage();
  ticket.resolve({ status: "complete", createdSessionId: "late-session" });
  await ticket.promise;
  expect(documents).toStrictEqual([]);
  expect(mockedClerk.setActive).not.toHaveBeenCalled();
});

test("cancelling a server completion request cannot publish late native success", async () => {
  const documents = navigation();
  bridge();
  const completion = context.mocks.deferred<void>();
  const requested = context.mocks.deferred<void>();
  context.mocks.api(
    desktopAuthHandoffContract.complete,
    async ({ respond }) => {
      requested.resolve();
      await completion.promise;
      return respond(200, { status: "completed" });
    },
  );
  await page(`/desktop-auth/token?handoffId=${HANDOFF}`);
  await requested.promise;
  await leaveDesktopAuthPage();
  completion.resolve();
  await completion.promise;
  expect(documents).toStrictEqual([]);
});

test("a delayed handoff-create response after cancellation never opens a native URL", async () => {
  const opened = context.mocks.browser.locationAssign();
  const handoff = context.mocks.deferred<void>();
  const requested = context.mocks.deferred<void>();
  context.mocks.api(desktopAuthHandoffContract.create, async ({ respond }) => {
    requested.resolve();
    await handoff.promise;
    return respond(200, {
      callbackUrl: `${SCHEME}://auth/callback?code=${CODE}&handoffId=${HANDOFF}`,
      handoffId: HANDOFF,
    });
  });
  await page(`/desktop-auth/callback?callbackScheme=${SCHEME}`);
  await requested.promise;
  await leaveDesktopAuthPage();
  handoff.resolve();
  await handoff.promise;
  expect(opened.calls).toStrictEqual([]);
});

test("forced workspace selection survives a required session task", async () => {
  const documents = navigation();
  const tokens = bridge();
  await page(`/desktop-auth/token?force=true&handoffId=${HANDOFF}`, {
    user: {
      id: "pending-user",
      fullName: "Pending User",
      clientSessions: [
        { id: "pending", status: "pending", currentTask: { key: "setup-mfa" } },
      ],
    },
    organization: {
      activeOrg: { id: "org_alpha", name: "Alpha" },
      memberships: [alpha, beta],
    },
  });
  await waitFor(() => {
    expect(documents).toHaveLength(1);
  });
  const task = new URL(documents[0]!);
  expect(task.pathname).toBe("/sign-in/tasks/setup-mfa");
  expect(task.searchParams.get("redirect_url")).toBe(
    `https://app.okou.ai/desktop-auth/token?handoffId=${HANDOFF}&force=true`,
  );
  expect(tokens).toStrictEqual([]);
});

test("Desktop hosted auth continuation works without URL.canParse", async () => {
  class BrowserURL extends URL {}
  Object.defineProperty(BrowserURL, "canParse", { value: undefined });
  vi.stubGlobal("URL", BrowserURL);
  await setupPage({
    context,
    host: "app.okou.ai",
    path: `/sign-in?redirect_url=${encodeURIComponent(CALLBACK)}`,
    auth: null,
  });
  const signIn = await screen.findByTestId("clerk-sign-in");
  expect(signIn).toHaveAttribute("data-clerk-force-redirect-url", CALLBACK);
});
