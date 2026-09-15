import { act, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { PRESENTATION_ONBOARDING_URL } from "../../../__tests__/presentation-onboarding-fixture.ts";
import {
  click,
  queryAllByRoleFast,
  setupPage,
  startPage,
} from "../../../__tests__/page-helper.ts";
import { platformOkouWordmarkDarkImg } from "../../../lib/static-assets.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function setupSignedOutPage(path: string): Promise<void> {
  return setupPage({ auth: null, context, host: "app.okou.ai", path });
}

function okouBrandLink(): HTMLElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.getAttribute("aria-label") === "Go to Okou home";
  });
  if (!link) {
    throw new Error("Okou brand link not found");
  }
  return link;
}

function clerkProviderConfig(): HTMLElement {
  return screen.getByTestId("clerk-provider-config");
}

function registeredClerkRouter(): NonNullable<Window["__okouClerkRouter"]> {
  const router = window.__okouClerkRouter;
  if (!router) {
    throw new Error("Clerk router is not registered");
  }
  return router;
}

function clerkWindowNavigation() {
  return {
    windowNavigate(to: URL | string) {
      window.location.assign(to);
    },
  };
}

test("The hosted sign-in form renders with Google One Tap on the base route", async () => {
  context.mocks.browser.matchMedia(false);
  const clerk = context.mocks.clerk();
  await setupSignedOutPage("/sign-in");

  const signIn = screen.getByTestId("clerk-sign-in");
  expect(signIn).toHaveAttribute("data-clerk-routing", "path");
  expect(signIn).toHaveTextContent("/sign-in");
  expect(signIn).toHaveAttribute("data-clerk-sign-in-url", "/sign-in");
  expect(signIn).toHaveAttribute("data-clerk-sign-up-url", "/sign-up");
  expect(signIn).toHaveAttribute(
    "data-clerk-force-redirect-url",
    "https://app.okou.ai",
  );
  expect(screen.getByTestId("clerk-google-one-tap")).toHaveAttribute(
    "data-sign-in-force-redirect-url",
    "https://app.okou.ai",
  );
  expect(screen.getByTestId("clerk-google-one-tap")).toHaveAttribute(
    "data-sign-up-force-redirect-url",
    "https://app.okou.ai",
  );
  expect(screen.getByAltText("Okou")).toHaveAttribute(
    "src",
    platformOkouWordmarkDarkImg,
  );
  expect(document.title).toBe("Sign in | Okou");
  expect(clerk.uiRequests).toStrictEqual([
    "https://app.example.test/assets/clerk-ui-test.js",
  ]);
  expect(screen.getByTestId("app-skeleton")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  // The runtime registers the router at `clerk.load()`, so the app-level
  // provider does not redeclare it. `clerk-bootstrap.test.ts` covers that.
  expect(
    document.querySelector("[data-auth-v1-legacy-clerk-css]"),
  ).not.toBeInTheDocument();
});

test("Nested sign-in task paths stay on the hosted sign-in form", async () => {
  await setupSignedOutPage("/sign-in/tasks/choose-organization");

  expect(screen.getByTestId("clerk-sign-in")).toHaveTextContent("/sign-in");
  expect(screen.queryByTestId("clerk-google-one-tap")).not.toBeInTheDocument();
  expect(document.title).toBe("Sign in | Okou");
});

test("Clerk sign-in steps use app history and keep every query value", async () => {
  const assigned = context.mocks.browser.locationAssign();
  await setupSignedOutPage("/sign-in?screen=identifier#start");

  await registeredClerkRouter().push(
    "/sign-in/factor-one?strategy=password&strategy=passkey#challenge",
    clerkWindowNavigation(),
  );

  await waitFor(() => {
    expect(window.location.pathname).toBe("/sign-in/factor-one");
  });
  expect(
    new URLSearchParams(window.location.search).getAll("strategy"),
  ).toStrictEqual(["password", "passkey"]);
  expect(window.location.hash).toBe("#challenge");
  expect(assigned.calls).toStrictEqual([]);
  expect(screen.getByTestId("clerk-sign-in")).toBeVisible();

  window.history.back();
  await waitFor(() => {
    expect(window.location.pathname).toBe("/sign-in");
  });
  expect(window.location.search).toBe("?screen=identifier");
  expect(window.location.hash).toBe("#start");
});

test("Clerk sign-in replacements keep the current app history entry", async () => {
  const assigned = context.mocks.browser.locationAssign();
  const replaced = context.mocks.browser.locationReplace();
  await setupSignedOutPage("/sign-in/factor-one?strategy=password#challenge");

  await registeredClerkRouter().replace(
    "/sign-in?screen=identifier#start",
    clerkWindowNavigation(),
  );

  await waitFor(() => {
    expect(window.location.pathname).toBe("/sign-in");
  });
  expect(window.location.search).toBe("?screen=identifier");
  expect(window.location.hash).toBe("#start");
  expect(assigned.calls).toStrictEqual([]);
  expect(replaced.calls).toStrictEqual([]);

  window.history.back();
  expect(window.location.pathname).toBe("/sign-in");
  expect(window.location.search).toBe("?screen=identifier");
  expect(window.location.hash).toBe("#start");
});

test("Clerk sign-up steps stay on the hosted app page", async () => {
  const assigned = context.mocks.browser.locationAssign();
  await setupSignedOutPage("/sign-up?screen=identifier#start");

  await registeredClerkRouter().push(
    "/sign-up/verify?strategy=email_code#challenge",
    clerkWindowNavigation(),
  );

  await waitFor(() => {
    expect(window.location.pathname).toBe("/sign-up/verify");
  });
  expect(window.location.search).toBe("?strategy=email_code");
  expect(window.location.hash).toBe("#challenge");
  expect(assigned.calls).toStrictEqual([]);
  expect(screen.getByTestId("clerk-sign-up")).toBeVisible();
});

test.each(["/", "/sign-in-token", "/sign-invader", "/v1/sign-in"])(
  "Clerk navigation to non-Auth V1 path %s loads a new document",
  async (destination) => {
    const assigned = context.mocks.browser.locationAssign();
    await setupSignedOutPage("/sign-in");

    await registeredClerkRouter().push(destination, clerkWindowNavigation());

    expect(assigned.calls).toStrictEqual([
      new URL(destination, "https://app.okou.ai").href,
    ]);
    expect(window.location.pathname).toBe("/sign-in");
  },
);

test("Clerk replacements outside Auth V1 load a new document", async () => {
  const assigned = context.mocks.browser.locationAssign();
  const replaced = context.mocks.browser.locationReplace();
  await setupSignedOutPage("/sign-in/factor-one");

  await registeredClerkRouter().replace(
    "/onboarding?source=clerk#complete",
    clerkWindowNavigation(),
  );

  expect(replaced.calls).toStrictEqual([
    "https://app.okou.ai/onboarding?source=clerk#complete",
  ]);
  expect(assigned.calls).toStrictEqual([]);
  expect(window.location.pathname).toBe("/sign-in/factor-one");
});

test("Clerk cross-origin navigation stays browser-owned", async () => {
  const assigned = context.mocks.browser.locationAssign();
  await setupSignedOutPage("/sign-in");

  await registeredClerkRouter().push(
    "https://www.okou.ai/sign-in?locale=ja-JP",
    clerkWindowNavigation(),
  );

  expect(assigned.calls).toStrictEqual([
    "https://www.okou.ai/sign-in?locale=ja-JP",
  ]);
  expect(window.location.pathname).toBe("/sign-in");
});

test("The hosted sign-up form renders with an allowed redirect URL", async () => {
  const redirectUrl = PRESENTATION_ONBOARDING_URL;
  await setupSignedOutPage(
    `/sign-up?redirect_url=${encodeURIComponent(redirectUrl)}`,
  );

  const signUp = screen.getByTestId("clerk-sign-up");
  expect(signUp).toHaveAttribute("data-clerk-routing", "path");
  expect(signUp).toHaveTextContent("/sign-up");
  const signInUrl = new URL(
    signUp.dataset.clerkSignInUrl ?? "",
    location.origin,
  );
  expect(signInUrl.pathname).toBe("/sign-in");
  expect(signInUrl.searchParams.get("redirect_url")).toBe(redirectUrl);
  expect(signUp).not.toHaveAttribute("data-clerk-sign-up-url");
  expect(signUp).toHaveAttribute(
    "data-clerk-fallback-redirect-url",
    redirectUrl,
  );
  expect(signUp).toHaveAttribute("data-clerk-force-redirect-url", redirectUrl);
  expect(screen.queryByTestId("clerk-google-one-tap")).not.toBeInTheDocument();
  expect(document.title).toBe("Sign up | Okou");
  expect(clerkProviderConfig()).toHaveAttribute(
    "data-clerk-sign-in-start-action-link",
    "Sign up",
  );
  expect(clerkProviderConfig()).toHaveAttribute(
    "data-clerk-provider-sign-in-url",
    "https://app.okou.ai/sign-in",
  );
  expect(clerkProviderConfig()).toHaveAttribute(
    "data-clerk-provider-sign-up-url",
    "https://app.okou.ai/sign-up",
  );
  expect(
    document.querySelector("[data-auth-v1-legacy-clerk-css]"),
  ).not.toBeInTheDocument();
});

test("Clerk's public fallback takes over after core initialization", async () => {
  const clerk = context.mocks.clerk();
  const clerkLoad = clerk.runtimePending();
  const authComponent = clerk.deferAuthComponentMount();

  const page = await startPage({
    auth: null,
    context,
    host: "app.okou.ai",
    path: "/sign-up",
  });

  const appSkeleton = await screen.findByTestId("app-skeleton");
  expect(appSkeleton).not.toHaveAttribute("aria-hidden");
  expect(screen.queryByTestId("clerk-sign-up")).not.toBeInTheDocument();

  await act(async () => {
    clerkLoad.resolve();
    await clerkLoad.promise;
  });

  await expect(
    screen.findByTestId("clerk-auth-loading"),
  ).resolves.toBeVisible();
  await page.ready;
  expect(appSkeleton).toHaveAttribute("aria-hidden", "true");
  expect(screen.getByTestId("clerk-sign-up")).toBeEmptyDOMElement();

  act(() => {
    authComponent.mount();
  });

  expect(screen.getByTestId("clerk-sign-up")).toHaveTextContent("/sign-up");
  expect(screen.queryByTestId("clerk-auth-loading")).not.toBeInTheDocument();
});

test("A trusted Okou destination brands the hosted sign-in", async () => {
  context.mocks.browser.matchMedia(false);
  const redirectUrl = "https://app.okou.ai/_/skeleton";
  await setupSignedOutPage(
    `/sign-in?redirect_url=${encodeURIComponent(redirectUrl)}`,
  );

  const signIn = screen.getByTestId("clerk-sign-in");
  expect(signIn).toHaveAttribute("data-clerk-force-redirect-url", redirectUrl);
  const signUpUrl = new URL(
    signIn.dataset.clerkSignUpUrl ?? "",
    location.origin,
  );
  expect(signUpUrl.pathname).toBe("/sign-up");
  expect(signUpUrl.searchParams.get("redirect_url")).toBe(redirectUrl);
  expect(screen.getByTestId("clerk-google-one-tap")).toHaveAttribute(
    "data-sign-in-force-redirect-url",
    redirectUrl,
  );
  expect(document.title).toBe("Sign in | Okou");
  expect(okouBrandLink()).toHaveAttribute("href", "/");
});

test("Okou auth intent survives Clerk moving the redirect into the hash", async () => {
  const redirectUrl = "https://app.okou.ai/onboarding?source=auth-switch";
  await setupSignedOutPage(
    `/sign-up#/?redirect_url=${encodeURIComponent(redirectUrl)}`,
  );

  const signUp = screen.getByTestId("clerk-sign-up");
  expect(signUp).toHaveAttribute("data-clerk-force-redirect-url", redirectUrl);
  expect(signUp.dataset.clerkSignInUrl).toContain(
    `redirect_url=${encodeURIComponent(redirectUrl)}`,
  );
  expect(document.title).toBe("Sign up | Okou");
  expect(okouBrandLink()).toHaveAttribute("href", "/");
});

test("An untrusted redirect URL does not control the auth brand", async () => {
  context.mocks.browser.matchMedia(false);
  const redirectUrl = "https://app.okou.ai.evil.example/sign-in";
  await setupSignedOutPage(
    `/sign-in?redirect_url=${encodeURIComponent(redirectUrl)}`,
  );

  expect(screen.getByTestId("clerk-sign-in")).toHaveAttribute(
    "data-clerk-force-redirect-url",
    "https://app.okou.ai",
  );
  expect(document.title).toBe("Sign in | Okou");
  expect(screen.getByAltText("Okou")).toHaveAttribute(
    "src",
    platformOkouWordmarkDarkImg,
  );
});

test("Ad-attributed sign-ups continue to onboarding with their attribution", async () => {
  await setupSignedOutPage(
    "/sign-up?gclid=click-123&utm_campaign=summer#/verify?step=code",
  );

  const redirectUrl = new URL(
    screen.getByTestId("clerk-sign-up").dataset.clerkForceRedirectUrl ?? "",
  );
  expect(redirectUrl.origin).toBe("https://app.okou.ai");
  expect(redirectUrl.pathname).toBe("/onboarding");
  expect(redirectUrl.searchParams.get("gclid")).toBe("click-123");
  expect(redirectUrl.searchParams.get("utm_campaign")).toBe("summer");
  expect(redirectUrl.searchParams.get("vm0_source")).toBe("homepage");
});

test("Sign-up redirects to sibling origins of the current host are kept", async () => {
  const redirectUrl = "https://www.okou.ai/connector/success?vm0_theme=light";
  await setupSignedOutPage(
    `/sign-up?redirect_url=${encodeURIComponent(redirectUrl)}`,
  );

  expect(
    screen.getByTestId("clerk-sign-up").dataset.clerkForceRedirectUrl,
  ).toBe(redirectUrl);
});

test("Sign-up redirects to other environments fall back to onboarding", async () => {
  await setupSignedOutPage(
    "/sign-up?redirect_url=https%3A%2F%2Fstaging-www.omby.ai%2Fconnector%2Fsuccess",
  );

  expect(
    screen.getByTestId("clerk-sign-up").dataset.clerkForceRedirectUrl,
  ).toBe("https://app.okou.ai/onboarding");
});

test("Hosted auth reaches the brand home and the theme toggle", async () => {
  context.mocks.browser.matchMedia(false);
  await setupSignedOutPage("/sign-up");

  // The wordmark is a same-origin static asset, so it must not request CORS.
  const logoImage = screen.getByAltText("Okou");
  expect(logoImage).not.toHaveAttribute("crossorigin");
  expect(logoImage.closest("a")).toBe(okouBrandLink());
  expect(screen.getByLabelText("Toggle theme")).toBeVisible();
});

test("Theme changes preserve the Clerk runtime binding", async () => {
  context.mocks.browser.matchMedia(false);
  const clerk = context.mocks.clerk();
  await setupSignedOutPage("/sign-up");

  const clerkRouter = registeredClerkRouter();
  const themeToggle = screen.getByLabelText("Toggle theme");
  click(themeToggle);

  await waitFor(() => {
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });
  expect(registeredClerkRouter()).toBe(clerkRouter);
  expect(clerk.statusListenerCount()).toBe(1);
});

test("Leaving the hosted page releases the Clerk status subscription", async () => {
  const clerk = context.mocks.clerk();
  await setupSignedOutPage("/sign-in");
  expect(screen.getByTestId("clerk-sign-in")).toBeVisible();
  expect(clerk.statusListenerCount()).toBe(1);
  expect(window.__okouClerkRouter).toBeDefined();

  act(() => {
    window.history.pushState(null, "", "/_/error");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });

  await expect(
    screen.findByText("Oops! Something went sideways"),
  ).resolves.toBeVisible();
  expect(clerk.statusListenerCount()).toBe(0);
  expect(window.__okouClerkRouter).toBeUndefined();
});
