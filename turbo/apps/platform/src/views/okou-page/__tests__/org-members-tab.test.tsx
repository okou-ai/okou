import {
  orgInviteContract,
  orgMembersContract,
  orgMembershipRequestsContract,
} from "@okouai/api-contracts/contracts/org-member-routes";
import type {
  OrgMember,
  OrgMembersResponse,
  OrgRole,
} from "@okouai/api-contracts/contracts/org-members";
import { initSentry } from "../../../lib/sentry.ts";
import {
  billingUsagePackManagementContract,
  billingUsagePackCatalogContract,
} from "@okouai/api-contracts/contracts/billing";
import { cleanup, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { orgContract } from "@okouai/api-contracts/contracts/org-routes";
import {
  createTestRuntime,
  type TestContext,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  action,
  billing,
  setBilling,
  packages,
} from "./workspace-billing-fixtures.ts";
const context = testContext();
const createdAt = "2026-04-08T10:00:00Z";
function member(firstName: string, role: OrgRole = "member"): OrgMember {
  const userId = firstName.toLowerCase();
  return {
    userId,
    email: userId + "@foundry.org",
    firstName,
    lastName: null,
    role,
    imageUrl: "",
    joinedAt: createdAt,
  };
}
const alice = member("Alice", "admin");
const bob = member("Bob");
const pending = {
  id: "inv-pending",
  email: "pending@example.com",
  role: "member",
  createdAt,
} as const;
function roster(
  role: OrgRole = "admin",
  extra: Partial<OrgMembersResponse> = {},
) {
  context.mocks.data.orgMembers({
    name: "Foundry",
    role,
    members: [alice, bob, member("Dora", "admin")],
    pendingInvitations: [pending],
    ...extra,
  });
}
function people(role: OrgRole = "admin") {
  const identity = role === "admin" ? alice : bob;
  const org = { id: "org_foundry", name: "Foundry", role };
  context.mocks.data.org(org);
  return setupPage({
    context,
    host: "app.okou.ai",
    path: "/?settings=people",
    auth: {
      user: {
        id: identity.userId,
        fullName: identity.firstName ?? "",
        email: identity.email,
      },
      organization: {
        activeOrg: org,
        memberships: [{ id: org.id, role: "org:" + role }],
      },
    },
  });
}
function directInvites() {
  setBilling(context, () => {
    return billing("limited-free-1", { showUsagePack: false });
  });
}
async function inviteForm() {
  click(await action("Add member"));
  return screen.findByRole("dialog", { name: "Invite member" });
}
async function openActions(email: string) {
  const trigger = await screen.findByLabelText("Actions for " + email);
  click(trigger);
  return { trigger, menu: await screen.findByRole("menu") };
}
test("org-members-tab-004 A subscription with package display disabled exposes only ordinary member actions", async () => {
  roster();
  packages(context);
  fundedPackage();
  setBilling(context, () => {
    return billing("pro", { showUsagePack: false });
  });
  await people();
  const { menu } = await openActions(bob.email);
  expect(within(menu).getByText("Make admin")).toBeInTheDocument();
  expect(within(menu).queryByText("Configure member packages")).toBeNull();
  expect(screen.queryByText("Usage pack")).toBeNull();
});
test("org-members-tab-005 Opening People as a regular member lands on Preference", async () => {
  roster("member");
  packages(context);
  fundedPackage();
  setBilling(context, () => {
    return billing("pro");
  });
  await people("member");
  await expect(
    screen.findByRole("heading", { name: "Preference" }),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("Usage pack")).toBeNull();
  expect(screen.queryByLabelText(/^Actions for /)).toBeNull();
});
test("org-members-tab-006 A limited-free workspace can invite without buying a package", async () => {
  roster();
  directInvites();
  context.mocks.api(orgInviteContract.invite, ({ body, respond }) => {
    roster("admin", {
      pendingInvitations: [
        pending,
        {
          ...pending,
          id: "inv-new",
          email: body.email,
          role: body.role ?? "member",
        },
      ],
    });
    return respond(200, { message: "Invited" });
  });
  await people();
  const form = await inviteForm();
  const email = "legacy.invitee@example.com";
  await fill(within(form).getByPlaceholderText("email@example.com"), email);
  expect(within(form).queryByText(/member package/i)).toBeNull();
  click(await action("Send invitation", form));
  await expect(screen.findByText(email)).resolves.toBeInTheDocument();
  await expect(
    screen.findByText("Invitation sent to " + email),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("Usage pack")).toBeNull();
});
test.each([
  [
    "008",
    409,
    "INVITEE_ALREADY_MEMBER",
    "This person is already a member.",
    bob.email,
  ],
  [
    "009",
    409,
    "INVITATION_ALREADY_EXISTS",
    "This person already has a pending invitation.",
    pending.email,
  ],
  [
    "010",
    500,
    "INTERNAL_SERVER_ERROR",
    "The invitation service is unavailable.",
    "new@foundry.org",
  ],
] as const)(
  "org-members-tab-%s Invitation failure %i %s preserves the recipient and retry",
  async (_id, status, code, message, email) => {
    roster();
    directInvites();
    const sentry = context.mocks.sentry();
    initSentry();
    context.mocks.api(orgInviteContract.invite, ({ respond }) => {
      return respond(status, { error: { code, message } });
    });
    await people();
    const form = await inviteForm();
    const address = within(form).getByPlaceholderText("email@example.com");
    await fill(address, email);
    const reportsBeforeSubmit = sentry.reports.length;
    click(await action("Send invitation", form));
    await expect(screen.findByText(message)).resolves.toBeInTheDocument();
    expect(form).toBeInTheDocument();
    expect(address).toHaveValue(email);
    await expect(action("Send invitation", form)).resolves.toBeEnabled();
    const exceptions = () => {
      return sentry.reports.slice(reportsBeforeSubmit).filter((report) => {
        return report.type === "exception";
      });
    };
    const expectedReports =
      code === "INVITEE_ALREADY_MEMBER"
        ? []
        : [{ error: { code, status, message } }];
    await waitFor(() => {
      expect(exceptions()).toMatchObject(expectedReports);
    });
  },
);
test("org-members-tab-017 A suspended subscription offers reactivation before the invitation form", async () => {
  roster();
  setBilling(context, () => {
    return billing("pro", { status: "suspended" });
  });
  await people();
  click(await action("Add member"));
  const gate = await screen.findByRole("dialog", {
    name: "Reactivate to invite members",
  });
  expect(
    within(gate).getByText("Reactivate your workspace plan to invite members."),
  ).toBeInTheDocument();
  expect(within(gate).queryByRole("textbox")).toBeNull();
  expect(within(gate).queryByText("Role")).toBeNull();
  click(await action("View plans", gate));
  await expect(screen.findByText("Choose a plan")).resolves.toBeInTheDocument();
  expect(gate).not.toBeInTheDocument();
});
test.each([
  ["020", bob.email, "Make admin"],
  ["022", pending.email, "Revoke invitation"],
])(
  "org-members-tab-%s Escape restores focus to actions for %s",
  async (_id, email, item) => {
    roster();
    await people();
    const { trigger, menu } = await openActions(email);
    expect(within(menu).getByText(item)).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      return expect(trigger).toHaveFocus();
    });
    expect(menu).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "People" })).toBeInTheDocument();
  },
);
function roleChanges() {
  context.mocks.api(orgMembersContract.updateRole, ({ body, respond }) => {
    roster("admin", {
      members: [alice, bob, member("Dora", "admin")].map((person) => {
        return person.email === body.email
          ? { ...person, role: body.role }
          : person;
      }),
    });
    return respond(200, { message: "Updated" });
  });
}
function memberRow(email: string) {
  return within(screen.getByRole("group", { name: email }));
}
test("org-members-tab-019 Promoting Bob updates his row and reverses his available role action", async () => {
  roster();
  roleChanges();
  await people();
  const { menu } = await openActions(bob.email);
  click(within(menu).getByText("Make admin"));
  await expect(
    screen.findByText("Updated role for " + bob.email),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    return expect(memberRow(bob.email).getByText("Admin")).toBeInTheDocument();
  });
  const updated = await openActions(bob.email);
  expect(within(updated.menu).getByText("Make member")).toBeInTheDocument();
});
test("org-members-tab-026 Confirming removal revokes the selected member from the roster", async () => {
  roster();
  context.mocks.api(orgMembersContract.removeMember, ({ body, respond }) => {
    roster("admin", {
      members: [alice, bob, member("Dora", "admin")].filter((person) => {
        return person.email !== body.email;
      }),
    });
    return respond(200, { message: "Removed" });
  });
  await people();
  const { menu } = await openActions(bob.email);
  click(within(menu).getByText("Remove from workspace"));
  const dialog = await screen.findByRole("dialog", { name: "Remove member?" });
  expect(
    within(dialog).getByText(
      bob.email +
        " will be removed from this workspace and lose access to all resources.",
    ),
  ).toBeInTheDocument();
  click(await action("Remove", dialog));
  await expect(
    screen.findByText("Removed " + bob.email),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    return expect(screen.queryByText(bob.email)).toBeNull();
  });
  expect(screen.getByText(alice.email)).toBeInTheDocument();
});
test("org-members-tab-027 Alice relinquishes her own admin role after reviewing the privilege warning", async () => {
  const dora = member("Dora", "admin");
  let members = [alice, bob, dora];
  const workspace = { id: "org_foundry", name: "Foundry" };
  const actorFor = (request: Request) => {
    const actor = members.find((person) => {
      return (
        request.headers.get("authorization") ===
        "Bearer session-" + person.userId
      );
    });
    if (!actor) {
      throw new Error("Missing workspace member");
    }
    return actor;
  };
  context.mocks.api(orgContract.get, ({ request, respond }) => {
    return respond(200, { ...workspace, role: actorFor(request).role });
  });
  context.mocks.api(orgMembersContract.members, ({ request, respond }) => {
    return respond(200, {
      name: workspace.name,
      role: actorFor(request).role,
      createdAt,
      members,
      pendingInvitations: [],
      membershipRequests: [],
    });
  });
  context.mocks.api(
    orgMembersContract.updateRole,
    ({ request, body, respond }) => {
      if (actorFor(request).role !== "admin") {
        throw new Error("Only admins can change roles");
      }
      members = members.map((person) => {
        return person.email === body.email
          ? { ...person, role: body.role }
          : person;
      });
      return respond(200, { message: "Role changed" });
    },
  );
  const visitPeople = (actor: OrgMember, runtime: TestContext) => {
    return setupPage({
      context: runtime,
      path: "/?settings=people",
      host: "app.okou.ai",
      auth: {
        user: {
          id: actor.userId,
          fullName: actor.firstName ?? actor.email,
          email: actor.email,
        },
        session: { token: "session-" + actor.userId },
        organization: {
          activeOrg: workspace,
          memberships: [{ id: workspace.id, role: "org:" + actor.role }],
        },
      },
    });
  };
  await visitPeople(alice, context);
  const { menu } = await openActions(alice.email);
  click(within(menu).getByText("Switch to member"));
  const confirm = await screen.findByRole("dialog", {
    name: "Switch to member?",
  });
  expect(
    within(confirm).getByText(/lose admin privileges/),
  ).toBeInTheDocument();
  click(await action("Confirm", confirm));
  await expect(
    screen.findByText("Updated role for " + alice.email),
  ).resolves.toBeInTheDocument();
  await expect(
    screen.findByRole("heading", { name: "Preference" }),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByLabelText("Actions for " + alice.email)).toBeNull();
  cleanup();
  await visitPeople(dora, createTestRuntime(context));
  await screen.findByText(alice.email);
  expect(memberRow(alice.email).getByText("Member")).toBeInTheDocument();
  expect(memberRow(dora.email).getByText("Admin")).toBeInTheDocument();
});
test("org-members-tab-018 Accept Carol into the workspace and reject Dan's remaining application", async () => {
  const carol = member("Carol"),
    dan = member("Dan");
  const requests = [carol, dan].map((person) => {
    return {
      ...person,
      id: "request-" + person.userId,
      createdAt,
    };
  });
  const directory = [alice, bob];
  let queue = requests;
  const publish = () => {
    return roster("admin", { members: directory, membershipRequests: queue });
  };
  publish();
  context.mocks.api(
    orgMembershipRequestsContract.accept,
    ({ body, respond }) => {
      const accepted = queue.find((req) => {
        return req.id === body.requestId;
      });
      if (accepted) {
        directory.push(accepted);
      }
      queue = queue.filter((req) => {
        return req.id !== body.requestId;
      });
      publish();
      return respond(200, { message: "Accepted" });
    },
  );
  context.mocks.api(
    orgMembershipRequestsContract.reject,
    ({ body, respond }) => {
      queue = queue.filter((req) => {
        return req.id !== body.requestId;
      });
      publish();
      return respond(200, { message: "Rejected" });
    },
  );
  await people();
  await screen.findByText(carol.email);
  click(memberRow(carol.email).getByLabelText("Accept request"));
  await waitFor(() => {
    return expect(
      memberRow(carol.email).getByText("Member"),
    ).toBeInTheDocument();
  });
  expect(screen.getAllByLabelText("Reject request")).toHaveLength(1);
  click(memberRow(dan.email).getByLabelText("Reject request"));
  await expect(
    screen.findByText("Membership request rejected"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    return expect(screen.queryByText(dan.email)).toBeNull();
  });
  expect(screen.queryByText("Dan")).toBeNull();
});
function fundedPackage() {
  context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
    return respond(200, {
      tier: "pro",
      currentPeriodEnd: null,
      supportsFreeMembers: true,
      allocations: [
        {
          id: "8c5fc10a-fd37-4a31-95c9-0644fc71a918",
          memberId: "alice",
          usagePackUsd: 20,
          currentPeriodEnd: null,
          pendingChange: null,
        },
      ],
    });
  });
}
function priceBook() {
  packages(context);
  context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
    return respond(200, {
      supportsFreeMembers: true,
      usagePacks: [
        {
          usagePackUsd: 20,
          priceUsd: 20,
          purchasedCredits: 20_000,
          bonusCredits: 400,
          totalCredits: 20_400,
        },
      ],
    });
  });
}
test("org-members-tab-002 The admin can inspect their own package pricing and return to Billing", async () => {
  roster();
  priceBook();
  fundedPackage();
  setBilling(context, () => {
    return billing("pro");
  });
  await people();
  const { menu } = await openActions(alice.email);
  click(within(menu).getByText("Configure member packages"));
  await expect(screen.findByText("Step 2 of 3")).resolves.toBeInTheDocument();
  await expect(
    screen.findByLabelText("Usage for Alice"),
  ).resolves.toHaveTextContent("20,400 credits · 2% off");
  click(await action("Close"));
  await expect(
    screen.findByRole("heading", { name: "Billing" }),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("Step 2 of 3")).toBeNull();
});
test("org-members-tab-003 An Atom grant leads through plan choice before member usage", async () => {
  roster();
  priceBook();
  setBilling(context, () => {
    return billing("pro", {
      subscriptionStatus: "atom_grant",
      hasSubscription: false,
    });
  });
  await people();
  await screen.findByText(alice.email);
  expect(memberRow(alice.email).getByText("No package")).toBeInTheDocument();
  const { menu } = await openActions(alice.email);
  click(within(menu).getByText("Configure member packages"));
  await expect(screen.findByText("Choose a plan")).resolves.toBeInTheDocument();
  click(await action("Manage"));
  await expect(
    screen.findByRole("group", { name: "Member usage" }),
  ).resolves.toBeInTheDocument();
});
