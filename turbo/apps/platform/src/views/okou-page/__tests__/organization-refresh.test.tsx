import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";

const context = testContext();

function memberships() {
  return [
    { id: "org_a", organization: { id: "org_a", name: "Org A" } },
    { id: "org_b", organization: { id: "org_b", name: "Org B" } },
  ];
}

function workspaceChoices(): string[] {
  return queryAllByRoleFast("menuitem", screen.getByRole("menu")).map(
    (item) => {
      return item.textContent?.trim() ?? "";
    },
  );
}

function expectAgentsPage(): void {
  expect(location.pathname).toBe("/agents");
  expect(location.search).toBe("");
  expect(
    screen.getByRole("heading", { name: "Agents", level: 1 }),
  ).toBeInTheDocument();
}

test("A temporary authentication refresh keeps the active workspace", async () => {
  await setupPage({
    context,
    path: "/agents",
    auth: {
      user: { id: "user_avery", fullName: "Avery Stone" },
      organization: {
        activeOrg: { id: "org_a", name: "Org A" },
        memberships: memberships(),
      },
    },
  });
  await expect(
    screen.findByRole("heading", { name: "Agents", level: 1 }),
  ).resolves.toBeInTheDocument();
  click(await findFastControl("button", "Switch workspace"));
  await expect(screen.findByRole("menu")).resolves.toHaveTextContent("Org A");
  expect(workspaceChoices()).toStrictEqual(["Org B"]);
  const clerk = context.mocks.clerk();

  clerk.organization({ activeOrg: null, memberships: memberships() });
  clerk.stateChanged();

  // While no workspace is active, Org A is still offered.
  await waitFor(() => {
    expect(workspaceChoices()).toStrictEqual(["Org A", "Org B"]);
  });
  expectAgentsPage();

  clerk.organization({
    activeOrg: { id: "org_a", name: "Org A" },
    memberships: memberships(),
  });
  clerk.stateChanged();

  await waitFor(() => {
    expect(workspaceChoices()).toStrictEqual(["Org B"]);
  });
  expect(screen.getByRole("menu")).toHaveTextContent("Org A");
  expectAgentsPage();
});
