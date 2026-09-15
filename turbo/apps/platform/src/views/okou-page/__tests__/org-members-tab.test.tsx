import type { OrgMembersResponse } from "@okouai/api-contracts/contracts/org-members";
import {
  orgInviteContract,
  orgMembersContract,
  orgMembershipRequestsContract,
} from "@okouai/api-contracts/contracts/org-member-routes";
import {
  billingStatusContract,
  billingUsagePackCatalogContract,
  billingUsagePackManagementContract,
  type BillingStatusResponse,
  type UsagePackManagementResponse,
} from "@okouai/api-contracts/contracts/billing";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  setupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { billingPlanCapabilities } from "../../../mocks/handlers/api-billing.ts";

const context = testContext();

function buttonByText(
  text: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
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

function mockMembersStory(
  onInvite?: (invite: {
    readonly email: string;
    readonly role: string;
  }) => void,
  role: "admin" | "member" = "admin",
  initialRoster: "all" | "owner" = "all",
): {
  readonly addPendingInvitation: (
    invitation: NonNullable<OrgMembersResponse["pendingInvitations"]>[number],
  ) => void;
} {
  let response: OrgMembersResponse = {
    name: "Test Org",
    role,
    createdAt: "2026-01-01T00:00:00Z",
    members: [
      {
        userId: "test-user-123",
        email: "alice@example.com",
        firstName: "Alice",
        lastName: "Admin",
        imageUrl: "",
        role,
        joinedAt: "2026-01-01T00:00:00Z",
      },
      {
        userId: "user-bob",
        email: "bob@example.com",
        firstName: "Bob",
        lastName: "Member",
        imageUrl: "https://example.test/bob.png",
        role: "member",
        joinedAt: "2026-01-02T00:00:00Z",
      },
      {
        userId: "user-eve",
        email: "eve@example.com",
        firstName: "Eve",
        lastName: "Admin",
        imageUrl: "",
        role: "admin",
        joinedAt: "2026-01-02T12:00:00Z",
      },
    ],
    pendingInvitations: [
      {
        id: "inv-pending",
        email: "pending@example.com",
        role: "member",
        createdAt: "2026-01-03T00:00:00Z",
      },
    ],
    membershipRequests: [
      {
        id: "req-carol",
        userId: "user-carol",
        email: "carol@example.com",
        firstName: "Carol",
        lastName: "Request",
        imageUrl: "",
        createdAt: "2026-01-04T00:00:00Z",
      },
      {
        id: "req-dan",
        userId: "user-dan",
        email: "dan@example.com",
        firstName: "Dan",
        lastName: "Reject",
        imageUrl: "",
        createdAt: "2026-01-05T00:00:00Z",
      },
    ],
  };

  if (initialRoster === "owner") {
    response = {
      ...response,
      members: response.members.slice(0, 1),
      pendingInvitations: [],
      membershipRequests: [],
    };
  }

  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role,
  });
  context.mocks.api(orgMembersContract.members, ({ respond }) => {
    return respond(200, response);
  });
  context.mocks.api(orgInviteContract.invite, ({ body, respond }) => {
    onInvite?.(body);
    response = {
      ...response,
      pendingInvitations: [
        ...(response.pendingInvitations ?? []),
        {
          id: "inv-new",
          email: body.email,
          role: body.role,
          createdAt: "2026-01-05T00:00:00Z",
        },
      ],
    };
    return respond(200, { message: "Invitation sent" });
  });
  context.mocks.api(orgInviteContract.revoke, ({ body, respond }) => {
    response = {
      ...response,
      pendingInvitations: response.pendingInvitations?.filter((candidate) => {
        return candidate.id !== body.invitationId;
      }),
    };
    return respond(200, { message: "Invitation revoked" });
  });
  context.mocks.api(orgMembersContract.updateRole, ({ body, respond }) => {
    response = {
      ...response,
      members: response.members.map((member) => {
        return member.email === body.email
          ? { ...member, role: body.role }
          : member;
      }),
    };
    return respond(200, { message: "Role updated" });
  });
  context.mocks.api(orgMembersContract.removeMember, ({ body, respond }) => {
    response = {
      ...response,
      members: response.members.filter((member) => {
        return member.email !== body.email;
      }),
    };
    return respond(200, { message: "Member removed" });
  });
  context.mocks.api(
    orgMembershipRequestsContract.accept,
    ({ body, respond }) => {
      const request = response.membershipRequests?.find((candidate) => {
        return candidate.id === body.requestId;
      });
      response = {
        ...response,
        membershipRequests: response.membershipRequests?.filter((candidate) => {
          return candidate.id !== body.requestId;
        }),
        members: request
          ? [
              ...response.members,
              {
                userId: request.userId,
                email: request.email,
                firstName: request.firstName,
                lastName: request.lastName,
                imageUrl: request.imageUrl,
                role: "member",
                joinedAt: "2026-01-06T00:00:00Z",
              },
            ]
          : response.members,
      };
      return respond(200, { message: "Request accepted" });
    },
  );
  context.mocks.api(
    orgMembershipRequestsContract.reject,
    ({ body, respond }) => {
      response = {
        ...response,
        membershipRequests: response.membershipRequests?.filter((candidate) => {
          return candidate.id !== body.requestId;
        }),
      };
      return respond(200, { message: "Request rejected" });
    },
  );
  return {
    addPendingInvitation(invitation) {
      response = {
        ...response,
        pendingInvitations: [
          ...(response.pendingInvitations ?? []),
          invitation,
        ],
      };
    },
  };
}

