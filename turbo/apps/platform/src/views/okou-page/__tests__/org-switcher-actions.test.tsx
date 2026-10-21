import { screen, waitFor } from "@testing-library/react";
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

function workspaceSwitcher(): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.getAttribute("aria-label") === "Switch workspace";
  });
  if (!button) {
    throw new Error("Workspace switcher not found");
  }
  return button;
}

async function setupCreatableWorkspace(limit: number | null = null) {
  context.mocks.data.org({ id: "org_current", name: "Acme", role: "admin" });
  await setupPage({
    context,
    path: "/agents",
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Test User",
        createOrganizationEnabled: true,
        createOrganizationsLimit: limit,
      },
      organization: {
        activeOrg: { id: "org_current", name: "Acme" },
        memberships: [{ id: "org_current" }],
      },
    },
  });
  click(await waitFor(workspaceSwitcher));
  await screen.findByText("Create workspace");
}

async function reopenWorkspaceMenu() {
  await waitFor(() => {
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
  click(workspaceSwitcher());
  await screen.findByRole("menu");
}

async function navigateToConnectors() {
  const connectorsLink = queryAllByRoleFast("link").find((candidate) => {
    return candidate.getAttribute("href") === "/connectors";
  });
  if (!connectorsLink) {
    throw new Error("Connectors navigation link not found");
  }
  click(connectorsLink);
  await waitFor(() => {
    expect(location.pathname).toBe("/connectors");
  });
}

test("Failed workspace creation does not activate an organization and can be retried", async () => {
  const creation = context.mocks.deferred<{ readonly id: string }>();
  mockedClerk.createOrganization.mockImplementationOnce(() => {
    return creation.promise;
  });
  await setupCreatableWorkspace();

  click(screen.getByText("Create workspace"));
  await reopenWorkspaceMenu();
  creation.reject(new Error("Clerk organization creation failed"));

  await screen.findByText("Create workspace");
  expect(mockedClerk.setActive).not.toHaveBeenCalled();
  click(screen.getByText("Create workspace"));
  await waitFor(() => {
    expect(mockedClerk.setActive).toHaveBeenCalledWith({
      organization: "new-org-id",
    });
  });
});

test("Leaving the page during workspace creation reconciles the quota without activating its SDK result", async () => {
  const creation = context.mocks.deferred<{ readonly id: string }>();
  let createdOrganizationsCount = 0;
  context.mocks.api(orgContract.createdCount, ({ respond }) => {
    return respond(200, { createdOrganizationsCount });
  });
  mockedClerk.createOrganization.mockImplementationOnce(async () => {
    const org = await creation.promise;
    createdOrganizationsCount = 1;
    return org;
  });
  await setupCreatableWorkspace(1);
  click(screen.getByText("Create workspace"));
  await waitFor(() => {
    expect(mockedClerk.createOrganization).toHaveBeenCalledWith({
      name: expect.stringMatching(/^workspace-/u),
      slug: expect.stringMatching(/^workspace-/u),
    });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
  await navigateToConnectors();
  click(workspaceSwitcher());
  await screen.findByText("Creating…");

  creation.resolve({ id: "org_created_after_navigation" });

  await waitFor(() => {
    expect(screen.queryByText("Creating…")).not.toBeInTheDocument();
    expect(screen.queryByText("Create workspace")).not.toBeInTheDocument();
  });
  click(workspaceSwitcher());
  await reopenWorkspaceMenu();
  expect(screen.queryByText("Create workspace")).not.toBeInTheDocument();
  expect(mockedClerk.setActive).not.toHaveBeenCalled();
  expect(location.pathname).toBe("/connectors");
});

test("Failed workspace activation still reconciles the committed creation quota", async () => {
  const activation = context.mocks.deferred<void>();
  let createdOrganizationsCount = 0;
  context.mocks.api(orgContract.createdCount, ({ respond }) => {
    return respond(200, { createdOrganizationsCount });
  });
  mockedClerk.createOrganization.mockImplementationOnce(() => {
    createdOrganizationsCount = 1;
    return Promise.resolve({ id: "org_activation_failed" });
  });
  mockedClerk.setActive.mockImplementationOnce(() => {
    return activation.promise;
  });
  await setupCreatableWorkspace(1);
  click(screen.getByText("Create workspace"));
  await waitFor(() => {
    expect(mockedClerk.setActive).toHaveBeenCalledWith({
      organization: "org_activation_failed",
    });
  });
  await reopenWorkspaceMenu();
  await screen.findByText("Creating…");

  activation.reject(new Error("Clerk organization activation failed"));

  await waitFor(() => {
    expect(screen.queryByText("Creating…")).not.toBeInTheDocument();
    expect(screen.queryByText("Create workspace")).not.toBeInTheDocument();
  });
  expect(location.pathname).toBe("/agents");
});

test("Leaving the page during invitation acceptance removes the committed invitation without activation", async () => {
  const acceptance = context.mocks.deferred<void>();
  const pendingInvitations = [
    {
      id: "invitation_1",
      publicOrganizationData: {
        id: "org_invited",
        name: "Invited Org",
        imageUrl: "https://cdn.okou.test/orgs/invited.png",
      },
      accept: async () => {
        await acceptance.promise;
        pendingInvitations.length = 0;
      },
    },
  ];
  context.mocks.data.org({ id: "org_current", name: "Acme", role: "admin" });
  await setupPage({
    context,
    path: "/agents",
    auth: {
      user: { id: "test-user-123", fullName: "Test User" },
      organization: {
        activeOrg: { id: "org_current", name: "Acme" },
        memberships: [{ id: "org_current" }],
        pendingInvitations,
      },
    },
  });
  await screen.findByTestId("pending-invitations-badge");
  click(workspaceSwitcher());
  await screen.findByText("Invited Org");
  const joinButton = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim() === "Join";
  });
  if (!joinButton) {
    throw new Error("Join invitation button not found");
  }
  click(joinButton);
  await screen.findByText("Joining…");
  click(workspaceSwitcher());
  await waitFor(() => {
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
  await navigateToConnectors();
  click(workspaceSwitcher());
  await screen.findByText("Invited Org");

  acceptance.resolve();

  await waitFor(() => {
    expect(
      screen.queryByTestId("pending-invitations-badge"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Invited Org")).not.toBeInTheDocument();
  });
  click(workspaceSwitcher());
  await reopenWorkspaceMenu();
  expect(screen.queryByText("Invited Org")).not.toBeInTheDocument();
  expect(mockedClerk.setActive).not.toHaveBeenCalled();
  expect(location.pathname).toBe("/connectors");
});
