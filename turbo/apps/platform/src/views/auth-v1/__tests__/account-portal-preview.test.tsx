import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { setupPage, startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const previewHost = "pr-123-app.omby.ai";

test.each(["sign-in", "sign-up"])(
  "The %s comparison returns from Account Portal to the trusted deep link",
  async (mode) => {
    vi.spyOn(mockedClerk, "instanceType", "get").mockReturnValue("development");
    const replaced = context.mocks.browser.locationReplace();
    const returnUrl = `https://${previewHost}/onboarding?prompt=portal-preview&utm_source=qa`;
    const params = new URLSearchParams({
      auth_ui: "portal",
      redirect_url: returnUrl,
      sign_in_force_redirect_url: "https://untrusted.example/",
      "x-vercel-protection-bypass": "preview-credential",
    });
    await startPage({
      context,
      host: previewHost,
      path: `/${mode}?${params}`,
      auth: null,
    });

    await waitFor(() => {
      expect(replaced.calls).toHaveLength(1);
    });
    const destination = new URL(replaced.calls[0] ?? "");
    expect(destination.origin).toBe("https://accounts.example.test");
    expect(destination.pathname).toBe(`/${mode}`);
    expect(destination.searchParams.get("redirect_url")).toBe(returnUrl);
    expect(
      destination.searchParams.has("sign_in_force_redirect_url"),
    ).toBeFalsy();
    expect(
      destination.searchParams.has("x-vercel-protection-bypass"),
    ).toBeFalsy();
  },
);

test("An untrusted return URL cannot redirect the comparison outside the app", async () => {
  vi.spyOn(mockedClerk, "instanceType", "get").mockReturnValue("development");
  const replaced = context.mocks.browser.locationReplace();
  await startPage({
    context,
    host: previewHost,
    path: "/sign-in?auth_ui=portal&redirect_url=https://untrusted.example/",
    auth: null,
  });

  await waitFor(() => {
    expect(replaced.calls).toHaveLength(1);
  });
  expect(
    new URL(replaced.calls[0] ?? "").searchParams.get("redirect_url"),
  ).toBe(`https://${previewHost}`);
});

test.each([
  ["app.okou.ai", "development"],
  [previewHost, "production"],
] as const)(
  "The comparison stays embedded on %s with a %s Clerk instance",
  async (host, instanceType) => {
    vi.spyOn(mockedClerk, "instanceType", "get").mockReturnValue(instanceType);
    await setupPage({
      context,
      host,
      path: "/sign-in?auth_ui=portal",
      auth: null,
    });

    expect(screen.getByTestId("clerk-sign-in")).toBeInTheDocument();
  },
);
