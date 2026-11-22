import { publicPlanLifecycle } from "./helpers/public-plan-lifecycle";
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { env, mockEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  createAuthOrgBddApi,
  type ApiTestUser,
} from "./helpers/api-bdd-auth-org";
import { expectApiError } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createFixtureOperationOwner } from "./helpers/fixture-operation-owner";

/*
helper gap:
- AUTH-02 device, desktop, sandbox, realtime, and Okou run-token flows
  need a dedicated token helper; this file covers the CLI PAT flow end to end
  through device authorization and use.
- AUTH-03 built-in/user connector and push subscription flows need their own
  domain helpers; this file covers user-owned secrets, variables, preferences,
  and org custom connector safe metadata.
- ORG-01 logo upload/delete needs a multipart org-logo helper.
*/

const context = testContext();
const api = createAuthOrgBddApi(context);
const runsApi = createRunsApi(context);
const connectors = createConnectorBddApi(context);

function shortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 10);
}

function slug(prefix: string): string {
  return `${prefix}-${shortId()}`;
}

async function onboardAdmin(
  admin: ApiTestUser,
  options: {
    readonly slug?: string;
    readonly name?: string;
  } = {},
): Promise<void> {
  const orgState: { slug?: string; name?: string } = {};
  if (options.slug !== undefined) {
    orgState.slug = options.slug;
  }
  const orgName = options.name;
  if (orgName !== undefined) {
    orgState.name = orgName;
  }
  api.mockClerkOrg(admin, orgState);
  const bootstrap = await api.bootstrapLimitedFreeOnboarding(admin);
  if (bootstrap.status !== 200) {
    throw new Error(
      `Expected onboarding bootstrap to succeed, got ${bootstrap.status}`,
    );
  }
}

async function withOwnedInvitationOrg(
  scenario: () => Promise<void>,
): Promise<void> {
  const storageBucket = env("R2_USER_STORAGES_BUCKET_NAME");
  const kmsKeyId = env("SECRETS_KMS_KEY_ID");
  const owner = createFixtureOperationOwner(async () => {
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", storageBucket);
    mockEnv("SECRETS_KMS_KEY_ID", kmsKeyId);
    context.mocks.s3.send.mockResolvedValue({
      Contents: [],
      IsTruncated: false,
    });
    context.mocks.ably.publish.mockResolvedValue(undefined);
    await flushWaitUntilForTest();
  });
  await owner.run(scenario);
}

describe("AUTH-01 and ORG-03", () => {
  it("reads current identity and completes workspace onboarding", async () => {
    const admin = api.user();
    const noOrg = api.user({ orgId: null });
    const orgSlug = slug("bdd-chain");
    api.acceptStorageWrites();
    api.mockClerkOrg(admin, { slug: orgSlug, name: "BDD Chain Org" });

    const me = await api.readMe(admin);
    expect(me).toStrictEqual({
      userId: admin.userId,
      email: admin.email,
      orgId: admin.orgId,
    });

    const org = await api.readOrg(admin);
    expect(org).toMatchObject({
      id: admin.orgId,
      name: "BDD Chain Org",
      role: "admin",
    });

    const missingOrg = await api.requestReadOrg(noOrg, [404]);
    expectApiError(missingOrg.body);
    expect(missingOrg.body.error.code).toBe("NOT_FOUND");

    await onboardAdmin(admin, {
      slug: orgSlug,
      name: "BDD Chain Org",
    });

    const after = await api.readOnboardingStatus(admin);
    expect(after.onboardingComplete).toBeTruthy();
    const repeatedBootstrap = await api.bootstrapLimitedFreeOnboarding(admin);
    if (repeatedBootstrap.status !== 200) {
      throw new Error(
        `Expected repeated onboarding bootstrap to be idempotent, got ${repeatedBootstrap.status}`,
      );
    }

    const onboardingBilling = await runsApi.readBillingStatus(admin);
    expect(onboardingBilling).toMatchObject({
      tier: "limited-free-1",
      onboardingPaymentPending: false,
    });
  });

  it("reads and caches a Clerk organization whose slug is null", async () => {
    const admin = api.user();
    api.mockClerkOrg(admin, { slug: null, name: "Slugless Workspace" });

    const refreshed = await api.readOrg(admin);
    expect(refreshed).toMatchObject({
      id: admin.orgId,
      name: "Slugless Workspace",
      role: "admin",
    });

    const cached = await api.readOrg(admin);
    expect(cached).toMatchObject({
      id: admin.orgId,
      name: "Slugless Workspace",
      role: "admin",
    });
  });
});

