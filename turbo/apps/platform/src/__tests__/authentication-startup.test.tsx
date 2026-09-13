import { screen } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";

import { mockedClerk } from "./mock-auth.ts";
import { queryAllByRoleFast, setupPage, startPage } from "./page-helper.ts";
import frFRCommon from "../i18n/locales/fr-FR/common.json";
import frFRCommonUrl from "../i18n/locales/fr-FR/common.json?url";
import { testContext } from "../signals/__tests__/test-helpers.ts";
import { createChildAbortController } from "../signals/utils.ts";

const context = testContext();

const PRIMARY_LOAD_OPTIONS = {
  afterSignOutUrl: "https://app.okou.ai/sign-in",
  signInUrl: "https://app.okou.ai/sign-in",
  signUpUrl: "https://app.okou.ai/sign-up",
} as const;

async function waitForReadySignIn(): Promise<void> {
  await expect(screen.findByTestId("clerk-sign-in")).resolves.toBeVisible();
}

function installEarlyBootstrap(options: {
  readonly clerk?: typeof mockedClerk;
  readonly loaded?: Promise<void>;
}): void {
  context.mocks.clerk();
  const originalBootstrap = window.__okouClerkBootstrap;
  const originalClerk = Reflect.get(globalThis, "Clerk");
  Reflect.set(globalThis, "Clerk", options.clerk ?? mockedClerk);
  const bootstrap: NonNullable<Window["__okouClerkBootstrap"]> = {
    loadOptions: PRIMARY_LOAD_OPTIONS,
    loaded: options.loaded,
    publishableKey: "test_production_key",
    resolveClerkUI: () => {
      return;
    },
  };
  if (options.clerk) {
    Reflect.set(bootstrap, "clerk", options.clerk);
  }
  window.__okouClerkBootstrap = bootstrap;
  context.signal.addEventListener(
    "abort",
    () => {
      if (originalBootstrap) {
        window.__okouClerkBootstrap = originalBootstrap;
      } else {
        Reflect.deleteProperty(window, "__okouClerkBootstrap");
      }
      if (originalClerk) {
        Reflect.set(globalThis, "Clerk", originalClerk);
      } else {
        Reflect.deleteProperty(globalThis, "Clerk");
      }
    },
    { once: true },
  );
}

test("Authentication is ready before Platform content becomes interactive", async () => {
  const clerkLoad = context.mocks.clerk().runtimePending();

  const pageReady = setupPage({
    context,
    host: "app.okou.ai",
    path: "/agents",
  });

  const skeleton = await screen.findByTestId("app-skeleton");
  expect(skeleton).toBeVisible();
  expect(screen.queryByRole("heading", { name: "Agents" })).toBeNull();
  expect(queryAllByRoleFast("link")).toHaveLength(0);

  clerkLoad.resolve();
  await pageReady;

  expect(skeleton).toHaveAttribute("aria-hidden", "true");
  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByTestId("clerk-sign-in")).not.toBeInTheDocument();
  expect(queryAllByRoleFast("link").length).toBeGreaterThan(0);
});

test("The SharedWorker owns realtime", async () => {
  await setupPage({
    context,
    host: "app.okou.ai",
    path: "/agents",
    sharedWorkerTestTransport: "message-port",
  });

  await screen.findByRole("heading", { name: "Agents" });
  await vi.waitFor(() => {
    expect(
      context.mocks.ably.hasSubscriptionOnChannel(
        "user:test-user-123",
        "connectorPermissionUpdated",
      ),
    ).toBeTruthy();
  });
  expect(context.mocks.ably.getAuthTokenHistory()).toHaveLength(1);
});

test.each(["setupPage", "startPage"])(
  "%s does not report cancelled authentication startup as ready",
  async (entryPoint) => {
    const clerkLoad = context.mocks.clerk().runtimePending();
    // eslint-disable-next-line ccstate/no-create-child-abort-controller -- migrate this lifetime to the ccstate signal hierarchy
    const controller = createChildAbortController(context.signal);
    const options = {
      context: {
        ...context,
        signal: controller.signal,
      },
      host: "app.okou.ai",
      path: "/agents",
    };
    const pageReady =
      entryPoint === "setupPage"
        ? setupPage(options)
        : (await startPage(options)).ready;

    const skeleton = await screen.findByTestId("app-skeleton");
    expect(skeleton).toBeVisible();
    const reason = new DOMException("Page startup cancelled", "AbortError");
    controller.abort(reason);
    clerkLoad.resolve();
    await expect(pageReady).rejects.toBe(reason);

    expect(screen.queryByRole("heading", { name: "Agents" })).toBeNull();
    expect(skeleton).not.toBeInTheDocument();
  },
);

