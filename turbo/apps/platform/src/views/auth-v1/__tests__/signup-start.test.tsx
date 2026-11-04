import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { friendReferralsContract } from "@okouai/api-contracts/contracts/friend-referrals";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

import { signupControl } from "./signup-test-helpers.ts";

const context = testContext();
const target = "https://app.okou.ai/onboarding?source=signup-test";

test("Ordinary signup keeps the hosted form while referral signup is not rolled out", async () => {
  await setupPage({
    context,
    host: "app.okou.ai",
    path: "/sign-up",
    auth: null,
  });
  expect(screen.getByTestId("clerk-sign-up")).toBeInTheDocument();
  expect(
    screen.queryByLabelText("Invitation code (optional)"),
  ).not.toBeInTheDocument();
});

test("Returning to an active signup keeps Clerk's hosted attempt and edit flow", async () => {
  mockedClerk.client.signUp.status = "missing_requirements";
  await setupPage({
    context,
    host: "app.okou.ai",
    path: "/sign-up",
    auth: null,
  });
  await screen.findByTestId("clerk-sign-up");
  expect(
    screen.queryByLabelText("Invitation code (optional)"),
  ).not.toBeInTheDocument();
});

async function openSignup() {
  context.mocks.api(friendReferralsContract.visit, ({ respond }) => {
    return respond(200, { token: "staff-inviter-signed-visit" });
  });
  await setupPage({
    context,
    host: "app.okou.ai",
    path: `/sign-up?friend_referral=a7k2p9&redirect_url=${encodeURIComponent(target)}`,
    auth: null,
  });
  await screen.findByRole("heading", { name: "Create your account" });
}

async function fillEmailSignup() {
  await fill(screen.getByLabelText("Email address"), "new-friend@example.com");
  await fill(
    screen.getByLabelText("Password", { exact: true }),
    "SignupTest!45113",
  );
  const user = userEvent.setup({ delay: null });
  await user.click(screen.getByRole("checkbox"));
  return user;
}

test("The optional invitation code is inside the form, after the password and before consent", async () => {
  await openSignup();
  const password = screen.getByLabelText("Password", { exact: true });
  const code = screen.getByLabelText("Invitation code (optional)");
  const consent = screen.getByRole("checkbox");
  expect(code.closest("form")).toBe(password.closest("form"));
  expect(
    password.compareDocumentPosition(code) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    code.compareDocumentPosition(consent) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  const user = userEvent.setup({ delay: null });
  await user.click(signupControl("button", "Show password"));
  expect(password).toHaveAttribute("type", "text");
  await user.click(signupControl("button", "Hide password"));
  expect(password).toHaveAttribute("type", "password");
});

test("Email registration hands the attempt to Clerk's verification page without referral metadata", async () => {
  await openSignup();
  await fill(screen.getByLabelText("Invitation code (optional)"), "");
  const user = await fillEmailSignup();
  await user.click(signupControl("button", "Continue"));
  await screen.findByTestId("clerk-sign-up");
  expect(location.pathname).toBe("/sign-up/verify-email-address");
  expect(new URLSearchParams(location.search).get("redirect_url")).toBe(target);
  expect(mockedClerk.client.signUp.create).toHaveBeenCalledWith({
    emailAddress: "new-friend@example.com",
    password: "SignupTest!45113",
    legalAccepted: true,
  });
  expect(
    mockedClerk.client.signUp.prepareEmailAddressVerification,
  ).toHaveBeenCalledWith({ strategy: "email_code" });
});

test.each([
  ["Google", "oauth_google"],
  ["Apple", "oauth_apple"],
])(
  "%s uses Clerk's hosted callback and the validated return URL",
  async (name, strategy) => {
    await openSignup();
    const user = userEvent.setup({ delay: null });
    await user.click(signupControl("button", name));
    await waitFor(() => {
      expect(
        mockedClerk.client.signUp.authenticateWithRedirect,
      ).toHaveBeenCalledWith({
        strategy,
        redirectUrl: `https://app.okou.ai/sign-up/sso-callback?redirect_url=${encodeURIComponent(target)}`,
        redirectUrlComplete: target,
      });
    });
  },
);

test("A failed signup keeps the fields editable and exposes its error", async () => {
  mockedClerk.client.signUp.create.mockRejectedValueOnce(
    new Error("Clerk unavailable"),
  );
  await openSignup();
  const user = await fillEmailSignup();
  await user.click(signupControl("button", "Continue"));
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Request failed",
  );
  expect(screen.getByLabelText("Email address")).toBeEnabled();
  expect(signupControl("button", "Continue")).toBeEnabled();
});

test("Additional Clerk requirements continue on the hosted form", async () => {
  mockedClerk.client.signUp.create.mockResolvedValueOnce({
    status: "missing_requirements",
    createdSessionId: null,
    missingFields: ["username"],
    unverifiedFields: ["email_address"],
    protectCheck: null,
  });
  await openSignup();
  const user = await fillEmailSignup();
  await user.click(signupControl("button", "Continue"));
  await screen.findByTestId("clerk-sign-up");
  expect(location.pathname).toBe("/sign-up/continue");
  expect(new URLSearchParams(location.search).get("redirect_url")).toBe(target);
});

test("A completed signup activates its session and preserves required session tasks", async () => {
  const assigned = context.mocks.browser.locationAssign();
  mockedClerk.client.signUp.create.mockResolvedValueOnce({
    status: "complete",
    createdSessionId: "signup-created-session",
    missingFields: [],
    unverifiedFields: [],
    protectCheck: null,
  });
  mockedClerk.setActive.mockImplementationOnce(async (params) => {
    await params.navigate?.({
      session: { currentTask: { key: "choose-organization" } },
      decorateUrl: (url) => {
        return url;
      },
    });
  });
  await openSignup();
  const user = await fillEmailSignup();
  await user.click(signupControl("button", "Continue"));
  await waitFor(() => {
    expect(assigned.calls).toStrictEqual([
      `https://app.okou.ai/sign-up/tasks/choose-organization?redirect_url=${encodeURIComponent(target)}`,
    ]);
  });
});

test("Leaving signup while Clerk activates its session prevents stale navigation", async () => {
  const assigned = context.mocks.browser.locationAssign();
  const activationStarted = context.mocks.deferred<void>();
  const activate = context.mocks.deferred<void>();
  const activationFinished = context.mocks.deferred<void>();
  mockedClerk.client.signUp.create.mockResolvedValueOnce({
    status: "complete",
    createdSessionId: "signup-created-session",
    missingFields: [],
    unverifiedFields: [],
    protectCheck: null,
  });
  mockedClerk.setActive.mockImplementationOnce(async (params) => {
    activationStarted.resolve();
    await activate.promise;
    try {
      await params.navigate?.({
        session: {},
        decorateUrl: (url) => {
          return url;
        },
      });
    } finally {
      activationFinished.resolve();
    }
  });
  await openSignup();
  const user = await fillEmailSignup();
  await user.click(signupControl("button", "Continue"));
  await activationStarted.promise;
  const router = window.__okouClerkRouter;
  if (!router) {
    throw new Error("Clerk router is not registered");
  }
  await router.push("/sign-in", {
    windowNavigate(to) {
      window.location.assign(to);
    },
  });
  await screen.findByTestId("clerk-sign-in");
  activate.resolve();
  await activationFinished.promise;
  expect(assigned.calls).toStrictEqual([]);
  expect(location.pathname).toBe("/sign-in");
});
