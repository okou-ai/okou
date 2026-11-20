import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

/** A Clerk invitation ticket naming the workspace it was accepted for. */
function invitationTicket(organizationId: string): string {
  const payload = btoa(
    JSON.stringify({ st: "organization_invitation", oid: organizationId }),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return `eyJhbGciOiJSUzI1NiJ9.${payload}.signature`;
}

test("An invitation accepted for another account offers account switching", async () => {
  const search = new URLSearchParams({
    __clerk_status: "complete",
    __clerk_ticket: invitationTicket("org_other_workspace"),
  });

  await setupPage({
    context,
    path: `/agents?${search}#private-agents`,
    host: "app.okou.ai",
    auth: {
      user: { id: "user_invited", fullName: "Riley Chen" },
      organization: {
        activeOrg: { id: "org_current", name: "Current Workspace" },
        memberships: [
          {
            id: "orgmem_current",
            organization: { id: "org_current", name: "Current Workspace" },
          },
        ],
      },
    },
  });

  await expect(
    screen.findByText("Invitation accepted for another account"),
  ).resolves.toBeInTheDocument();
  expect(window.location.hash).toBe("#private-agents");

  const switchAccount = await waitFor(() => {
    const button = queryAllByRoleFast("button").find((candidate) => {
      return candidate.textContent?.trim() === "Switch account";
    });
    expect(button).toBeDefined();
    return button as HTMLElement;
  });

  click(switchAccount);

  await waitFor(() => {
    expect(mockedClerk.openSignIn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        appearance: expect.objectContaining({ theme: "simple" }),
        fallbackRedirectUrl: "/",
        forceRedirectUrl: "/",
      }),
    );
  });
});
