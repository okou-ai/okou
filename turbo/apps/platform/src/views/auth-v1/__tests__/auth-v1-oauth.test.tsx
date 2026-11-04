import { buildPublishableKey } from "@clerk/shared/keys";
import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { setupPage, startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const previewApp = "https://app.vm7.ai";
function clerkEnvironment() {
  return {
    VITE_CLERK_PUBLISHABLE_KEY_PREVIEW: buildPublishableKey(
      "oauth-test.clerk.accounts.dev",
    ),
    VITE_CLERK_PUBLISHABLE_KEY_PROD: buildPublishableKey("clerk.okou.ai"),
  };
}

function consentUrl(origin = previewApp): string {
  return `${origin}/oauth-consent?client_id=https%3A%2F%2Fclient.example%2Fmetadata.json&state=a%2Bb&code_challenge=challenge&code_challenge_method=S256&scope=user%3Aorg%3Aread+okou%3Achat%3Aread&resource=https%3A%2F%2Fapi.example%2Fmcp&resource=https%3A%2F%2Fapi.example%2Fsecond`;
}

test.each([
  ["app.vm7.ai", previewApp],
  ["app.okou.ai", "https://app.okou.ai"],
])(
  "%s preserves its own app consent return in both validation layers",
  async (host, appOrigin) => {
    const target = consentUrl(appOrigin);
    await setupPage({
      context,
      host,
      path: `/sign-in?redirect_url=${encodeURIComponent(target)}`,
      auth: null,
      env: clerkEnvironment(),
    });

    expect(screen.getByTestId("clerk-sign-in")).toHaveAttribute(
      "data-clerk-force-redirect-url",
      target,
    );
    expect(screen.getByTestId("clerk-provider-config")).toHaveAttribute(
      "data-clerk-allowed-redirect-origins",
      expect.stringContaining(appOrigin),
    );
    expect(screen.getByTestId("clerk-google-one-tap")).toHaveAttribute(
      "data-sign-in-force-redirect-url",
      target,
    );
    const signUpUrl = new URL(
      screen.getByTestId("clerk-sign-in").dataset.clerkSignUpUrl ?? "",
      location.origin,
    );
    expect(signUpUrl.searchParams.get("redirect_url")).toBe(target);
  },
);

test.each(["sign-in", "sign-up"])(
  "%s preserves the consent query when Clerk moves the return into its hash",
  async (mode) => {
    const target = consentUrl();
    await setupPage({
      context,
      host: "app.vm7.ai",
      path: `/${mode}#/?redirect_url=${encodeURIComponent(target)}`,
      auth: null,
      env: clerkEnvironment(),
    });

    const form = screen.getByTestId(`clerk-${mode}`);
    expect(form).toHaveAttribute("data-clerk-force-redirect-url", target);
    const switchUrl = new URL(
      (mode === "sign-in"
        ? form.dataset.clerkSignUpUrl
        : form.dataset.clerkSignInUrl) ?? "",
      location.origin,
    );
    expect(
      new URLSearchParams(switchUrl.hash.slice(3)).get("redirect_url"),
    ).toBe(target);
  },
);

test.each([
  "https://oauth-test.accounts.dev/oauth-consent",
  "https://another.accounts.dev/oauth-consent",
  "https://accounts.okou.ai/oauth-consent",
  "https://app.okou.ai/oauth-consent",
  "https://oauth-test.accounts.dev.evil.example/oauth-consent",
  "https://oauth-test.accounts.dev@evil.example/oauth-consent",
  "https://user:secret@app.vm7.ai/oauth-consent",
  "http://app.vm7.ai/oauth-consent",
  "https://app.vm7.ai:444/oauth-consent",
  "javascript:alert(1)",
])(
  "An untrusted consent destination cannot control login: %s",
  async (target) => {
    await setupPage({
      context,
      host: "app.vm7.ai",
      path: `/sign-in?redirect_url=${encodeURIComponent(target)}`,
      env: clerkEnvironment(),
    });

    expect(screen.getByTestId("clerk-sign-in")).toHaveAttribute(
      "data-clerk-force-redirect-url",
      previewApp,
    );
    expect(mockedClerk.redirectWithAuth).not.toHaveBeenCalled();
  },
);

test.each([
  "https://app.vm7.ai/oauth-consent/other",
  "https://app.vm7.ai/oauth-consent#untrusted-route",
])("A non-consent app return cannot bypass login: %s", async (target) => {
  await setupPage({
    context,
    host: "app.vm7.ai",
    path: `/sign-in?redirect_url=${encodeURIComponent(target)}`,
    env: clerkEnvironment(),
  });

  expect(screen.getByTestId("clerk-sign-in")).toHaveAttribute(
    "data-clerk-force-redirect-url",
    target,
  );
  expect(mockedClerk.redirectWithAuth).not.toHaveBeenCalled();
});

test.each(["sign-in", "sign-up"])(
  "An active session on %s continues through Clerk's authenticated navigation",
  async (mode) => {
    const target = consentUrl();
    const assigned = context.mocks.browser.locationAssign();
    const decorated = `${target}&__clerk_db_jwt=synthetic-browser-handoff`;
    mockedClerk.buildUrlWithAuth.mockReturnValueOnce(decorated);
    await startPage({
      context,
      host: "app.vm7.ai",
      path: `/${mode}?redirect_url=${encodeURIComponent(target)}`,
      env: clerkEnvironment(),
    });

    await waitFor(() => {
      expect(assigned.calls).toStrictEqual([decorated]);
    });
    expect(mockedClerk.redirectWithAuth).toHaveBeenCalledExactlyOnceWith(
      target,
    );
    expect(screen.queryByTestId(`clerk-${mode}`)).not.toBeInTheDocument();
  },
);

test.each([
  ["/sign-in/tasks/choose-organization", "", ""],
  ["/sign-in/factor-two", "", ""],
  ["/sign-in", "", "#/choose"],
  ["/sign-in", "&__clerk_ticket=invitation", ""],
  ["/sign-in", "&prompt=login", ""],
  ["/sign-in", "", "#/?prompt=select_account"],
])(
  "An existing session preserves explicit auth steps: %s %s %s",
  async (path, query, hash) => {
    await setupPage({
      context,
      host: "app.vm7.ai",
      path: `${path}?redirect_url=${encodeURIComponent(consentUrl())}${query}${hash}`,
      env: clerkEnvironment(),
    });

    expect(screen.getByTestId("clerk-sign-in")).toBeVisible();
    expect(mockedClerk.redirectWithAuth).not.toHaveBeenCalled();
  },
);

test.each([
  "prompt=login",
  "prompt=select_account",
  "max_age=0",
  "login_hint=other@example.com",
])(
  "A consent request requiring user interaction stays on the form: %s",
  async (intent) => {
    await setupPage({
      context,
      host: "app.vm7.ai",
      path: `/sign-in?redirect_url=${encodeURIComponent(`${consentUrl()}&${intent}`)}`,
      env: clerkEnvironment(),
    });
    expect(screen.getByTestId("clerk-sign-in")).toBeVisible();
    expect(mockedClerk.redirectWithAuth).not.toHaveBeenCalled();
  },
);

test("An incomplete Clerk session finishes its task before OAuth consent", async () => {
  await setupPage({
    context,
    host: "app.vm7.ai",
    path: `/sign-in?redirect_url=${encodeURIComponent(consentUrl())}`,
    env: clerkEnvironment(),
    auth: {
      user: {
        id: "user_oauth",
        fullName: "OAuth Test",
        clientSessions: [
          {
            id: "session_pending",
            status: "pending",
            currentTask: { key: "choose-organization" },
          },
        ],
      },
    },
  });

  expect(screen.getByTestId("clerk-sign-in")).toBeVisible();
  expect(mockedClerk.redirectWithAuth).not.toHaveBeenCalled();
});

test("A failed OAuth continuation offers visible recovery", async () => {
  const consoleError = vi.spyOn(console, "error");
  const unexpectedError = consoleError.getMockImplementation();
  consoleError.mockImplementation((...args) => {
    if (!args.includes("Clerk OAuth continuation failed")) {
      unexpectedError?.(...args);
    }
  });
  mockedClerk.redirectWithAuth.mockRejectedValueOnce(
    new Error("Navigation failed"),
  );
  await setupPage({
    context,
    host: "app.vm7.ai",
    path: `/sign-in?redirect_url=${encodeURIComponent(consentUrl())}`,
    env: clerkEnvironment(),
  });

  expect(screen.getByRole("alert")).toHaveTextContent(
    "Oops! Something went sideways",
  );
  expect(mockedClerk.redirectWithAuth).toHaveBeenCalledOnce();
});