function mockMemberInviteEntitlement(
  showUsagePack: boolean,
  invitation?: {
    readonly tier: string;
    readonly status?: "active" | "suspended";
  },
  overrides: Partial<BillingStatusResponse> = {},
): void {
  const response: BillingStatusResponse = {
    tier: invitation?.tier ?? "pro",
    ...billingPlanCapabilities(invitation?.tier ?? "pro"),
    showUsagePack,
    ...(invitation?.status === undefined ? {} : { status: invitation.status }),
    credits: 0,
    onboardingPaymentPending: false,
    subscriptionStatus: "active",
    currentPeriodEnd: "2026-09-01T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    scheduledChange: null,
    hasSubscription: true,
    autoRecharge: { enabled: false, threshold: null, amount: null },
    creditExpiry: { expiringNextCycle: 0, nextExpiryDate: null },
    creditBreakdown: [],
    creditGrants: [],
    concurrencyLimit: 1,
    concurrencySubscriptions: [],
    ...overrides,
  };
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, response);
  });
}

function mockUsagePackManagement(
  overrides: Partial<UsagePackManagementResponse> = {},
): void {
  context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
    return respond(200, {
      tier: "pro",
      supportsFreeMembers: true,
      currentPeriodEnd: "2026-09-01T00:00:00.000Z",
      allocations: [
        {
          id: "a99c2cd1-b012-4ba5-952f-3aa9b707d0c6",
          memberId: "test-user-123",
          usagePackUsd: 20,
          currentPeriodEnd: "2026-09-01T00:00:00.000Z",
          pendingChange: null,
        },
        {
          id: "d0b55925-a0b3-4dd2-a433-f114bdf6cd2a",
          memberId: "user-bob",
          usagePackUsd: 50,
          currentPeriodEnd: "2026-09-01T00:00:00.000Z",
          pendingChange: null,
        },
        {
          id: "4875750e-c7a1-4740-bafb-3466443955f4",
          memberId: "user-eve",
          usagePackUsd: 100,
          currentPeriodEnd: "2026-09-01T00:00:00.000Z",
          pendingChange: null,
        },
      ],
      ...overrides,
    });
  });
}

function mockUsagePackCatalog(): void {
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
        {
          usagePackUsd: 50,
          priceUsd: 50,
          purchasedCredits: 50_000,
          bonusCredits: 2600,
          totalCredits: 52_600,
        },
        {
          usagePackUsd: 100,
          priceUsd: 100,
          purchasedCredits: 100_000,
          bonusCredits: 8700,
          totalCredits: 108_700,
        },
        {
          usagePackUsd: 200,
          priceUsd: 200,
          purchasedCredits: 200_000,
          bonusCredits: 22_200,
          totalCredits: 222_200,
        },
      ],
    });
  });
}

async function openMembersTab(): Promise<void> {
  mockMemberInviteEntitlement(false);
  await setupPage({
    context,
    path: "/?settings=people",
  });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "People" })).toBeInTheDocument();
  });
}

function rowByEmail(email: string): HTMLElement {
  const row = screen.getByText(email).closest(".grid");
  if (!(row instanceof HTMLElement)) {
    throw new Error(`${email} member row not found`);
  }
  return row;
}