describe("AUTH-03", () => {
  it("manages user preferences through safe visible reads", async () => {
    const admin = api.user();
    await onboardAdmin(admin, { slug: slug("bdd-config") });

    const preferences = await api.updatePreferences(admin, {
      timezone: "UTC",
      locale: "en-US",
      sendMode: "cmd-enter",
      captureNetworkBodiesRemaining: 3,
    });
    expect(preferences).toMatchObject({
      timezone: "UTC",
      sendMode: "cmd-enter",
      captureNetworkBodiesRemaining: 3,
    });
    const readBack = await api.readPreferences(admin);
    expect(readBack).toStrictEqual(preferences);
  });
});

describe("ORG-01 and ORG-02", () => {
  it("uses entitlement status for invitations and allows a reactivated workspace", async () => {
    const admin = api.user();
    api.mockClerkOrg(admin);
    await api.completeOnboarding(admin);
    const plan = publicPlanLifecycle(context, admin);
    await plan.update("canceled");

    const invitation = {
      email: `status-${shortId()}@example.test`,
      role: "member" as const,
    };
    const blocked = await api.requestInviteMember(admin, invitation, [403]);
    expectApiError(blocked.body);
    expect(blocked.body.error.message).toBe(
      "Reactivate your workspace plan to invite members",
    );
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).not.toHaveBeenCalled();

    await plan.update("active");
    const billing = await runsApi.readBillingStatus(admin);
    expect(billing).toMatchObject({
      status: "active",
    });
    await api.inviteMember(admin, invitation);
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ emailAddress: invitation.email }),
    );
  });

  it("projects direct invitation redirects to Okou", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    const admin = api.user();
    await withOwnedInvitationOrg(async () => {
      await onboardAdmin(admin);

      const inviteEmail = `okou-invite-${shortId()}@example.test`;
      context.mocks.clerk.organizations.createOrganizationInvitation.mockResolvedValueOnce(
        { id: `inv_${shortId()}` },
      );
      await api.inviteMember(admin, { email: inviteEmail, role: "member" });
      expect(
        context.mocks.clerk.organizations.createOrganizationInvitation,
      ).toHaveBeenLastCalledWith({
        organizationId: admin.orgId,
        emailAddress: inviteEmail,
        inviterUserId: admin.userId,
        role: "org:member",
        redirectUrl: "https://app.okou.ai",
        privateMetadata: { getStartedClaimId: expect.any(String) },
      });
    });
  });

  it("reads, updates, lists, invites, changes membership, handles requests, and leaves orgs through APIs", async () => {
    const admin = api.user();
    await withOwnedInvitationOrg(async () => {
      const member = api.user({
        orgId: admin.orgId,
        orgRole: "org:member",
        email: `member-${shortId()}@example.test`,
      });
      const requester = api.user({
        orgId: admin.orgId,
        orgRole: "org:member",
        email: `requester-${shortId()}@example.test`,
      });
      const baseSlug = slug("bdd-org");
      const nextSlug = slug("bdd-org-updated");
      const inviteId = `inv_${shortId()}`;
      const requestId = `req_${shortId()}`;

      await onboardAdmin(admin, { slug: baseSlug, name: "BDD Org" });
      api.mockClerkOrg(admin, {
        slug: baseSlug,
        name: "BDD Org",
        members: [
          { actor: admin, role: "org:admin" },
          { actor: member, role: "org:member" },
        ],
        pendingInvitations: [
          {
            id: inviteId,
            email: `invitee-${shortId()}@example.test`,
            role: "org:member",
          },
        ],
        membershipRequests: [{ id: requestId, actor: requester }],
      });

      const adminOrg = await api.readOrg(admin);
      expect(adminOrg).toMatchObject({
        name: "BDD Org",
        role: "admin",
      });

      api.mockClerkOrg(member, {
        slug: baseSlug,
        name: "BDD Org",
        members: [
          { actor: admin, role: "org:admin" },
          { actor: member, role: "org:member" },
        ],
      });
      const memberOrg = await api.readOrg(member);
      expect(memberOrg.role).toBe("member");

      api.mockClerkOrg(admin, {
        slug: nextSlug,
        name: "BDD Org Updated",
        members: [
          { actor: admin, role: "org:admin" },
          { actor: member, role: "org:member" },
        ],
      });
      const updated = await api.updateOrg(admin, { name: "BDD Org Updated" });
      expect(updated).toMatchObject({
        name: "BDD Org Updated",
      });

      api.mockClerkOrg(member, {
        slug: nextSlug,
        name: "BDD Org Updated",
        members: [
          { actor: admin, role: "org:admin" },
          { actor: member, role: "org:member" },
        ],
      });
      const memberUpdate = await api.requestUpdateOrg(
        member,
        { name: "Member Update" },
        [403],
      );
      expectApiError(memberUpdate.body);
      expect(memberUpdate.body.error.code).toBe("FORBIDDEN");

      api.mockClerkOrg(admin, {
        slug: nextSlug,
        name: "BDD Org Updated",
        members: [
          { actor: admin, role: "org:admin" },
          { actor: member, role: "org:member" },
        ],
        pendingInvitations: [
          {
            id: inviteId,
            email: `invitee-${shortId()}@example.test`,
            role: "org:member",
          },
        ],
        membershipRequests: [{ id: requestId, actor: requester }],
      });
      const members = await api.listMembers(admin);
      expect(members.name).toBe("BDD Org Updated");
      expect(members.role).toBe("admin");
      expect(
        members.members.some((candidate) => {
          return (
            candidate.email === member.email && candidate.role === "member"
          );
        }),
      ).toBeTruthy();
      expect(members.pendingInvitations?.[0]?.id).toBe(inviteId);
      expect(members.membershipRequests?.[0]?.id).toBe(requestId);

      const inviteeEmail = `new-member-${shortId()}@example.test`;
      const invite = await api.inviteMember(admin, {
        email: inviteeEmail,
        role: "member",
      });
      expect(invite.message).toContain("Invitation sent");
      expect(
        context.mocks.clerk.organizations.createOrganizationInvitation,
      ).toHaveBeenCalledWith({
        organizationId: admin.orgId,
        emailAddress: inviteeEmail,
        inviterUserId: admin.userId,
        role: "org:member",
        redirectUrl: "http://localhost:3002",
        privateMetadata: { getStartedClaimId: expect.any(String) },
      });

      api.mockClerkOrg(member, {
        slug: nextSlug,
        name: "BDD Org Updated",
        members: [
          { actor: admin, role: "org:admin" },
          { actor: member, role: "org:member" },
        ],
      });
      const forbiddenInvite = await api.requestInviteMember(
        member,
        { email: `forbidden-${shortId()}@example.test`, role: "member" },
        [403],
      );
      expectApiError(forbiddenInvite.body);
      expect(forbiddenInvite.body.error.code).toBe("FORBIDDEN");

      api.mockClerkOrg(admin, {
        slug: nextSlug,
        name: "BDD Org Updated",
        members: [
          { actor: admin, role: "org:admin" },
          { actor: member, role: "org:member" },
        ],
        pendingInvitations: [{ id: inviteId, email: member.email }],
        membershipRequests: [{ id: requestId, actor: requester }],
      });
      await expect(
        api.revokeInvitation(admin, inviteId),
      ).resolves.toStrictEqual({
        message: "Invitation revoked",
      });
      await expect(
        api.updateMemberRole(admin, { email: member.email, role: "admin" }),
      ).resolves.toStrictEqual({
        message: `Updated role for ${member.email}`,
      });
      await expect(
        api.acceptMembershipRequest(admin, { requestId }),
      ).resolves.toStrictEqual({
        message: "Membership request accepted",
      });
      await expect(
        api.rejectMembershipRequest(admin, { requestId }),
      ).resolves.toStrictEqual({
        message: "Membership request rejected",
      });
      await expect(
        api.removeMember(admin, { email: member.email }),
      ).resolves.toStrictEqual({
        message: `Removed ${member.email} from org`,
      });

      api.mockClerkOrg(admin, {
        slug: nextSlug,
        name: "BDD Org Updated",
        members: [{ actor: admin, role: "org:admin" }],
      });
      const afterRemove = await api.listMembers(admin);
      expect(
        afterRemove.members.some((candidate) => {
          return candidate.email === member.email;
        }),
      ).toBeFalsy();

      api.mockClerkOrg(member, {
        slug: nextSlug,
        name: "BDD Org Updated",
        members: [
          { actor: admin, role: "org:admin" },
          { actor: member, role: "org:member" },
        ],
      });
      await expect(api.leaveOrg(member)).resolves.toStrictEqual({
        message: "Left org",
      });

      api.mockClerkOrg(admin, {
        slug: nextSlug,
        name: "BDD Org Updated",
        members: [{ actor: admin, role: "org:admin" }],
      });
      await expect(api.deleteOrg(admin)).resolves.toStrictEqual({
        message: "Organization deleted",
      });
    });
  });
});

