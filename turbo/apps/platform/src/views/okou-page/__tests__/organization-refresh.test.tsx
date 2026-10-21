import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import type { MockedMembership } from "../../../__tests__/mock-auth.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function orgAMembership(): MockedMembership {
  return {
    id: "membership_org_a",
    organization: {
      id: "org_a",
      name: "Org A",
    },
  };
}

function workspaceSwitcher(): HTMLElement {
  const switcher = queryAllByRoleFast("button").find((candidate) => {
    return candidate.getAttribute("aria-label") === "Switch workspace";
  });
  if (!switcher) {
    throw new Error("Expected workspace switcher");
  }
  return switcher;
}

test("A temporary authentication refresh keeps the active workspace", async () => {
  await setupPage({
    context,
    path: "/agents",
    auth: {
      user: {
        id: "user_org_a",
        fullName: "Org A Member",
        email: "member@example.com",
      },
      organization: {
        activeOrg: { id: "org_a", name: "Org A" },
        memberships: [orgAMembership()],
      },
    },
  });

  const agentsHeading = await screen.findByRole("heading", { name: "Agents" });
  expect(agentsHeading).toBeVisible();
  click(workspaceSwitcher());
  const initialWorkspaceMenu = await screen.findByRole("menu");
  expect(within(initialWorkspaceMenu).getByText("Org A")).toBeVisible();
  click(workspaceSwitcher());
  await waitFor(() => {
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
  const clerk = context.mocks.clerk();

  act(() => {
    clerk.organization({
      activeOrg: null,
      memberships: [orgAMembership()],
    });
    clerk.stateChanged();
  });

  expect(screen.getByRole("heading", { name: "Agents" })).toBeVisible();
  expect(window.location.pathname).toBe("/agents");
  click(workspaceSwitcher());
  const refreshingWorkspaceMenu = await screen.findByRole("menu");
  expect(within(refreshingWorkspaceMenu).getByText("Org A")).toBeVisible();
  click(workspaceSwitcher());
  await waitFor(() => {
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  act(() => {
    clerk.organization({
      activeOrg: { id: "org_a", name: "Org A" },
      memberships: [orgAMembership()],
    });
    clerk.stateChanged();
  });

  click(workspaceSwitcher());
  const restoredWorkspaceMenu = await screen.findByRole("menu");
  expect(within(restoredWorkspaceMenu).getByText("Org A")).toBeVisible();
  expect(screen.getByRole("heading", { name: "Agents" })).toBeVisible();
  expect(window.location.pathname).toBe("/agents");
});

test("Reload the changed tab before using a new workspace", async () => {
  await setupPage({
    context,
    path: "/agents",
    auth: {
      user: {
        id: "user_org_a",
        fullName: "Workspace Member",
        email: "member@example.com",
      },
      organization: {
        activeOrg: { id: "org_a", name: "Org A" },
        memberships: [
          orgAMembership(),
          {
            id: "membership_org_b",
            organization: { id: "org_b", name: "Org B" },
          },
        ],
      },
    },
  });

  const agentsHeading = await screen.findByRole("heading", { name: "Agents" });
  expect(agentsHeading).toBeVisible();
  const clerk = context.mocks.clerk();

  act(() => {
    clerk.organization({
      activeOrg: { id: "org_b", name: "Org B" },
      memberships: [
        orgAMembership(),
        {
          id: "membership_org_b",
          organization: { id: "org_b", name: "Org B" },
        },
      ],
    });
    clerk.stateChanged();
  });

  await waitFor(() => {
    expect(window.location.pathname).toBe("/");
  });
});
