import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { friendReferralsContract } from "@okouai/api-contracts/contracts/friend-referrals";

import { PRESENTATION_ONBOARDING_URL } from "../../../__tests__/presentation-onboarding-fixture.ts";
import {
  queryAllByRoleFast,
  fill,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { platformOkouWordmarkDarkImg } from "../../../lib/static-assets.ts";
import {
  createTestRuntime,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { bootstrapSkeleton } from "../../../test/bootstrap-skeleton.ts";
import { signupControl } from "./signup-test-helpers.ts";

const context = testContext();
const signedInContext = createTestRuntime(context);

test("An unavailable referral code can be cleared to continue signup", async () => {
  context.mocks.api(friendReferralsContract.visit, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Referral link is unavailable" },
    });
  });
  await setupSignedOutPage("/sign-up?friend_referral=a7k2p9");
  const code = screen.getByLabelText("Invitation code (optional)");
  expect(code).toHaveValue("a7k2p9");
  expect(code).toHaveAttribute("aria-invalid", "true");
  expect(signupControl("button", "Continue")).toBeDisabled();
  await fill(code, "");
  expect(signupControl("button", "Continue")).toBeEnabled();
  expect(document.title).toBe("Sign up | Okou");
});

test("An invitation link prefills the signup code and keeps it through Clerk steps", async () => {
  context.mocks.api(friendReferralsContract.visit, ({ body, respond }) => {
    return body.code === "a7k2p9"
      ? respond(200, { token: "signed-referral-visit" })
      : respond(404, {
          error: { code: "NOT_FOUND", message: "Referral link is unavailable" },
        });
  });
  await setupSignedOutPage("/sign-up?friend_referral=a7k2p9");
  expect(screen.getByLabelText("Invitation code (optional)")).toHaveValue(
    "a7k2p9",
  );
  expect(screen.getByText("Invitation code applied")).toBeInTheDocument();

  await registeredClerkRouter().push(
    "/sign-up/verify-email-address",
    clerkWindowNavigation(),
  );
  await waitFor(() => {
    expect(window.location.pathname).toBe("/sign-up/verify-email-address");
  });
  await registeredClerkRouter().push("/sign-up", clerkWindowNavigation());
  await waitFor(() => {
    expect(screen.getByLabelText("Invitation code (optional)")).toHaveValue(
      "a7k2p9",
    );
  });
  expect(screen.getByText("Invitation code applied")).toBeInTheDocument();
});

test("A friend can enter, correct, or remove an optional invitation code", async () => {
  context.mocks.api(friendReferralsContract.visit, ({ body, respond }) => {
    return body.code === "a7k2p9"
      ? respond(200, { token: "signed-referral-visit" })
      : respond(404, {
          error: { code: "NOT_FOUND", message: "Referral link is unavailable" },
        });
  });
  await setupSignedOutPage("/sign-up");
  const code = screen.getByLabelText("Invitation code (optional)");
  expect(code).toHaveValue("");
  const user = userEvent.setup({ delay: null });
  await user.type(code, "wrong!");
  expect(code).toHaveAttribute("aria-invalid", "true");
  await fill(code, "");
  await user.type(code, "A7K2P9");
  await screen.findByText("Invitation code applied");
  expect(code).toHaveValue("a7k2p9");
  expect(code).toHaveAttribute("aria-invalid", "false");
  await fill(code, "");
  await waitFor(() => {
    expect(code).toHaveAttribute("aria-invalid", "false");
    expect(
      screen.queryByText("Invitation code applied"),
    ).not.toBeInTheDocument();
  });
});

test("Changing a code while it is being checked does not apply the previous code", async () => {
  const oldVisit = context.mocks.deferred<void>();
  const newVisit = context.mocks.deferred<void>();
  context.mocks.api(
    friendReferralsContract.visit,
    async ({ body, respond }) => {
      if (body.code === "c9n4r1") {
        return respond(200, { token: "beta-referral-visit" });
      }
      if (body.code === "a7k2p9") {
        await oldVisit.promise;
        return respond(200, { token: "old-referral-visit" });
      }
      await newVisit.promise;
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Referral link is unavailable" },
      });
    },
  );
  await setupSignedOutPage("/sign-up?friend_referral=c9n4r1");
  const code = screen.getByLabelText("Invitation code (optional)");
  fireEvent.change(code, { target: { value: "a7k2p9" } });
  await screen.findByText("Checking invitation code…");
  fireEvent.change(code, { target: { value: "b8m3q0" } });
  oldVisit.resolve();
  newVisit.resolve();
  await screen.findByText(
    "This invitation code is unavailable. Check it or leave blank to continue.",
  );
  expect(code).toHaveValue("b8m3q0");
  expect(code).toHaveAttribute("aria-invalid", "true");
});

