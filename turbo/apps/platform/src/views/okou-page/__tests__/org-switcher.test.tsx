import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { orgContract } from "@okouai/api-contracts/contracts/org-routes";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function buttonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

function buttonByLabel(label: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!button) {
    throw new Error(`${label} button not found`);
  }
  return button;
}

function menuItemByText(text: string): HTMLElement {
  const item = queryAllByRoleFast("menuitem").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!item) {
    throw new Error(`${text} menu item not found`);
  }
  return item;
}

test("Join an invited workspace from the workspace switcher", async () => {
  const acceptDeferred = context.mocks.deferred<void>();
  const pendingInvitations = [
    {
      id: "invitation_1",
      publicOrganizationData: {
        id: "org_invited",
        name: "Invited Org",
        imageUrl: "https://cdn.okou.test/orgs/invited.png",
        hasImage: true,
      },
      accept: async () => {
        await acceptDeferred.promise;
        pendingInvitations.length = 0;
      },
    },
  ];

  context.mocks.data.org({
    id: "org_current",
    name: "Acme",
    role: "admin",
  });

  await setupPage({
    context,
    path: "/",
    auth: {
      user: { id: "test-user-123", fullName: "Test User" },
      organization: {
        activeOrg: {
          id: "org_current",
          name: "Acme",
          slug: "acme",
          imageUrl: "https://cdn.okou.test/orgs/acme.png",
          hasImage: true,
        },
        memberships: [
          {
            id: "membership_current",
            organization: {
              id: "org_current",
              name: "Acme",
              imageUrl: "https://cdn.okou.test/orgs/acme.png",
            },
          },
          {
            id: "membership_design",
            organization: {
              id: "org_design",
              name: "Design Org",
              imageUrl: "https://cdn.okou.test/orgs/design.png",
              hasImage: true,
            },
          },
        ],
        pendingInvitations,
      },
    },
  });

  const orgSwitcher = await waitFor(() => {
    const switcher = buttonByLabel("Switch workspace");
    expect(
      within(switcher).getByTestId("pending-invitations-badge"),
    ).toBeInTheDocument();
    return switcher;
  });

  click(orgSwitcher);

  await waitFor(() => {
    expect(screen.getByText("Design Org")).toBeInTheDocument();
    expect(screen.getByText("Invited Org")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Design Org" })).toHaveAttribute(
      "src",
      "https://cdn.okou.test/orgs/design.png",
    );
    expect(screen.getByRole("img", { name: "Invited Org" })).toHaveAttribute(
      "src",
      "https://cdn.okou.test/orgs/invited.png",
    );
  });

  click(buttonByText("Join"));

  await waitFor(() => {
    expect(screen.getByText("Joining…")).toBeInTheDocument();
  });

  acceptDeferred.resolve();

  await waitFor(() => {
    expect(screen.queryByText("Invited Org")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("pending-invitations-badge"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Design Org")).toBeInTheDocument();
  });

  click(menuItemByText("Design Org"));

  await waitFor(() => {
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

test("Show the brand default for workspaces that never uploaded a logo", async () => {
  // Clerk fills `imageUrl` with a generated placeholder for every organization,
  // so only `hasImage` says whether a logo was uploaded.
  const clerkPlaceholder = "https://img.clerk.test/default-organization.png";

  context.mocks.data.org({
    id: "org_current",
    name: "workspace-3e46915f",
    role: "admin",
  });

  await setupPage({
    context,
    path: "/",
    auth: {
      user: { id: "test-user-123", fullName: "Test User" },
      organization: {
        activeOrg: {
          id: "org_current",
          name: "workspace-3e46915f",
          imageUrl: clerkPlaceholder,
          hasImage: false,
        },
        memberships: [
          {
            id: "membership_current",
            organization: {
              id: "org_current",
              name: "workspace-3e46915f",
              imageUrl: clerkPlaceholder,
              hasImage: false,
            },
          },
          {
            id: "membership_design",
            organization: {
              id: "org_design",
              name: "Design Org",
              imageUrl: clerkPlaceholder,
              hasImage: false,
            },
          },
        ],
        pendingInvitations: [
          {
            id: "invitation_1",
            publicOrganizationData: {
              id: "org_invited",
              name: "Invited Org",
              imageUrl: clerkPlaceholder,
              hasImage: false,
            },
          },
        ],
      },
    },
  });

  const orgSwitcher = await waitFor(() => {
    return buttonByLabel("Switch workspace");
  });

  click(orgSwitcher);

  const menu = await screen.findByRole("menu");
  await waitFor(() => {
    expect(within(menu).getByText("Invited Org")).toBeInTheDocument();
  });
  for (const name of ["workspace-3e46915f", "Design Org", "Invited Org"]) {
    expect(within(menu).getByRole("img", { name })).not.toHaveAttribute("src");
  }
  expect(
    within(orgSwitcher).getByRole("img", { name: "workspace-3e46915f" }),
  ).not.toHaveAttribute("src");
});

test("Creating a workspace opens onboarding after activating its organization", async () => {
  const clerk = context.mocks.clerk();
  mockedClerk.setActive.mockImplementation(() => {
    clerk.organization({
      activeOrg: { id: "new-org-id", name: "New workspace" },
    });
    clerk.stateChanged();
    return Promise.resolve();
  });
  context.mocks.api(orgContract.createdCount, ({ respond }) => {
    return respond(200, { createdOrganizationsCount: 0 });
  });
  context.mocks.data.org({
    id: "org_current",
    name: "Solo",
    role: "admin",
    createdBy: "other-user-456",
  });

  await setupPage({
    context,
    path: "/agents",
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
        createOrganizationEnabled: true,
        createOrganizationsLimit: 1,
      },
      organization: {
        activeOrg: {
          id: "org_current",
          name: "Solo",
          slug: "solo",
        },
        memberships: [
          {
            id: "membership_current",
            organization: {
              id: "org_current",
              name: "Solo",
            },
          },
        ],
      },
    },
  });

  const orgSwitcher = await waitFor(() => {
    return buttonByLabel("Switch workspace");
  });

  click(orgSwitcher);

  await waitFor(() => {
    expect(screen.getByText("Create workspace")).toBeInTheDocument();
  });

  click(screen.getByText("Create workspace"));

  await waitFor(() => {
    expect(location.pathname).toBe("/onboarding");
  });
  expect(mockedClerk.createOrganization).toHaveBeenCalledWith({
    name: expect.stringMatching(/^workspace-/u),
    slug: expect.stringMatching(/^workspace-/u),
  });
  expect(mockedClerk.setActive).toHaveBeenCalledWith({
    organization: "new-org-id",
  });
});

test("Hide workspace creation after the user reaches the limit", async () => {
  context.mocks.api(orgContract.createdCount, ({ respond }) => {
    return respond(200, { createdOrganizationsCount: 1 });
  });
  context.mocks.data.org({
    id: "org_current",
    name: "Shared",
    role: "admin",
    createdBy: "other-user-456",
  });

  await setupPage({
    context,
    path: "/",
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
        createOrganizationEnabled: true,
        createOrganizationsLimit: 1,
      },
      organization: {
        activeOrg: {
          id: "org_current",
          name: "Shared",
          slug: "shared",
        },
        memberships: [
          {
            id: "membership_current",
            organization: {
              id: "org_current",
              name: "Shared",
            },
          },
          {
            id: "membership_owned",
            organization: {
              id: "org_owned",
              name: "Owned",
            },
          },
        ],
      },
    },
  });

  const orgSwitcher = await waitFor(() => {
    return buttonByLabel("Switch workspace");
  });

  click(orgSwitcher);

  await screen.findByRole("menu");
  await waitFor(() => {
    expect(screen.queryByText("Create workspace")).not.toBeInTheDocument();
  });
});