test("Cancelled locale startup does not adopt a replacement lifetime", async () => {
  const localeRequested = context.mocks.deferred<Request>();
  const localeResponse = context.mocks.deferred<void>();
  context.mocks.http.get(frFRCommonUrl, async ({ request }) => {
    localeRequested.resolve(request);
    await localeResponse.promise;
    return HttpResponse.json(frFRCommon);
  });
  // eslint-disable-next-line ccstate/no-create-child-abort-controller -- migrate this lifetime to the ccstate signal hierarchy
  const controller = createChildAbortController(context.signal);
  let currentSignal = controller.signal;
  const startup = startPage({
    context: {
      ...context,
      get signal() {
        return currentSignal;
      },
    },
    host: "app.okou.ai",
    path: "/agents",
    locale: "fr-FR",
  });
  const request = await localeRequested.promise;
  const reason = new DOMException("Locale startup cancelled", "AbortError");
  controller.abort(reason);
  // Model testContext replacing its lifetime while old startup is suspended.
  currentSignal = context.signal;
  localeResponse.resolve();
  await expect(startup).rejects.toBe(reason);

  expect(request.signal.aborted).toBeTruthy();
  expect(screen.queryByTestId("app-skeleton")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "Agents" }),
  ).not.toBeInTheDocument();
});

test("Authentication startup is reused without a duplicate load", async () => {
  const clerk = context.mocks.clerk();
  const clerkLoad = clerk.runtimePending();
  const loaded = mockedClerk.load(PRIMARY_LOAD_OPTIONS);
  installEarlyBootstrap({ clerk: mockedClerk, loaded });

  const pageReady = setupPage({
    context,
    host: "app.okou.ai",
    path: "/agents",
  });

  await screen.findByTestId("app-skeleton");
  expect(clerk.resourceRequests).toStrictEqual([]);
  expect(clerk.loads).toHaveLength(1);

  clerkLoad.resolve();
  await pageReady;

  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeInTheDocument();
  expect(clerk.loads).toHaveLength(1);
  expect(clerk.uiRequests).toStrictEqual([]);
});

test("Authentication startup retries after an early failure", async () => {
  const clerk = context.mocks.clerk();
  installEarlyBootstrap({});

  await setupPage({
    context,
    host: "app.okou.ai",
    path: "/sign-in",
    auth: null,
  });

  await waitForReadySignIn();
  expect(clerk.resourceRequests).toStrictEqual([]);
  expect(clerk.loads).toHaveLength(1);
  expect(clerk.uiRequests).toStrictEqual([
    "https://app.example.test/assets/clerk-ui-test.js",
  ]);
  expect(window.__okouClerkBootstrap?.loaded).toBeUndefined();
});

test("Startup onboarding follows the current account and workspace", async () => {
  const statusRequested = context.mocks.deferred<void>();
  const statusReady = context.mocks.deferred<void>();
  let currentIdentityRequests = 0;
  context.mocks.http.get("*/api/onboarding/status", async () => {
    currentIdentityRequests += 1;
    statusRequested.resolve();
    await statusReady.promise;
    return HttpResponse.json({
      defaultAgentId: null,
      defaultAgentMetadata: null,
      hasDefaultAgent: true,
      hasOrg: true,
      isAdmin: true,
      needsOnboarding: true,
      onboardingComplete: false,
    });
  });
  const clerk = context.mocks.clerk();
  const pageReady = setupPage({
    context,
    host: "app.okou.ai",
    path: "/agents",
  });
  await statusRequested.promise;

  clerk.organization({
    activeOrg: { id: "org_current", name: "Current workspace" },
    memberships: [{ id: "org_current" }],
  });
  statusReady.resolve();
  await pageReady;

  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeInTheDocument();
  expect(currentIdentityRequests).toBe(1);
  expect(
    screen.queryByRole("heading", { name: "What do you want to make first" }),
  ).not.toBeInTheDocument();
});

test("Okou production uses production authentication", async () => {
  const clerk = context.mocks.clerk();
  await setupPage({
    context,
    host: "app.okou.ai",
    path: "/sign-in",
    auth: null,
  });

  await waitForReadySignIn();
  expect(clerk.resourceRequests).toStrictEqual([
    { publishableKey: "test_production_key" },
  ]);
  expect(clerk.loads).toContainEqual(PRIMARY_LOAD_OPTIONS);
  expect(clerk.uiRequests).toStrictEqual([
    "https://app.example.test/assets/clerk-ui-test.js",
  ]);
  expect(screen.getByTestId("clerk-sign-in")).toHaveTextContent("/sign-in");
});

test("Authorized preview hosts use preview authentication", async () => {
  const clerk = context.mocks.clerk();
  await setupPage({
    context,
    host: "pr-30199-app.omby.ai",
    path: "/sign-in",
    auth: null,
  });
  await waitForReadySignIn();
  expect(clerk.resourceRequests).toStrictEqual([
    { publishableKey: "test_preview_key" },
  ]);
});

test.each(["okou.ai.evil.example", "app.okou.ai.evil.example"])(
  "Okou lookalike host %s does not use production authentication",
  async (host) => {
    const clerk = context.mocks.clerk();
    await setupPage({
      context,
      host,
      path: "/sign-in",
      auth: null,
    });
    await waitForReadySignIn();
    expect(clerk.resourceRequests).toStrictEqual([
      { publishableKey: "test_preview_key" },
    ]);
  },
);
