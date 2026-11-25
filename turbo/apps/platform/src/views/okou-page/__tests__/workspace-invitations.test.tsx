import { act, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import {
  mockedClerk,
  mockClerkSessionTransitioning,
} from "../../../__tests__/mock-auth.ts";
import {
  click,
  queryAllByRoleFast,
  setupPage,
  startPage,
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

test("clerk-user-003 An invitation waiting through sign-in belongs to the first settled member", async () => {
  const sdk = context.mocks.clerk();
  const request = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(featureSwitchesContract.get, async ({ respond }) => {
    if (!request.settled()) {
      request.resolve();
    }
    await release.promise;
    return respond(200, { switches: {}, effectiveSwitches: {} });
  });
  const query = new URLSearchParams({
    __clerk_status: "complete",
    __clerk_ticket: invitationTicket("invited-field-team"),
  });
  const entry = await startPage({ context, path: "/sign-in?" + query });
  await request.promise;
  act(() => {
    sdk.user(null, null);
    sdk.stateChanged();
    mockClerkSessionTransitioning(true);
  });
  release.resolve();
  await screen.findByRole("region", { name: /Notifications/i });
  expect(screen.queryByText(/Invitation accepted/)).toBeNull();

  act(() => {
    sdk.user({ id: "user-a", fullName: "Field member" }, { token: "field" });
    sdk.organization({
      memberships: [
        {
          id: "field-membership",
          organization: { id: "invited-field-team", name: "Field team" },
        },
      ],
    });
    mockClerkSessionTransitioning(false);
    const member = mockedClerk.user;
    if (!member) {
      throw new Error("Expected the first signed-in Clerk member");
    }
    // The SDK fixture normally serves memberships from a shared list. Give
    // this member its own list before the other account becomes current.
    vi.spyOn(member, "organizationMemberships", "get").mockReturnValue([
      ...member.organizationMemberships,
    ]);
    sdk.user({ id: "user-b", fullName: "Other member" }, { token: "other" });
    sdk.organization({ memberships: [] });
    sdk.stateChanged();
  });
  await expect(
    screen.findByText("Invitation accepted for Field team"),
  ).resolves.toBeInTheDocument();
  await entry.ready;
});
