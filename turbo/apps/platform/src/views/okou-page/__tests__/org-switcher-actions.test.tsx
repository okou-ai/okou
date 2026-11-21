import { orgContract } from "@okouai/api-contracts/contracts/org-routes";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  directory,
  switchMenu,
  switchButton,
  acme,
  invited,
} from "./switcher-directory-fixture.ts";
const context = testContext();
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
