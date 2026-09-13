import { screen, waitFor } from "@testing-library/react";
import { toast } from "@okouai/ui/components/ui/sonner";
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
import { search } from "../../../signals/location.ts";
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
    expect(mockedClerk.openSignIn).toHaveBeenCalledExactlyOnceWith({
      fallbackRedirectUrl: "/",
      forceRedirectUrl: "/",
    });
  });
  toast.dismiss();
  await waitFor(() => {
    expect(acceptedNotice).not.toBeInTheDocument();
  });
});

test("An incomplete invitation stays available to the hosted Clerk UI", async () => {
  const ticket = invitationTicket("org_invited");
  const params = new URLSearchParams([
    ["utm_campaign", "workspace-invite"],
    ["__clerk_status", "sign_in"],
    ["__clerk_ticket", ticket],
  ]);
  await setupPage({
    context,
    path: `/sign-in?${params.toString()}`,
    host: "app.okou.ai",
    auth: null,
  });

  await expect(screen.findByTestId("clerk-sign-in")).resolves.toBeVisible();
  const remainingParams = new URLSearchParams(search());
  expect(remainingParams.get("__clerk_status")).toBe("sign_in");
  expect(remainingParams.get("__clerk_ticket")).toBe(ticket);
  expect(remainingParams.get("utm_campaign")).toBe("workspace-invite");
  expect(mockedClerk.clientSignInCreate).not.toHaveBeenCalled();
});
