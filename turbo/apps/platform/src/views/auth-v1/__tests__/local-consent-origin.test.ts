import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { startPage, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
const context = testContext();
const tenant = "app.vm7.ai:8443";
const member = {
  user: { id: "local-consent-reader", fullName: "Harbor Reader" },
} as const;
function login(returnHost: string) {
  const request = new URL("https://" + returnHost + "/oauth-consent");
  request.searchParams.set("client_id", "fixture.harbor");
  const query = new URLSearchParams({ redirect_url: request.href });
  return {
    request,
    options: {
      context,
      host: tenant,
      auth: member,
      path: "/sign-in?" + query.toString(),
    },
  };
}
test("auth-oauth-consent-001 Local sign-in continues to the same port's consent request", async () => {
  const { request, options } = login(tenant);
  await startPage(options);
  await waitFor(() => {
    return expect(location.href).toBe(request.href);
  });
  expect(mockedClerk.redirectWithAuth).toHaveBeenCalledWith(request.href);
});
test("auth-oauth-consent-003 A Marketing consent destination leaves the member at the local sign-in form", async () => {
  const { options } = login("www.vm7.ai:8443");
  await setupPage(options);
  await expect(screen.findByTestId("clerk-sign-in")).resolves.toBeVisible();
  expect(location.host).toBe(tenant);
  expect(location.pathname).toBe("/sign-in");
  expect(mockedClerk.redirectWithAuth).not.toHaveBeenCalled();
});