test("The edited signup code reaches our registration API after authentication", async () => {
  let registeredToken: string | undefined;
  context.mocks.api(friendReferralsContract.visit, ({ body, respond }) => {
    return respond(200, { token: `signed-visit:${body.code}` });
  });
  context.mocks.api(friendReferralsContract.register, ({ body, respond }) => {
    registeredToken = body.token;
    return respond(200, { status: "registered" });
  });
  await setupSignedOutPage("/sign-up?friend_referral=a7k2p9");
  expect(screen.getByText("Invitation code applied")).toBeInTheDocument();
  const code = screen.getByLabelText("Invitation code (optional)");
  await fill(code, "b8m3q0");
  await screen.findByText("Invitation code applied");
  expect(code).toHaveValue("b8m3q0");

  // Model the new authenticated document after Clerk returns to the same origin.
  cleanup();
  await setupPage({
    context: signedInContext,
    host: "app.okou.ai",
    path: "/sign-up",
  });
  expect(registeredToken).toBe("signed-visit:b8m3q0");
  expect(
    screen.queryByLabelText("Invitation code (optional)"),
  ).not.toBeInTheDocument();
});

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
  expect(bootstrapSkeleton()).toHaveAttribute("aria-hidden", "true");
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

test("Clerk navigation to a non-Auth V1 path loads a new document", async () => {
  const destination = "/sign-in-token";
  const assigned = context.mocks.browser.locationAssign();
  await setupSignedOutPage("/sign-in");

  await registeredClerkRouter().push(destination, clerkWindowNavigation());

  expect(assigned.calls).toStrictEqual([
    new URL(destination, "https://app.okou.ai").href,
  ]);
  expect(window.location.pathname).toBe("/sign-in");
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
    `/sign-up/verify-email-address?redirect_url=${encodeURIComponent(redirectUrl)}`,
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

  expect(signupControl("link", "Sign in").getAttribute("href")).toContain(
    `redirect_url=${encodeURIComponent(redirectUrl)}`,
  );
  expect(screen.getByLabelText("Invitation code (optional)")).toHaveValue("");
  expect(document.title).toBe("Sign up | Okou");
  expect(okouBrandLink()).toHaveAttribute("href", "/");
});

test("An untrusted redirect URL returns to the default app", async () => {
  context.mocks.browser.matchMedia(false);
  const redirectUrl = "https://app.okou.ai.evil.example/sign-in";
  await setupSignedOutPage(
    `/sign-in?redirect_url=${encodeURIComponent(redirectUrl)}`,
  );

  expect(screen.getByTestId("clerk-sign-in")).toHaveAttribute(
    "data-clerk-force-redirect-url",
    "https://app.okou.ai",
  );
});

test("Default sign-up redirects do not propagate acquisition parameters", async () => {
  await setupSignedOutPage(
    "/sign-up/verify-email-address?gclid=click-123&utm_campaign=summer#/verify?step=code",
  );

  const redirectUrl = new URL(
    screen.getByTestId("clerk-sign-up").dataset.clerkForceRedirectUrl ?? "",
  );
  expect(redirectUrl.toString()).toBe("https://app.okou.ai/onboarding");
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

test("Sign-up redirects to other environments fall back to onboarding", async () => {
  await setupSignedOutPage(
    "/sign-up/verify-email-address?redirect_url=https%3A%2F%2Fstaging-www.omby.ai%2Fconnector%2Fsuccess",
  );

  expect(
    screen.getByTestId("clerk-sign-up").dataset.clerkForceRedirectUrl,
  ).toBe("https://app.okou.ai/onboarding");
});

test("Hosted auth reaches the brand home and the theme toggle", async () => {
  context.mocks.browser.matchMedia(false);
  await setupSignedOutPage("/sign-up/continue");

  // The wordmark is a same-origin static asset, so it must not request CORS.
  const logoImage = screen.getByAltText("Okou");
  expect(logoImage).not.toHaveAttribute("crossorigin");
  expect(logoImage.closest("a")).toBe(okouBrandLink());
  expect(screen.getByLabelText("Toggle theme")).toBeVisible();
});
