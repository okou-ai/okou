import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
  startPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const CONSENT_PATH = `/oauth-consent?${new URLSearchParams({
  client_id: "oauth-client-7f3a",
  redirect_uri: "https://partner.example.test/callback",
  response_type: "code",
  scope: "openid profile",
  state: "partner-state-91",
  code_challenge: "y3Q2b0R8fH9xV1sZpL6mN4cT7wE5aK2jU8gB0iD3oFq",
  code_challenge_method: "S256",
})}`;

test("app.vm7.ai renders the app-hosted OAuth consent request", async () => {
  await setupPage({ context, path: CONSENT_PATH, host: "app.vm7.ai" });

  const consent = await screen.findByTestId("clerk-oauth-consent");
  expect(consent).toHaveAttribute("data-client-id", "oauth-client-7f3a");
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
  expect(screen.getByTestId("app-auth-layout")).toContainElement(consent);
  expect(screen.getByTestId("app-auth-background")).toBeInTheDocument();
  expect(
    queryAllByRoleFast("button").find((button) => {
      return button.getAttribute("aria-label") === "Toggle theme";
    }),
  ).toBeDefined();
  expect(window.location.href).toBe(`https://app.vm7.ai${CONSENT_PATH}`);
});

test("A signed-out consent request returns through app sign-in", async () => {
  const navigation = context.mocks.browser.locationAssign();

  await startPage({
    context,
    path: CONSENT_PATH,
    host: "app.vm7.ai",
    auth: null,
  });

  const destination = await waitFor(() => {
    const assigned = navigation.calls.at(-1);
    expect(assigned).toBeDefined();
    return new URL(assigned as string);
  });
  expect(`${destination.origin}${destination.pathname}`).toBe(
    "https://app.vm7.ai/sign-in",
  );
  expect(
    new URLSearchParams(destination.hash.split("?")[1]).get("redirect_url"),
  ).toBe(`https://app.vm7.ai${CONSENT_PATH}`);
  expect(screen.queryByTestId("clerk-oauth-consent")).not.toBeInTheDocument();
});
