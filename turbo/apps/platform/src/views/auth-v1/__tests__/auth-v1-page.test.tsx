import { cleanup, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { friendReferralsContract } from "@okouai/api-contracts/contracts/friend-referrals";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { platformOkouWordmarkDarkImg } from "../../../lib/static-assets.ts";
import {
  createTestRuntime,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { bootstrapSkeleton } from "../../../test/bootstrap-skeleton.ts";

const context = testContext();
const signedInContext = createTestRuntime(context);
const referralCookieName = "__Secure-okou-friend-referral-visit";

test("An unavailable invitation link still opens Clerk signup", async () => {
  context.mocks.api(friendReferralsContract.visit, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Referral link is unavailable" },
    });
  });
  await setupSignedOutPage("/sign-up?friend_referral=a7k2p9");
  expect(screen.getByTestId("clerk-sign-up")).toHaveAttribute(
    "data-clerk-routing",
    "path",
  );
  expect(document.title).toBe("Sign up | Okou");
});

test("Invitation links persist a signed host-only cookie and preserve the signup return", async () => {
  const cookieWrites = vi.spyOn(document, "cookie", "set");
  context.mocks.api(friendReferralsContract.visit, ({ body, respond }) => {
    expect(body.code).toBe("a7k2p9");
    return respond(200, { token: "signed-visit:a7k2p9" });
  });
  const redirectUrl = "https://app.okou.ai/onboarding?source=friend";
  await setupSignedOutPage(
    `/sign-up?friend_referral=A7K2P9&redirect_url=${encodeURIComponent(redirectUrl)}#start`,
  );
  expect(screen.getByTestId("clerk-sign-up")).toHaveAttribute(
    "data-clerk-force-redirect-url",
    redirectUrl,
  );
  expect(cookieWrites).toHaveBeenCalledWith(
    `${referralCookieName}=signed-visit%3Aa7k2p9; Path=/; Max-Age=2592000; SameSite=Lax; Secure`,
  );
  expect(document.cookie).toContain(
    `${referralCookieName}=signed-visit%3Aa7k2p9`,
  );
  expect(window.location.search).toBe(
    `?redirect_url=${encodeURIComponent(redirectUrl)}`,
  );
  expect(window.location.hash).toBe("#start");
});

test.each(["registered", "ineligible"] as const)(
  "An invitation survives Clerk steps and is consumed after the authenticated %s result",
  async (status) => {
    let registeredToken: string | undefined;
    context.mocks.api(friendReferralsContract.visit, ({ respond }) => {
      return respond(200, { token: "signed-referral-visit" });
    });
    context.mocks.api(friendReferralsContract.register, ({ body, respond }) => {
      registeredToken = body.token;
      return respond(200, { status });
    });
    await setupPage({
      context,
      host: "app.okou.ai",
      path: "/sign-up?friend_referral=a7k2p9",
      auth: null,
    });
    expect(screen.getByTestId("clerk-sign-up")).toBeInTheDocument();
    await registeredClerkRouter().push(
      "/sign-up/verify-email-address",
      clerkWindowNavigation(),
    );
    await waitFor(() => {
      expect(window.location.pathname).toBe("/sign-up/verify-email-address");
    });
    expect(document.cookie).toContain(
      `${referralCookieName}=signed-referral-visit`,
    );

    // Clerk returns to a new authenticated document on the same App origin.
    cleanup();
    await setupPage({
      context: signedInContext,
      host: "app.okou.ai",
      path: "/sign-up",
    });
    expect(screen.getByTestId("clerk-sign-up")).toBeInTheDocument();
    expect(registeredToken).toBe("signed-referral-visit");
    expect(document.cookie).not.toContain(referralCookieName);
  },
);

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
  expect(bootstrapSkeleton()).toHaveAttribute("aria-hidden", "true");
});

test("Nested sign-in task paths stay on the hosted sign-in form", async () => {
  await setupSignedOutPage("/sign-in/tasks/choose-organization");

  expect(screen.getByTestId("clerk-sign-in")).toHaveTextContent(/^\/sign-in$/u);
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

test("Sign-up redirects to sibling origins of the current host are kept", async () => {
  const redirectUrl = "https://www.okou.ai/connector/success?vm0_theme=light";
  await setupSignedOutPage(
    `/sign-up/verify-email-address?redirect_url=${encodeURIComponent(redirectUrl)}`,
  );

  expect(
    screen.getByTestId("clerk-sign-up").dataset.clerkForceRedirectUrl,
  ).toBe(redirectUrl);
});