describe("ORG-03 onboarding status mapping", () => {
  it("maps onboarding status across setup, payment, and entitlement", async () => {
    const noOrg = api.user({ orgId: null });
    const admin = api.user();
    const member = api.user({ orgId: admin.orgId, orgRole: "org:member" });

    const noOrgStatus = await api.readOnboardingStatus(noOrg);
    expect(noOrgStatus).toStrictEqual({
      needsOnboarding: false,
      onboardingComplete: false,
      isAdmin: false,
      hasOrg: false,
    });

    // A new member has their own source-first onboarding ahead of them.
    const memberStatus = await api.readOnboardingStatus(member);
    expect(memberStatus).toStrictEqual({
      needsOnboarding: true,
      onboardingComplete: false,
      isAdmin: false,
      hasOrg: true,
    });

    api.acceptStorageWrites();
    const adminBeforeSetup = await api.readOnboardingStatus(admin);
    expect(adminBeforeSetup).toMatchObject({
      needsOnboarding: true,
      onboardingComplete: false,
      isAdmin: true,
      hasOrg: true,
    });
    await api.provisionWorkspace(admin);
    const bootstrappedBilling = await runsApi.readBillingStatus(admin);
    expect(bootstrappedBilling).toMatchObject({
      credits: 0,
      creditGrants: [],
      tier: "limited-free-1",
      onboardingPaymentPending: false,
    });
    await expect(runsApi.readUsagePackCredits(admin)).resolves.toMatchObject({
      totalCredits: 1000,
      purchasedCredits: 0,
      bonusCredits: 1000,
    });

    // A member's completion is their own and leaves the workspace's setup to
    // the admin.
    const memberComplete = await api.completeOnboarding(member);
    expect(memberComplete.status).toBe(200);
    await expect(api.readOnboardingStatus(admin)).resolves.toMatchObject({
      needsOnboarding: true,
      onboardingComplete: false,
      isAdmin: true,
    });

    const completed = await api.completeOnboarding(admin);
    expect(completed.status).toBe(200);
    expect(completed.body).toStrictEqual({
      onboardingComplete: true,
      needsOnboarding: false,
    });
    const adminAfterComplete = await api.readOnboardingStatus(admin);
    expect(adminAfterComplete).toMatchObject({
      needsOnboarding: false,
      onboardingComplete: true,
      isAdmin: true,
      hasOrg: true,
    });

    await runsApi.grantProEntitlement(admin);
    const entitled = await api.readOnboardingStatus(admin);
    expect(entitled).toStrictEqual({
      needsOnboarding: false,
      onboardingComplete: true,
      isAdmin: true,
      hasOrg: true,
    });

    const orphaned = await api.readOnboardingStatus(admin);
    expect(orphaned).toMatchObject({
      needsOnboarding: false,
      onboardingComplete: true,
      isAdmin: true,
      hasOrg: true,
    });
    const preservedPaidBilling = await runsApi.readBillingStatus(admin);
    expect(preservedPaidBilling).toMatchObject({
      tier: "pro",
    });
  });
});