test("Show a scheduled package change on a pending invitation", async () => {
  mockMembersStory();
  mockMemberInviteEntitlement(true);
  context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
    return respond(200, {
      tier: "pro",
      supportsFreeMembers: true,
      currentPeriodEnd: "2026-09-01T00:00:00.000Z",
      allocations: [
        {
          id: "4875750e-c7a1-4740-bafb-3466443955f4",
          memberId: "user-eve",
          usagePackUsd: 100,
          currentPeriodEnd: "2026-09-01T00:00:00.000Z",
          pendingChange: {
            id: "8044563e-ef31-4fb6-aa31-e7ecb2b1a5f6",
            kind: "downgrade",
            status: "scheduled",
            targetUsagePackUsd: 50,
            effectiveAt: "2026-09-01T00:00:00.000Z",
          },
        },
      ],
    });
  });

  await setupPage({
    context,
    path: "/?settings=people",
  });

  await expect(screen.findByText("Usage pack")).resolves.toBeInTheDocument();
  const eveRow = rowByEmail("eve@example.com");
  expect(within(eveRow).getByText("$100/month")).toBeVisible();
  expect(
    within(eveRow).getByText("Downgrades to $50 on Sep 1, 2026."),
  ).toBeVisible();
  expect(
    within(rowByEmail("alice@example.com")).queryByText(/Downgrades to/u),
  ).not.toBeInTheDocument();
});

test("Configure a member’s package from People", async () => {
  mockMembersStory(undefined, "admin", "owner");
  mockMemberInviteEntitlement(true);
  mockUsagePackManagement();
  mockUsagePackCatalog();

  await setupPage({
    context,
    path: "/agents?settings=people",
  });
  await expect(screen.findByText("Usage pack")).resolves.toBeInTheDocument();

  click(screen.getByLabelText("Actions for alice@example.com"));
  click(menuItemByText("Configure member packages"));

  await expect(
    screen.findByRole("heading", { name: "Billing" }),
  ).resolves.toBeInTheDocument();
  const memberUsage = await screen.findByRole("group", {
    name: "Member usage",
  });
  expect(
    within(memberUsage).getByRole("combobox", {
      name: "Usage for Test User",
    }),
  ).toHaveTextContent("20,400 credits · 2% off");
});

test.each(["pro", "team"])(
  "Configure an Atom %s plan before purchasing any packages",
  async (tier) => {
    mockMembersStory();
    mockMemberInviteEntitlement(true, undefined, {
      tier,
      showUsagePack: true,
      subscriptionStatus: "atom_grant",
      hasSubscription: false,
    });
    mockUsagePackCatalog();
    context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "No usage pack subscription" },
      });
    });

    await setupPage({ context, path: "/?settings=people" });

    await expect(screen.findByText("Usage pack")).resolves.toBeVisible();
    expect(
      within(rowByEmail("bob@example.com")).getByText("No package"),
    ).toBeVisible();
    const email = tier === "pro" ? "alice@example.com" : "bob@example.com";
    click(screen.getByLabelText(`Actions for ${email}`));
    click(menuItemByText("Configure member packages"));
    await expect(
      screen.findByRole("heading", { name: "Choose a plan" }),
    ).resolves.toBeVisible();
    const plan = screen.getByRole("article", {
      name: tier === "pro" ? "Pro plan" : "Team plan",
    });
    click(buttonByText("Manage", plan));
    await expect(
      screen.findByRole("group", { name: "Member usage" }),
    ).resolves.toBeVisible();
  },
);

test("Hide People package controls when showUsagePack is false, even with a subscription", async () => {
  mockMembersStory();
  mockMemberInviteEntitlement(true, undefined, { showUsagePack: false });
  mockUsagePackManagement();

  await setupPage({ context, path: "/?settings=people" });
  await expect(screen.findByText("bob@example.com")).resolves.toBeVisible();
  expect(screen.queryByText("Usage pack")).not.toBeInTheDocument();
  click(screen.getByLabelText("Actions for bob@example.com"));
  expect(
    queryAllByRoleFast("menuitem").some((item) => {
      return item.textContent === "Configure member packages";
    }),
  ).toBeFalsy();
});

