import { screen, act, cleanup, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { setupPage, startPage } from "../../../__tests__/page-helper.ts";
import {
  testContext,
  createTestRuntime,
} from "../../../signals/__tests__/test-helpers.ts";
import { friendReferralsContract } from "@okouai/api-contracts/contracts/friend-referrals";
import { installPlatformLifecycle } from "../../../test/platform-lifecycle.ts";
import { mockedClerkLoad } from "../../../__tests__/mock-auth.ts";
import { inspect } from "node:util";
import { findFastControl } from "../../okou-page/__tests__/chat-message-experience-test-helpers.ts";
import {
  statusService,
  harbor,
} from "../../okou-page/__tests__/discord-consent-fixtures.ts";

const context = testContext();

test("A nested sign-in route retains its state on the canonical Okou app", async () => {
  const returnUrl = "https://app.okou.ai/agents";
  const search = new URLSearchParams({
    __clerk_status: "verified",
    redirect_url: returnUrl,
  });
  const path = `/sign-in/factor-one?${search}#second-factor`;

  await setupPage({ context, path, host: "app.okou.ai", auth: null });

  await expect(screen.findByTestId("app-sign-in")).resolves.toBeVisible();
  const signIn = screen.getByTestId("clerk-sign-in");
  expect(signIn).toHaveAttribute("data-clerk-force-redirect-url", returnUrl);
  expect(window.location.href).toBe(`https://app.okou.ai${path}`);
  expect(new URL(window.location.href).searchParams.get("redirect_url")).toBe(
    returnUrl,
  );
});

const appHost = "app.okou.ai";
const signature = "f".repeat(64);
async function visit(path: string) {
  await setupPage({ context, host: appHost, path, auth: null });
}
async function clerkChooses(url: string) {
  const push = mockedClerkLoad.mock.lastCall?.[0]?.routerPush;
  if (!push) {
    throw new Error("Clerk did not receive a routing callback");
  }
  const documentNavigation = vi.fn<(target: string | URL) => void>();
  await act(async () => {
    await push(url, { windowNavigate: documentNavigation });
  });
  return documentNavigation;
}
function formDestination(form: HTMLElement) {
  const value = form.dataset.clerkForceRedirectUrl;
  expect(value).toBeTruthy();
  return new URL(value!);
}
test.each([
  [
    "integration-continuation-016",
    "/settings/email",
    "message=inbox-fixture&expires=2080000000&signature=" +
      signature +
      "&message=followup",
    "#thread",
  ],
  [
    "integration-continuation-017",
    "/settings/agentphone",
    "handle=%2B12025550101&agent=agent-local&ts=1810000000&sig=" +
      signature +
      "&channel=sms&channel=voice",
    "#account",
  ],
  [
    "integration-continuation-018",
    "/connectors/slack/callback",
    "integration=slack&status=connected&team=TLOCAL&team=TSECOND",
    "#installation",
  ],
  [
    "integration-continuation-023",
    "/SetTings/TeleGram/",
    "tgUser=12345&bot=67890&ts=1810000000&sig=" +
      signature +
      "&tgUserName=localuser",
    "#telegram",
  ],
] as const)(
  "%s Signing up from a protected %s link preserves its complete public return address",
  async (_id, path, query, hash) => {
    const entry = path + "?" + query + hash;
    const departure = createTestRuntime(context);
    installPlatformLifecycle(departure.signal);
    await startPage({
      context: departure,
      host: appHost,
      path: entry,
      auth: null,
    });
    await waitFor(() => {
      return expect(location.pathname).toBe("/sign-in");
    });
    const address = location.href;
    cleanup();
    vi.mocked(history.replaceState).mockRestore();
    departure.dispose();
    const arrival = createTestRuntime(context);
    installPlatformLifecycle(arrival.signal);
    await setupPage({
      context: arrival,
      path: address,
      host: appHost,
      auth: null,
    });
    const signIn = await screen.findByTestId("clerk-sign-in");
    const expected = new URL(entry, "https://" + appHost);
    expect(formDestination(signIn).href).toBe(expected.href);
    const switchUrl = signIn.dataset.clerkSignUpUrl;
    expect(switchUrl).toBeTruthy();
    expect(new URL(switchUrl!, location.origin).pathname).toBe("/sign-up");
    await clerkChooses(switchUrl!);
    const signUp = await screen.findByTestId("clerk-sign-up");
    expect(formDestination(signUp).href).toBe(expected.href);
    expect(location.pathname).toBe("/sign-up");
  },
);
test("auth-v1-page-007 Clerk's password step and browser Back preserve both strategy parameters and each fragment", async () => {
  await visit("/sign-in?screen=identifier#start");
  await screen.findByTestId("clerk-sign-in");
  const assign = context.mocks.browser.locationAssign();
  const external = await clerkChooses(
    "/sign-in/factor-one?strategy=password&strategy=passkey#challenge",
  );
  expect(location.pathname).toBe("/sign-in/factor-one");
  expect(new URLSearchParams(location.search).getAll("strategy")).toStrictEqual(
    ["password", "passkey"],
  );
  expect(location.hash).toBe("#challenge");
  expect(screen.getByTestId("clerk-sign-in")).toBeInTheDocument();
  expect(assign.calls).toStrictEqual([]);
  expect(external).not.toHaveBeenCalled();
  act(() => {
    return history.back();
  });
  await waitFor(() => {
    return expect(location.pathname + location.search + location.hash).toBe(
      "/sign-in?screen=identifier#start",
    );
  });
  expect(screen.getByTestId("clerk-sign-in")).toBeInTheDocument();
});
const referral = "__Secure-okou-friend-referral-visit";
test("auth-v1-page-001 An unavailable invitation still opens branded sign-up", async () => {
  const lookedUp = context.mocks.deferred<string>();
  context.mocks.api(friendReferralsContract.visit, ({ body, respond }) => {
    lookedUp.resolve(body.code);
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Invitation no longer active" },
    });
  });
  await visit("/sign-up?friend_referral=A7K2P9");
  await expect(lookedUp.promise).resolves.toBe("a7k2p9");
  await expect(screen.findByTestId("clerk-sign-up")).resolves.toBeVisible();
  expect(document.title).toBe("Sign up | Okou");
});
test("auth-v1-page-002 Signup retains the return link while setting a secure host-only invitation cookie for thirty days", async () => {
  const destination = "https://app.okou.ai/onboarding?source=friend";
  const returned = "signed-local-visit-A7";
  const store = vi.spyOn(document, "cookie", "set");
  const code = context.mocks.deferred<string>();
  context.mocks.api(friendReferralsContract.visit, ({ respond, body }) => {
    code.resolve(body.code);
    return respond(200, { token: returned });
  });
  await visit(
    "/sign-up?friend_referral=A7K2P9&redirect_url=" +
      encodeURIComponent(destination) +
      "#start",
  );
  await expect(code.promise).resolves.toBe("a7k2p9");
  const form = await screen.findByTestId("clerk-sign-up");
  expect(formDestination(form).href).toBe(destination);
  const raw = store.mock.calls
    .map(([value]) => {
      return value;
    })
    .find((x) => {
      return x.startsWith(referral + "=" + returned);
    });
  expect(raw).toBeDefined();
  const attributes = raw!.split(";").map((s) => {
    return s.trim().toLowerCase();
  });
  expect(attributes).toStrictEqual(
    expect.arrayContaining([
      "path=/",
      "max-age=2592000",
      "samesite=lax",
      "secure",
    ]),
  );
  expect(
    attributes.some((a) => {
      return a.startsWith("domain=");
    }),
  ).toBeFalsy();
  expect(document.cookie).toContain(referral + "=" + returned);
  expect(
    new URLSearchParams(location.search).get("friend_referral"),
  ).toBeNull();
  expect(new URLSearchParams(location.search).get("redirect_url")).toBe(
    destination,
  );
  expect(location.hash).toBe("#start");
});
test.each([
  ["auth-v1-page-003", "registered"],
  ["auth-v1-page-004", "ineligible"],
] as const)(
  "%s The invitation survives Clerk verification and is consumed on the authenticated %s result",
  async (_id, status) => {
    const signed = "signed-visit-" + status;
    const hold = context.mocks.deferred<void>(),
      submission = context.mocks.deferred<string>();
    context.mocks.api(friendReferralsContract.visit, ({ respond }) => {
      return respond(200, { token: signed });
    });
    context.mocks.api(
      friendReferralsContract.register,
      async ({ body, respond }) => {
        if (!submission.settled()) {
          submission.resolve(body.token);
        }
        await hold.promise;
        return respond(200, { status });
      },
    );
    const initial = createTestRuntime(context);
    installPlatformLifecycle(initial.signal);
    await setupPage({
      context: initial,
      host: appHost,
      path: "/sign-up?friend_referral=A7K2P9",
      auth: null,
    });
    await screen.findByTestId("clerk-sign-up");
    await clerkChooses("/sign-up/verify-email-address");
    await waitFor(() => {
      return expect(location.pathname).toBe("/sign-up/verify-email-address");
    });
    expect(document.cookie).toContain(referral + "=" + signed);
    cleanup();
    vi.mocked(history.replaceState).mockRestore();
    initial.dispose();
    const authenticated = createTestRuntime(context);
    installPlatformLifecycle(authenticated.signal);
    try {
      const app = await startPage({
        context: authenticated,
        host: appHost,
        path: "/",
      });
      await expect(submission.promise).resolves.toBe(signed);
      expect(document.cookie).toContain(referral + "=" + signed);
      hold.resolve();
      await app.ready;
      await waitFor(() => {
        return expect(document.cookie).not.toContain(referral + "=");
      });
    } finally {
      if (!hold.settled()) {
        hold.resolve();
      }
    }
  },
);
test("auth-v1-page-005 Hosted sign-in exposes both Clerk return targets, One Tap, branding and its loaded UI", async () => {
  context.mocks.browser.matchMedia((q) => {
    return q.includes("min-width");
  });
  const sdk = context.mocks.clerk();
  await visit("/sign-in");
  const form = await screen.findByTestId("clerk-sign-in"),
    tap = await screen.findByTestId("clerk-google-one-tap");
  expect(form).toBeVisible();
  expect(form.dataset.clerkSignInUrl).toBe("/sign-in");
  expect(form.dataset.clerkSignUpUrl).toBe("/sign-up");
  expect(formDestination(form).href).toBe("https://app.okou.ai/");
  expect(tap).toHaveAttribute(
    "data-sign-in-force-redirect-url",
    "https://app.okou.ai",
  );
  expect(tap).toHaveAttribute(
    "data-sign-up-force-redirect-url",
    "https://app.okou.ai",
  );
  expect(screen.getByAltText("Okou")).toBeVisible();
  expect(document.title).toBe("Sign in | Okou");
  expect(document.getElementById("app-bootstrap-skeleton")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  expect(
    sdk.uiRequests.some((src) => {
      return src.includes("clerk");
    }),
  ).toBeTruthy();
});

const guild = "1000000000000045312",
  state = "D".repeat(43),
  proof = "P".repeat(43);
const pending = "/settings/discord?status=pending&guild_id=" + guild;
const entry =
  pending +
  "#" +
  new URLSearchParams({
    discord_oauth: "approve",
    state,
    approval_proof: proof,
  });
function browserRecords() {
  const messages: unknown[][] = [];
  for (const level of [
    "log",
    "info",
    "debug",
    "warn",
    "error",
    "trace",
    "table",
    "group",
    "groupCollapsed",
  ] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      messages.push(args);
    });
  }
  const storage = vi.spyOn(Storage.prototype, "setItem");
  return () => {
    return inspect(
      [
        messages,
        storage.mock.calls,
        Object.entries(localStorage),
        Object.entries(sessionStorage),
      ],
      { depth: null },
    );
  };
}
test.each([
  ["integration-continuation-034", "/sign-in"],
  ["integration-continuation-036", "/sign-in/tasks/choose-organization"],
] as const)(
  "%s Discord preserves only public callback context when routing to %s",
  async (_id, destination) => {
    const records = browserRecords();
    const auth =
      destination === "/sign-in"
        ? null
        : {
            user: { id: "visiting-member", fullName: "Studio member" },
            organization: {
              activeOrg: null,
              memberships: [{ id: "org_studio" }, { id: "org_guest" }],
            },
          };
    await startPage({ context, host: "app.okou.ai", path: entry, auth });
    await waitFor(() => {
      return expect(location.pathname).toBe(destination);
    });
    const outer = new URL(location.href);
    const back = outer.searchParams.get("redirect_url");
    expect(back).toBeTruthy();
    const target = new URL(back!);
    expect(target.origin).toBe("https://app.okou.ai");
    expect(target.pathname + target.search).toBe(pending);
    expect(target.hash).toBe("");
    expect(outer.href).not.toContain(proof);
    expect(outer.hash).toBe("");
    expect(records()).not.toContain(proof);
  },
);
test("integration-continuation-038 A replacement user opening the sanitized callback sees the interrupted result and can return to Works", async () => {
  const leaving = createTestRuntime(context);
  installPlatformLifecycle(leaving.signal);
  await startPage({
    context: leaving,
    host: "app.okou.ai",
    auth: null,
    path: entry,
  });
  await waitFor(() => {
    return expect(location.pathname).toBe("/sign-in");
  });
  const redirect = new URL(location.href).searchParams.get("redirect_url");
  expect(redirect).toBeTruthy();
  cleanup();
  vi.mocked(history.replaceState).mockRestore();
  leaving.dispose();
  const replacement = createTestRuntime(context);
  installPlatformLifecycle(replacement.signal);
  statusService(replacement, () => {
    return { isAvailable: true, isConnected: false };
  });
  await setupPage({
    context: replacement,
    host: "app.okou.ai",
    auth: harbor.auth,
    path: redirect!,
  });
  await screen.findByText("Connection failed");
  await screen.findByText("This authorization was interrupted or refreshed.");
  await expect(
    findFastControl("link", "Back to settings"),
  ).resolves.toHaveAttribute("href", "/works");
  expect(location.hash).toBe("");
});
