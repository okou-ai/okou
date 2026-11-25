import { orgMembersContract } from "@okouai/api-contracts/contracts/org-member-routes";
import { action } from "./workspace-billing-fixtures.ts";
import { screen, within, waitFor } from "@testing-library/react";
import { test, expect } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  directory,
  switchButton,
  switchMenu,
  design,
  acme,
  invited,
} from "./switcher-directory-fixture.ts";
import { orgContract } from "@okouai/api-contracts/contracts/org-routes";
import userEvent from "@testing-library/user-event";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";

const context = testContext();

test("org-switcher-002 Workspaces with placeholder logos show the default texture with their initial in the switcher", async () => {
  await directory(
    context,
    () => {
      return Promise.resolve();
    },
    false,
  );
  const trigger = await switchButton();
  const current = await within(trigger).findByRole("img", { name: acme.name });
  expect(current).not.toHaveAttribute("src");
  expect(current).toBeEmptyDOMElement();
  expect(current.dataset.initial).toBe("A");
  const panel = await switchMenu();
  for (const [org, initial] of [
    [acme, "A"],
    [design, "D"],
    [invited, "I"],
  ] as const) {
    const avatar = await within(panel).findByRole("img", { name: org.name });
    expect(avatar).not.toHaveAttribute("src");
    expect(avatar).toBeEmptyDOMElement();
    expect(avatar.dataset.initial).toBe(initial);
  }
});

test("org-switcher-001 Join an invitation, then choose the existing Design membership", async () => {
  context.mocks.api(orgMembersContract.members, ({ request, respond }) => {
    const org = [acme, design, invited].find((entry) => {
      return request.headers.get("authorization") === "Bearer " + entry.id;
    });
    if (!org) {
      throw new Error("Roster request missing workspace identity");
    }
    const email = org.id + "@directory.example";
    return respond(200, {
      name: org.name,
      role: "admin",
      createdAt: "2026-01-01T00:00:00Z",
      members: [
        {
          userId: org.id + "-member",
          firstName: org.name,
          lastName: "Editor",
          email,
          imageUrl: "",
          role: "member",
          joinedAt: "2026-02-01T00:00:00Z",
        },
      ],
    });
  });
  const acceptance = createDeferredPromise<void>(context.signal);
  await directory(context, () => {
    return acceptance.promise;
  });
  const trigger = await switchButton();
  await expect(
    within(trigger).findByTestId("pending-invitations-badge"),
  ).resolves.toBeInTheDocument();
  const panel = await switchMenu();
  await expect(
    within(panel).findByRole("img", { name: invited.name }),
  ).resolves.toHaveAttribute("src", invited.imageUrl);
  click(within(panel).getByText("Join"));
  await expect(within(panel).findByText("Joining…")).resolves.toBeDisabled();
  acceptance.resolve();
  await waitFor(() => {
    return expect(
      within(trigger).getByRole("img", { name: invited.name }),
    ).toBeInTheDocument();
  });
  await waitFor(() => {
    return expect(
      within(trigger).queryByTestId("pending-invitations-badge"),
    ).toBeNull();
  });
  const options = within(panel).getByTestId("org-switcher-options-scroll");
  expect(within(options).queryByText(invited.name)).toBeNull();
  click(within(options).getByText(design.name));
  await waitFor(() => {
    return expect(
      within(trigger).getByRole("img", { name: design.name }),
    ).toBeInTheDocument();
  });
  expect(panel).not.toBeInTheDocument();
  expect(window.location.pathname).toBe("/");
  const rail = screen.getByTestId("labeled-nav-rail");
  click(within(rail).getByLabelText("Taylor"));
  const account = await screen.findByRole("menu");
  click(within(account).getByText("Settings"));
  const settings = await screen.findByRole("dialog");
  click(await action("People", settings));
  await expect(
    within(settings).findByText("org_design@directory.example"),
  ).resolves.toBeInTheDocument();
  expect(within(settings).queryByText("org_acme@directory.example")).toBeNull();
});

async function workflows() {
  const rail = screen.getByTestId("labeled-nav-rail");
  click(within(rail).getByLabelText("Workflows"));
  await waitFor(() => {
    return expect(window.location.pathname).toBe("/workflows");
  });
}

test("org-switcher-actions-003 Invitation completion on Workflows clears the badge without activating the invited workspace", async () => {
  const gate = createDeferredPromise<void>(context.signal);
  await directory(context, () => {
    return gate.promise;
  });
  const first = await switchMenu();
  click(await within(first).findByText("Join"));
  await expect(within(first).findByText("Joining…")).resolves.toBeDisabled();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(first).not.toBeInTheDocument();
  });
  await workflows();
  const trigger = await switchButton();
  expect(
    within(trigger).getByTestId("pending-invitations-badge"),
  ).toBeInTheDocument();
  gate.resolve();
  await waitFor(() => {
    return expect(
      within(trigger).queryByTestId("pending-invitations-badge"),
    ).toBeNull();
  });
  expect(
    within(trigger).getByRole("img", { name: acme.name }),
  ).toBeInTheDocument();
  const menu = await switchMenu();
  expect(within(menu).getByText("Design Org")).toBeInTheDocument();
  expect(within(menu).queryByText(invited.name)).toBeNull();
  expect(mockedClerk.setActive).not.toHaveBeenCalled();
  expect(window.location.pathname).toBe("/workflows");
});

test("org-switcher-actions-001 Committed creation consumes the quota after its originating page has closed", async () => {
  let created = 0;
  const completion = createDeferredPromise<void>(context.signal);
  const started = createDeferredPromise<void>(context.signal);
  context.mocks.api(orgContract.createdCount, ({ respond }) => {
    return respond(200, { createdOrganizationsCount: created });
  });
  mockedClerk.createOrganization.mockImplementation(async () => {
    started.resolve();
    await completion.promise;
    created = 1;
    return { id: "org_fresh" };
  });
  await directory(context, () => {
    return Promise.resolve();
  });
  const menu = await switchMenu();
  click(await within(menu).findByText("Create workspace"));
  await started.promise;
  await waitFor(() => {
    expect(menu).not.toBeInTheDocument();
  });
  await workflows();
  const options = await switchMenu();
  await expect(
    within(options).findByText("Create workspace"),
  ).resolves.toBeInTheDocument();
  completion.resolve();
  await waitFor(() => {
    return expect(within(options).queryByText("Create workspace")).toBeNull();
  });
  expect(within(options).getByText(acme.name)).toBeInTheDocument();
  expect(mockedClerk.setActive).not.toHaveBeenCalled();
  expect(window.location.pathname).toBe("/workflows");
});
