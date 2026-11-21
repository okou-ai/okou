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
const context = testContext();
test("org-switcher-002 Placeholder URLs leave the current, available and invited workspace brand marks intact", async () => {
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
  const panel = await switchMenu();
  for (const org of [acme, design, invited]) {
    await expect(
      within(panel).findByRole("img", { name: org.name }),
    ).resolves.not.toHaveAttribute("src");
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
