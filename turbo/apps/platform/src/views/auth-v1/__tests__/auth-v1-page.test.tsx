import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
const context = testContext();
function openForm(path: string) {
  return setupPage({
    context,
    host: "app.okou.ai",
    auth: null,
    path,
    sharedWorkerTestTransport: "message-port",
  });
}
test("auth-v1-page-006 The nested organization task renders its base sign-in form alone", async () => {
  await openForm("/sign-in/tasks/choose-organization");
  const form = await screen.findByTestId("clerk-sign-in");
  expect(within(form).getByText("/sign-in")).toBeVisible();
  expect(screen.queryByTestId("clerk-google-one-tap")).toBeNull();
  expect(document.title).toBe("Sign in | Okou");
});
test("auth-v1-page-011 Trusted skeleton navigation survives sign-in, One Tap and registration", async () => {
  const target = "https://app.okou.ai/_/skeleton";
  context.mocks.browser.matchMedia(false);
  await openForm("/sign-in?" + new URLSearchParams({ redirect_url: target }));
  const form = await screen.findByTestId("clerk-sign-in");
  expect(form).toHaveAttribute("data-clerk-force-redirect-url", target);
  const signup = new URL(form.dataset.clerkSignUpUrl ?? "", location.href);
  expect(signup.pathname).toBe("/sign-up");
  expect(signup.searchParams.get("redirect_url")).toBe(target);
  expect(screen.getByTestId("clerk-google-one-tap")).toHaveAttribute(
    "data-sign-in-force-redirect-url",
    target,
  );
  expect(document.title).toBe("Sign in | Okou");
  expect(screen.getByLabelText("Go to Okou home")).toHaveAttribute("href", "/");
});
test("auth-v1-page-015 Address verification keeps the theme on a sibling-site signup return", async () => {
  const target = "https://www.okou.ai/connector/success?vm0_theme=light";
  await openForm(
    "/sign-up/verify-email-address?" +
      new URLSearchParams({ redirect_url: target }),
  );
  await expect(screen.findByTestId("clerk-sign-up")).resolves.toHaveAttribute(
    "data-clerk-force-redirect-url",
    target,
  );
});