test("Keep People package controls restricted to administrators", async () => {
  mockMembersStory(undefined, "member");
  mockMemberInviteEntitlement(true);
  mockUsagePackManagement();

  await setupPage({ context, path: "/?settings=people" });
  await expect(
    screen.findByRole("heading", { name: "Preference" }),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("Usage pack")).not.toBeInTheDocument();
  expect(
    screen.queryByLabelText("Actions for bob@example.com"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByLabelText("Actions for alice@example.com"),
  ).not.toBeInTheDocument();
});

test.each(["free", "limited-free-1", "pro", "team"])(
  "Invite members on active %s plans",
  async (tier) => {
    mockMembersStory();
    mockMemberInviteEntitlement(
      false,
      { tier, status: "active" },
      {
        hasSubscription: tier === "pro" || tier === "team",
      },
    );

    await setupPage({
      context,
      path: "/?settings=people",
    });
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "People" }),
      ).toBeInTheDocument();
    });
    click(buttonByText("Add member"));
    const inviteDialog = await screen.findByRole("dialog", {
      name: "Invite member",
    });
    await fill(
      await within(inviteDialog).findByPlaceholderText("email@example.com"),
      "legacy.invitee@example.com",
    );
    const send = buttonByText("Send invitation", inviteDialog);
    await waitFor(() => {
      expect(send).toBeEnabled();
    });
    expect(
      within(inviteDialog).queryByText("Member packages"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Usage pack")).not.toBeInTheDocument();
    click(send);

    await waitFor(() => {
      expect(
        screen.getByText("legacy.invitee@example.com"),
      ).toBeInTheDocument();
    });
  },
);

test.each([
  { tier: "pro", hasSubscription: true },
  { tier: "team", hasSubscription: true },
  { tier: "pro", hasSubscription: false },
  { tier: "team", hasSubscription: false },
] as const)(
  "Invite a member after selecting No package on $tier (subscription: $hasSubscription)",
  async ({ tier, hasSubscription }) => {
    mockMembersStory(undefined, "admin", "owner");
    mockMemberInviteEntitlement(
      true,
      { tier, status: "active" },
      { hasSubscription },
    );
    if (hasSubscription) {
      mockUsagePackManagement({
        tier,
        supportsFreeMembers: true,
        allocations: [],
      });
    } else {
      context.mocks.api(
        billingUsagePackManagementContract.get,
        ({ respond }) => {
          return respond(404, {
            error: { code: "NOT_FOUND", message: "No usage pack subscription" },
          });
        },
      );
    }
    mockUsagePackCatalog();

    await setupPage({ context, path: "/agents?settings=people" });
    await screen.findByRole("heading", { name: "People" });
    click(buttonByText("Add member"));
    const inviteDialog = await screen.findByRole("dialog", {
      name: "Invite member",
    });
    const packages = await within(inviteDialog).findByRole("combobox", {
      name: "Member packages",
    });
    expect(packages).toHaveTextContent("20,400 credits");
    await fill(
      within(inviteDialog).getByPlaceholderText("email@example.com"),
      "free.invitee@example.com",
    );

    click(packages);
    click(await screen.findByRole("option", { name: /52,600 credits/u }));
    await waitFor(() => {
      expect(
        buttonByText(
          hasSubscription ? "Continue" : "Configure member packages",
          inviteDialog,
        ),
      ).toBeEnabled();
    });
    click(packages);
    click(await screen.findByRole("option", { name: "No package" }));
    await waitFor(() => {
      expect(buttonByText("Send invitation", inviteDialog)).toBeEnabled();
    });
    click(buttonByText("Send invitation", inviteDialog));

    await screen.findByText("free.invitee@example.com");
    expect(
      screen.queryByRole("dialog", { name: "Review invitation" }),
    ).not.toBeInTheDocument();
  },
);

test.each(["pro", "team"] as const)(
  "Configure packages from an Atom %s invitation before paying",
  async (tier) => {
    mockMembersStory();
    mockMemberInviteEntitlement(
      true,
      { tier, status: "active" },
      {
        hasSubscription: false,
        subscriptionStatus: "atom_grant",
      },
    );
    mockUsagePackCatalog();
    context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "No usage pack subscription" },
      });
    });

    await setupPage({ context, path: "/?settings=people" });
    await screen.findByRole("heading", { name: "People" });
    click(buttonByText("Add member"));
    const invite = await screen.findByRole("dialog", { name: "Invite member" });
    const packages = await within(invite).findByRole("combobox", {
      name: "Member packages",
    });
    click(packages);
    click(await screen.findByRole("option", { name: /52,600 credits/u }));
    await waitFor(() => {
      expect(buttonByText("Configure member packages", invite)).toBeEnabled();
    });
    click(buttonByText("Configure member packages", invite));
    await expect(
      screen.findByRole("heading", { name: "Choose a plan" }),
    ).resolves.toBeVisible();
  },
);

