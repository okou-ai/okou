import { waitFor } from "@testing-library/react";
import { expect } from "vitest";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";

export function signupControl(
  role: "button" | "link",
  name: string,
): HTMLElement {
  const control = queryAllByRoleFast(role).find((element) => {
    return (
      element.textContent?.trim() === name ||
      element.getAttribute("aria-label") === name
    );
  });
  if (!control) {
    throw new Error(`Signup ${role} "${name}" was not found`);
  }
  return control;
}

/** Observe the public Clerk OAuth boundary reached by the signup page. */
export async function signupOAuthRedirect(): Promise<string> {
  click(signupControl("button", "Google"));
  await waitFor(() => {
    expect(
      mockedClerk.client.signUp.authenticateWithRedirect,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: "oauth_google" }),
    );
  });
  const params =
    mockedClerk.client.signUp.authenticateWithRedirect.mock.lastCall?.[0];
  if (!params) {
    throw new Error("The signup page did not start Clerk OAuth");
  }
  return params.redirectUrlComplete;
}