describe("workspace custom connector connection", () => {
  it("connects a workspace custom connector", async () => {
    const admin = api.user();
    await onboardAdmin(admin);
    const connectorSlug = `_${slug("bdd-connector")}`;
    const connector = await api.createCustomConnector(
      admin,
      manualHttpCustomConnectorCreateBody({
        displayName: "BDD Custom Connector",
        prefixTemplates: [`https://${connectorSlug}.example.test/api/`],
        slug: connectorSlug,
      }),
    );
    expect(connector).toMatchObject({
      slug: connectorSlug,
      displayName: "BDD Custom Connector",
    });

    await api.setCustomConnectorSecret(
      admin,
      connector.id,
      "custom-connector-secret",
    );
    const builtinConnectorList = await api.listCustomConnectors(admin);
    const listedConnector = builtinConnectorList.connectors.find(
      (candidate) => {
        return candidate.id === connector.id;
      },
    );
    expect(listedConnector).toBeDefined();
    await expect(
      connectors.listCustomConnectorAccounts(admin, connector.id),
    ).resolves.toStrictEqual([
      expect.objectContaining({
        connectionStatus: "connected",
      }),
    ]);
    expect(JSON.stringify(builtinConnectorList)).not.toContain(
      "custom-connector-secret",
    );

    await api.deleteDefaultCustomConnectorAccount(admin, connector.id);
    const afterDisconnect = await api.listCustomConnectors(admin);
    expect(
      afterDisconnect.connectors.some((candidate) => {
        return candidate.id === connector.id;
      }),
    ).toBeTruthy();
    await expect(
      connectors.listCustomConnectorAccounts(admin, connector.id),
    ).resolves.toStrictEqual([]);
    await api.deleteCustomConnector(admin, connector.id);
    const afterDelete = await api.listCustomConnectors(admin);
    expect(
      afterDelete.connectors.some((candidate) => {
        return candidate.id === connector.id;
      }),
    ).toBeFalsy();
  });
});