test("Use the default $20 package when inviting a member", async () => {
  mockMembersStory();
  mockMemberInviteEntitlement(
    true,
    { tier: "pro", status: "active" },
    { hasSubscription: true },
  );
  mockUsagePackManagement({ supportsFreeMembers: true });
  mockUsagePackCatalog();
  context.mocks.api(orgInviteContract.previewPurchase, ({ body, respond }) => {
    expect(body).toMatchObject({
      email: "default-package@example.com",
      role: "member",
      usagePackUsd: 20,
      supportsInAppPreview: true,
    });
    return respond(200, {
      purchaseId: "67d0ac76-170e-4a99-a5b6-ecc74c1179df",
      usagePackUsd: 20,
      immediateAmountCents: 500,
      currency: "usd",
      purchasedCredits: 5000,
      bonusCredits: 100,
      totalCredits: 5100,
      currentPeriodEnd: "2026-09-01T00:00:00.000Z",
      expiresAt: "2026-08-10T00:00:00.000Z",
      paymentMethodPreviewToken: "default-package-preview",
    });
  });

  await setupPage({ context, path: "/?settings=people" });
  await screen.findByRole("heading", { name: "People" });
  click(buttonByText("Add member"));
  const inviteDialog = await screen.findByRole("dialog", {
    name: "Invite member",
  });
  await expect(
    within(inviteDialog).findByRole("combobox", {
      name: "Member packages",
    }),
  ).resolves.toHaveTextContent("20,400 credits");
  await fill(
    within(inviteDialog).getByPlaceholderText("email@example.com"),
    "default-package@example.com",
  );
  click(buttonByText("Continue", inviteDialog));

  const confirmation = await screen.findByRole("dialog", {
    name: "Review invitation",
  });
  expect(within(confirmation).getByText("$5.00")).toBeVisible();
  expect(within(confirmation).getByText(/5,100 credits/u)).toBeVisible();
});

const PAID_INVITATION_SCENARIOS = ["pro", "team"] as const;
async function preparePaidInvitation(tier: "pro" | "team") {
  const story = mockMembersStory(undefined, "admin", "owner");
  mockMemberInviteEntitlement(true, { tier, status: "active" });
  mockUsagePackManagement({ tier });
  mockUsagePackCatalog();
  const purchaseId = "67d0ac76-170e-4a99-a5b6-ecc74c1179df";
  context.mocks.api(orgInviteContract.previewPurchase, ({ body, respond }) => {
    expect(body).toMatchObject({
      email: "paid.invitee@example.com",
      role: "member",
      usagePackUsd: 50,
      supportsInAppPreview: true,
    });
    return respond(200, {
      purchaseId,
      usagePackUsd: 50,
      immediateAmountCents: 1250,
      currency: "usd",
      purchasedCredits: 12_500,
      bonusCredits: 650,
      totalCredits: 13_150,
      currentPeriodEnd: "2026-09-01T00:00:00.000Z",
      expiresAt: "2026-08-10T00:00:00.000Z",
      paymentMethodPreviewToken: "invite-payment-preview",
    });
  });
  context.mocks.api(
    orgInviteContract.confirmPurchase,
    ({ body, params, respond }) => {
      expect(params.purchaseId).toBe(purchaseId);
      expect(body).toStrictEqual({
        paymentMethodPreviewToken: "invite-payment-preview",
      });
      story.addPendingInvitation({
        id: "inv-paid",
        email: "paid.invitee@example.com",
        role: "member",
        createdAt: "2026-08-01T00:00:00.000Z",
        usagePackUsd: 50,
      });
      return respond(200, { message: "Invitation sent" });
    },
  );
  await setupPage({ context, path: "/?settings=people" });
  await screen.findByRole("heading", { name: "People" });
  click(buttonByText("Add member"));
  const inviteDialog = await screen.findByRole("dialog", {
    name: "Invite member",
  });
  const packages = await within(inviteDialog).findByRole("combobox", {
    name: "Member packages",
  });
  expect(packages).toHaveTextContent("20,400 credits");
  await fill(
    within(inviteDialog).getByPlaceholderText("email@example.com"),
    "paid.invitee@example.com",
  );
  click(packages);
  expect(
    queryAllByRoleFast("option").some((option) => {
      return option.textContent?.trim() === "No package";
    }),
  ).toBeTruthy();
  click(
    await waitFor(() => {
      const option = queryAllByRoleFast("option").find((candidate) => {
        return candidate.textContent?.includes("52,600 credits");
      });
      if (!option) {
        throw new Error("Expected the 52,600-credit member package");
      }
      return option;
    }),
  );
  await waitFor(() => {
    expect(buttonByText("Continue", inviteDialog)).toBeEnabled();
  });
  click(buttonByText("Continue", inviteDialog));
  const confirmation = await screen.findByRole("dialog", {
    name: "Review invitation",
  });
  return { confirmation };
}

