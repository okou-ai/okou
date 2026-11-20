import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  mockedClerk,
  type MockedMembership,
} from "../../../__tests__/mock-auth.ts";

import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function currentWorkspaceMembership(): MockedMembership {
  return {
    id: "membership_current",
    organization: {
      id: "org_current",
      name: "Current Workspace",
    },
  };
}

function invitationTicket(organizationId: string): string {
  const encodedPayload = btoa(
    JSON.stringify({ oid: organizationId, st: "organization_invitation" }),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  return `header.${encodedPayload}.signature`;
}

function actionByName(
  role: "button" | "link",
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const action = queryAllByRoleFast(role, container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.replace(/\s+/gu, " ").trim() === name
    );
  });
  if (!action) {
    throw new Error(`Expected ${role} named "${name}"`);
  }
  return action;
}

function completedInvitationPath(ticket: string): string {
  const params = new URLSearchParams([
    ["utm_campaign", "workspace-invite"],
    ["utm_content", "email"],
    ["utm_content", "reminder"],
    ["__clerk_status", "complete"],
    ["__clerk_ticket", ticket],
  ]);
  return `/agents?${params.toString()}#private-agents`;
}

test("An invitation accepted for another account offers account switching", async () => {
  context.mocks.browser.matchMedia(false);
  await setupPage({
    context,
    path: completedInvitationPath(invitationTicket("org_invited")),
    auth: {
      user: {
        id: "user_current",
        fullName: "Current Account",
        email: "current@example.com",
      },
      organization: {
        activeOrg: {
          id: "org_current",
          name: "Current Workspace",
        },
        memberships: [currentWorkspaceMembership()],
      },
    },
  });

  const acceptedNotice = await screen.findByText(
    "Invitation accepted for another account",
  );
  expect(acceptedNotice).toBeVisible();
  expect(location.hash).toBe("#private-agents");

  click(actionByName("button", "Switch account"));
  await waitFor(() => {
    expect(mockedClerk.openSignIn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        appearance: expect.objectContaining({
          theme: "simple",
          options: expect.objectContaining({
            logoImageUrl: undefined,
            logoLinkUrl: "/",
          }),
        }),
        fallbackRedirectUrl: "/",
        forceRedirectUrl: "/",
      }),
    );
  });
});
