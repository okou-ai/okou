import { screen, waitFor } from "@testing-library/react";
import { buildPublishableKey } from "@clerk/shared/keys";
import { expect, test } from "vitest";
import { setupPage, startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const CLIENT_ID = "https://chatgpt.com/oauth/client.json";

function clerkEnvironment() {
  return {
    VITE_CLERK_PUBLISHABLE_KEY_PREVIEW: buildPublishableKey(
      "oauth-test.clerk.accounts.dev",
    ),
    VITE_CLERK_PUBLISHABLE_KEY_PROD: buildPublishableKey("clerk.okou.ai"),
  };
}

function consentPath(): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    code_challenge: "synthetic-challenge",
    code_challenge_method: "S256",
    redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
    resource: "https://api.okou.ai/mcp",
    response_type: "code",
    scope: "openid email okou:chat:read",
    state: "synthetic-state",
  });
  return `/oauth-consent?${params.toString()}`;
}

test.each(["app.vm7.ai", "app.okou.ai"])(
  "%s renders the app-hosted OAuth consent request",
  async (host) => {
    await setupPage({
      context,
      env: clerkEnvironment(),
      host,
      path: consentPath(),
    });

    const consent = await screen.findByTestId("clerk-oauth-consent");
    expect(consent).toHaveAttribute("data-client-id", CLIENT_ID);
    expect(consent).toHaveAttribute("data-clerk-theme", "simple");
    expect(consent).toHaveAttribute("data-clerk-logo-link-url", "/");
    expect(consent).toHaveAttribute(
      "data-clerk-primary-color",
      "hsl(var(--primary))",
    );
    expect(consent).toHaveAttribute(
      "data-clerk-primary-foreground",
      "hsl(var(--primary-foreground))",
    );
    expect(screen.getByTestId("app-auth-layout")).toContainElement(
      screen.getByTestId("app-oauth-consent"),
    );
    expect(screen.getByTestId("app-auth-background")).toBeInTheDocument();
    expect(screen.getByLabelText("Go to Okou home")).toHaveAttribute(
      "href",
      "/",
    );
    expect(screen.getByLabelText("Toggle theme")).toBeVisible();
    expect(location.pathname).toBe("/oauth-consent");
    expect(new URLSearchParams(location.search).get("code_challenge")).toBe(
      "synthetic-challenge",
    );
  },
);

test("A signed-out consent request returns through app sign-in", async () => {
  const assigned = context.mocks.browser.locationAssign();
  const path = consentPath();
  await startPage({
    context,
    auth: null,
    env: clerkEnvironment(),
    host: "app.vm7.ai",
    path,
  });

  await waitFor(() => {
    expect(assigned.calls).toHaveLength(1);
  });
  const signIn = new URL(assigned.calls[0] ?? "");
  expect(signIn.origin).toBe("https://app.vm7.ai");
  expect(signIn.pathname).toBe("/sign-in");
  expect(new URLSearchParams(signIn.hash.slice(3)).get("redirect_url")).toBe(
    `https://app.vm7.ai${path}`,
  );
  expect(screen.queryByTestId("clerk-oauth-consent")).not.toBeInTheDocument();
});