test.each(PAID_INVITATION_SCENARIOS)(
  "Review a paid invitation on %s",
  async (tier) => {
    const { confirmation } = await preparePaidInvitation(tier);
    expect(within(confirmation).getByText("$12.50")).toBeVisible();
    expect(
      within(confirmation).getByText("paid.invitee@example.com"),
    ).toBeVisible();
  },
);

test.each(PAID_INVITATION_SCENARIOS)(
  "Purchase an invitation and reset its package on %s",
  async (tier) => {
    const { confirmation } = await preparePaidInvitation(tier);
    click(buttonByText("Pay and invite", confirmation));
    await waitFor(() => {
      expect(rowByEmail("paid.invitee@example.com")).toBeVisible();
    });
    expect(
      within(rowByEmail("paid.invitee@example.com")).getByText("$50/month"),
    ).toBeVisible();
    click(buttonByText("Add member"));
    const nextInvite = await screen.findByRole("dialog", {
      name: "Invite member",
    });
    await expect(
      within(nextInvite).findByRole("combobox", {
        name: "Member packages",
      }),
    ).resolves.toHaveTextContent("20,400 credits");
  },
);

test.each([
  { tier: "pro", status: "suspended" },
  { tier: "pro-suspend" },
] as const)("Block invitations on suspended plans ($tier)", async (plan) => {
  mockMembersStory();
  mockMemberInviteEntitlement(false, plan);
  mockUsagePackCatalog();

  await setupPage({
    context,
    path: "/?settings=people",
  });
  await waitFor(() => {
    expect(screen.getByRole("heading", { name: "People" })).toBeInTheDocument();
  });
  click(buttonByText("Add member"));
  const inviteDialog = await screen.findByRole("dialog", {
    name: "Reactivate to invite members",
  });
  expect(
    within(inviteDialog).getByText(
      /Reactivate your workspace plan to invite members/u,
    ),
  ).toBeVisible();
  expect(
    within(inviteDialog).queryByPlaceholderText("email@example.com"),
  ).not.toBeInTheDocument();
  expect(within(inviteDialog).queryByText("Role")).not.toBeInTheDocument();
  const viewPlans = buttonByText("View plans", inviteDialog);
  expect(viewPlans).toBeEnabled();
  click(viewPlans);

  await expect(
    screen.findByRole("heading", { name: "Choose a plan" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.queryByRole("dialog", { name: "Reactivate to invite members" }),
  ).not.toBeInTheDocument();
});

test("Accept and reject workspace membership requests", async () => {
  mockMembersStory();
  await openMembersTab();

  expect(screen.getByText("Carol Request")).toBeInTheDocument();
  expect(screen.getByText("Dan Reject")).toBeInTheDocument();
  expect(screen.getAllByTitle("Accept request")).toHaveLength(2);

  click(screen.getAllByTitle("Accept request")[0]!);

  await waitFor(() => {
    expect(
      within(rowByEmail("carol@example.com")).getByText("Member"),
    ).toBeInTheDocument();
    expect(screen.getAllByTitle("Accept request")).toHaveLength(1);
  });
  expect(screen.getByText("Dan Reject")).toBeInTheDocument();

  click(screen.getByTitle("Reject request"));

  await waitFor(() => {
    expect(screen.getByText("Membership request rejected")).toBeInTheDocument();
    expect(screen.queryByText("Dan Reject")).not.toBeInTheDocument();
    expect(screen.queryByText("dan@example.com")).not.toBeInTheDocument();
  });
});

test("Promote a workspace member to administrator", async () => {
  mockMembersStory();
  await openMembersTab();

  click(screen.getByLabelText("Actions for bob@example.com"));
  click(menuItemByText("Make admin"));

  await waitFor(() => {
    expect(
      screen.getByText("Updated role for bob@example.com"),
    ).toBeInTheDocument();
    expect(
      within(rowByEmail("bob@example.com")).getByText("Admin"),
    ).toBeInTheDocument();
  });

  click(screen.getByLabelText("Actions for bob@example.com"));
  expect(menuItemByText("Make member")).toBeInTheDocument();
});

test("Remove another member from the workspace", async () => {
  mockMembersStory();
  await openMembersTab();

  click(screen.getByLabelText("Actions for bob@example.com"));
  click(menuItemByText("Remove from workspace"));

  const removeDialog = await screen.findByRole("dialog", {
    name: "Remove member?",
  });
  expect(
    within(removeDialog).getByText(/lose access to all resources/u),
  ).toBeInTheDocument();
  expect(
    within(removeDialog).getByText(/bob@example\.com/u),
  ).toBeInTheDocument();
  expect(screen.getByText("bob@example.com")).toBeInTheDocument();
  click(buttonByText("Remove", removeDialog));

  await waitFor(() => {
    expect(screen.getByText("Removed bob@example.com")).toBeInTheDocument();
    expect(screen.queryByText("bob@example.com")).not.toBeInTheDocument();
  });
});

test("Demote yourself from workspace administrator", async () => {
  mockMembersStory();
  await openMembersTab();

  click(screen.getByLabelText("Actions for alice@example.com"));
  click(menuItemByText("Switch to member"));

  const selfDemoteDialog = await screen.findByRole("dialog", {
    name: "Switch to member?",
  });
  expect(
    within(selfDemoteDialog).getByText(/lose admin privileges/u),
  ).toBeInTheDocument();
  click(buttonByText("Confirm", selfDemoteDialog));

  await waitFor(() => {
    expect(
      screen.getByText("Updated role for alice@example.com"),
    ).toBeInTheDocument();
    expect(
      within(rowByEmail("alice@example.com")).getByText("Member"),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Actions for alice@example.com"),
    ).not.toBeInTheDocument();
  });
});

test("Explain package and credit effects before removing a member", async () => {
  mockMembersStory();
  mockMemberInviteEntitlement(true);
  mockUsagePackManagement();

  await setupPage({
    context,
    path: "/?settings=people",
  });
  await expect(screen.findByText("Usage pack")).resolves.toBeInTheDocument();

  click(screen.getByLabelText("Actions for bob@example.com"));
  click(menuItemByText("Remove from workspace"));

  const removeDialog = await screen.findByRole("dialog", {
    name: "Remove member?",
  });
  expect(
    within(removeDialog).getByText("Usage pack impact"),
  ).toBeInTheDocument();
  expect(
    within(removeDialog).getByText(/credits become unavailable immediately/u),
  ).toBeInTheDocument();
  expect(
    within(removeDialog).getByText(
      /package is removed at the end of the current billing period/u,
    ),
  ).toBeInTheDocument();
  expect(
    within(removeDialog).getByText(
      /unused purchased-credit portion is returned/u,
    ),
  ).toBeInTheDocument();
  expect(
    within(removeDialog).getByText(
      /used credits and bonus credits are not refundable/iu,
    ),
  ).toBeInTheDocument();
  expect(screen.getByText("bob@example.com")).toBeInTheDocument();
});

test.each(["Cancel", "Revoke"] as const)(
  "%s a pending workspace invitation revocation",
  async (action) => {
    mockMembersStory();
    await openMembersTab();

    await fill(screen.getByPlaceholderText("Search"), "pending");
    await waitFor(() => {
      expect(screen.getByText("pending@example.com")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Actions for pending@example.com"));
    click(menuItemByText("Revoke invitation"));

    const cancelRevokeDialog = await screen.findByRole("dialog", {
      name: "Revoke invitation?",
    });
    expect(
      within(cancelRevokeDialog).getByText(
        /will no longer be able to join using this invitation/i,
      ),
    ).toBeInTheDocument();
    click(buttonByText(action, cancelRevokeDialog));
    await waitFor(() => {
      expect(screen.queryAllByText("pending@example.com")).toHaveLength(
        action === "Cancel" ? 1 : 0,
      );
      expect(screen.queryAllByText("Invitation revoked")).toHaveLength(
        action === "Revoke" ? 1 : 0,
      );
    });
  },
);
