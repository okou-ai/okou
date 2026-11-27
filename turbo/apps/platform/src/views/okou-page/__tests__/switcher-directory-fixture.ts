import { screen, within } from "@testing-library/react";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";
function workspace(id: string, name: string) {
  return {
    id,
    name,
    hasImage: false,
    imageUrl: "https://images.example.org/" + id + ".png",
  };
}
export const acme = workspace("org_acme", "Acme"),
  design = workspace("org_design", "Design Org"),
  invited = workspace("org_invited", "Invited Org");
export function directory(
  context: TestContext,
  accept: () => Promise<void>,
  hasImage = true,
) {
  const memberships = [acme, design].map((org) => {
    return {
      id: "membership-" + org.id,
      role: "org:admin",
      organization: org,
    };
  });
  let activeOrg = acme;
  mockedClerk.sessionGetToken.mockResolvedValue(acme.id);
  let pending = true;
  const invitation = {
    id: "pending-invited",
    publicOrganizationData: { ...invited, hasImage },
    async accept() {
      await accept();
      pending = false;
      clerk.organization({ activeOrg, memberships, pendingInvitations: [] });
    },
  };
  const clerk = context.mocks.clerk();
  mockedClerk.setActive.mockImplementation(({ organization }) => {
    const next = [acme, design, invited].find((org) => {
      return org.id === organization;
    });
    if (!next) {
      throw new Error("Unknown organization");
    }
    activeOrg = next;
    mockedClerk.sessionGetToken.mockResolvedValue(next.id);
    clerk.organization({
      activeOrg,
      memberships,
      pendingInvitations: pending ? [invitation] : [],
    });
    clerk.stateChanged();
    return Promise.resolve();
  });
  return setupPage({
    context,
    path: "/",
    auth: {
      user: {
        id: "taylor",
        fullName: "Taylor",
        email: "taylor@acme.example",
        createOrganizationEnabled: true,
        createOrganizationsLimit: 1,
      },
      organization: {
        activeOrg,
        memberships,
        pendingInvitations: [invitation],
      },
    },
  });
}
export async function switchButton() {
  const rail = await screen.findByTestId("labeled-nav-rail");
  return within(rail).findByLabelText("Switch workspace");
}
export async function switchMenu() {
  click(await switchButton());
  return screen.findByRole("menu");
}
