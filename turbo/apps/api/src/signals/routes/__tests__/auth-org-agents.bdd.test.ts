import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { upsertOrgPlanEntitlementFixture } from "../../../test-fixtures/org-plan-entitlement";
import {
  createAuthOrgAgentsBddApi,
  type ApiTestUser,
} from "./helpers/api-bdd-auth-org";
import { createBddApi, expectApiError } from "./helpers/api-bdd";
import { manualHttpCustomConnectorCreateBody } from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";

/*
helper gap:
- AUTH-02 device, desktop, sandbox, realtime, and Okou run-token flows
  need a dedicated token helper; this file covers the CLI PAT flow end to end
  through device authorization and use.
- AUTH-03 built-in/user connector and push subscription flows need their own
  domain helpers; this file covers user-owned secrets, variables, preferences,
  and org custom connector safe metadata.
- ORG-01 logo upload/delete needs a multipart org-logo helper.
- AGENT-02 has no default-agent GET route; assertions use onboarding status as
  the visible read model for the selected default agent.
*/

const context = testContext();
const api = createAuthOrgAgentsBddApi(context);
const bdd = createBddApi(context);
const runsApi = createRunsApi(context);
const DEFAULT_AGENT_AVATAR_URL =
  "https://static.vm0.io/public/default-agent-avatar-ceb298b79964.svg";

function shortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 10);
}

function slug(prefix: string): string {
  return `${prefix}-${shortId()}`;
}

function requiredOrgId(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Expected an organization-scoped actor");
  }
  return actor.orgId;
}

async function onboardAdmin(
  admin: ApiTestUser,
  options: {
    readonly displayName?: string;
    readonly workspaceName?: string;
    readonly slug?: string;
    readonly name?: string;
  } = {},
): Promise<string> {
  const orgState: { slug?: string; name?: string } = {};
  if (options.slug !== undefined) {
    orgState.slug = options.slug;
  }
  const orgName = options.name ?? options.workspaceName;
  if (orgName !== undefined) {
    orgState.name = orgName;
  }
  api.mockClerkOrg(admin, orgState);
  const bootstrap = await api.bootstrapLimitedFreeOnboarding(admin, {
    displayName: options.displayName ?? "BDD Default Agent",
    sound: "calm",
  });
  if (bootstrap.status !== 200) {
    throw new Error(
      `Expected onboarding bootstrap to succeed, got ${bootstrap.status}`,
    );
  }
  return bootstrap.body.agentId;
}

describe("AUTH-01, ORG-03, AGENT-02, CHAIN-AGENT", () => {
  it("chains current identity, onboarding, default agent selection, and later agent reads", async () => {
    const admin = api.user();
    const noOrg = api.user({ orgId: null });
    const orgSlug = slug("bdd-chain");
    api.acceptAgentStorageWrites();
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
    expect(org).not.toHaveProperty("slug");

    const missingOrg = await api.requestReadOrg(noOrg, [404]);
    expectApiError(missingOrg.body);
    expect(missingOrg.body.error.code).toBe("NOT_FOUND");

    const noOrgAgent = await api.requestCreateAgent(
      noOrg,
      { displayName: "No Org Agent" },
      [401],
    );
    expectApiError(noOrgAgent.body);
    expect(noOrgAgent.body.error.code).toBe("UNAUTHORIZED");

    const defaultAgentId = await onboardAdmin(admin, {
      displayName: "BDD Default Agent",
      workspaceName: "BDD Chain Org",
      slug: orgSlug,
      name: "BDD Chain Org",
    });

    const after = await api.readOnboardingStatus(admin);
    expect(after.hasDefaultAgent).toBeTruthy();
    expect(after.onboardingComplete).toBeTruthy();
    expect(after.defaultAgentId).toBe(defaultAgentId);
    expect(after.defaultAgentMetadata).toMatchObject({
      displayName: "Okou",
      sound: "calm",
      avatarUrl: DEFAULT_AGENT_AVATAR_URL,
    });

    const defaultAgent = await api.readAgent(admin, defaultAgentId);
    expect(defaultAgent.displayName).toBe("Okou");
    expect(defaultAgent.avatarUrl).toBe(DEFAULT_AGENT_AVATAR_URL);

    const repeatedBootstrap = await api.bootstrapLimitedFreeOnboarding(admin, {
      displayName: "BDD Default Agent Repeated",
    });
    if (repeatedBootstrap.status !== 200) {
      throw new Error(
        `Expected repeated onboarding bootstrap to be idempotent, got ${repeatedBootstrap.status}`,
      );
    }
    expect(repeatedBootstrap.body.agentId).toBe(defaultAgentId);

    const onboardingBilling = await runsApi.readBillingStatus(admin);
    expect(onboardingBilling).toMatchObject({
      tier: "limited-free-1",
      onboardingPaymentPending: false,
    });

    const afterRepeatedBootstrap = await api.listAgents(admin);
    expect(
      afterRepeatedBootstrap.filter((agent) => {
        return agent.agentId === defaultAgentId;
      }),
    ).toHaveLength(1);

    const created = await api.createAgent(admin, {
      displayName: "BDD Secondary Agent",
      description: "Created after onboarding",
      visibility: "public",
    });
    const listed = await api.listAgents(admin);
    expect(
      listed.some((agent) => {
        return agent.agentId === created.agentId;
      }),
    ).toBeTruthy();

    const selectedStatus = await api.readOnboardingStatus(admin);
    expect(selectedStatus.defaultAgentId).toBe(defaultAgentId);

    const updated = await api.updateAgentMetadata(admin, created.agentId, {
      displayName: "BDD Secondary Agent Updated",
      description: "Updated through metadata API",
      visibility: "private",
    });
    expect(updated).toMatchObject({
      agentId: created.agentId,
      displayName: "BDD Secondary Agent Updated",
      description: "Updated through metadata API",
      visibility: "private",
    });

    await api.deleteAgent(admin, created.agentId);
    const deleted = await api.requestReadAgent(admin, created.agentId, [404]);
    expectApiError(deleted.body);
    expect(deleted.body.error.code).toBe("NOT_FOUND");
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
    expect(refreshed).not.toHaveProperty("slug");

    const cached = await api.readOrg(admin);
    expect(cached).toMatchObject({
      id: admin.orgId,
      name: "Slugless Workspace",
      role: "admin",
    });
    expect(cached).not.toHaveProperty("slug");
  });
});

describe("AUTH-03", () => {
  it("manages user preferences through safe visible reads", async () => {
    const admin = api.user();
    await onboardAdmin(admin, { slug: slug("bdd-config") });

    const preferences = await api.updatePreferences(admin, {
      timezone: "UTC",
      pinnedAgentIds: [],
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
    await onboardAdmin(admin);
    await upsertOrgPlanEntitlementFixture({
      orgId: requiredOrgId(admin),
      status: "suspended",
    });

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

    await upsertOrgPlanEntitlementFixture({
      orgId: requiredOrgId(admin),
      status: "manual_active",
    });
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
    await upsertOrgPlanEntitlementFixture({
      orgId: requiredOrgId(admin),
      showUsagePack: false,
    });

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
    });
  });

  it("reads, updates, lists, invites, changes membership, handles requests, and leaves orgs through APIs", async () => {
    const admin = api.user();
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
    await upsertOrgPlanEntitlementFixture({
      orgId: requiredOrgId(admin),
      showUsagePack: false,
    });
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
    expect(updated).not.toHaveProperty("slug");

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
        return candidate.email === member.email && candidate.role === "member";
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
    await expect(api.revokeInvitation(admin, inviteId)).resolves.toStrictEqual({
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

describe("ORG-03 onboarding status mapping", () => {
  it("rejects onboarding status without authentication", async () => {
    const unauthenticated = await bdd.requestReadOnboardingStatus(null, [401]);
    expect(unauthenticated.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it.each(["admin", "member"] as const)(
    "protects the default Okou for its %s owner",
    async (role) => {
      const admin = api.user();
      api.acceptAgentStorageWrites();
      const onboarding = await api.readOnboardingStatus(admin);
      const defaultAgentId = onboarding.defaultAgentId;
      if (!defaultAgentId) {
        throw new Error("Expected the workspace default agent");
      }
      const owner =
        role === "admin"
          ? admin
          : api.user({
              userId: admin.userId,
              orgId: admin.orgId,
              orgRole: "org:member",
            });
      const before = await api.readAgent(owner, defaultAgentId);
      expect(before).toMatchObject({
        isDefaultAgent: true,
        displayName: "Okou",
        visibility: "public",
      });
      await expect(api.listAgents(owner)).resolves.toContainEqual(before);

      for (const update of [
        { displayName: "Renamed default", code: "DEFAULT_AGENT_NAME_LOCKED" },
        { avatarUrl: "preset:4", code: "DEFAULT_AGENT_AVATAR_LOCKED" },
        {
          visibility: "private" as const,
          code: "DEFAULT_AGENT_VISIBILITY_LOCKED",
        },
      ]) {
        const { code, ...fields } = update;
        const body = {
          ...fields,
          isDefaultAgent: false,
          description: "Must not be saved",
          sound: "friendly",
        };
        const patched = await api.requestUpdateAgentMetadata(
          owner,
          defaultAgentId,
          body,
          [400],
        );
        expect(patched.body).toMatchObject({ error: { code } });
        const replaced = await api.requestUpdateAgent(
          owner,
          defaultAgentId,
          body,
          [400],
        );
        expect(replaced.body).toMatchObject({ error: { code } });
        await expect(
          api.readAgent(owner, defaultAgentId),
        ).resolves.toStrictEqual(before);
      }
      const clearedAvatar = await api.requestUpdateAgentMetadata(
        owner,
        defaultAgentId,
        { avatarUrl: null },
        [400],
      );
      expect(clearedAvatar.body).toMatchObject({
        error: { code: "DEFAULT_AGENT_AVATAR_LOCKED" },
      });
      const deletion = await api.requestDeleteAgent(
        owner,
        defaultAgentId,
        [400],
      );
      expect(deletion.body).toMatchObject({
        error: { code: "DEFAULT_AGENT_DELETE_LOCKED" },
      });
      await expect(api.readAgent(owner, defaultAgentId)).resolves.toStrictEqual(
        before,
      );
      expect((await api.readOnboardingStatus(owner)).defaultAgentId).toBe(
        defaultAgentId,
      );

      const permitted = {
        displayName: "Okou",
        avatarUrl: DEFAULT_AGENT_AVATAR_URL,
        visibility: "public" as const,
        description: "Workspace role",
        sound: "friendly",
      };
      await expect(
        api.updateAgent(owner, defaultAgentId, permitted),
      ).resolves.toMatchObject(permitted);
      await expect(
        api.updateAgentMetadata(owner, defaultAgentId, {
          description: "Updated role",
          sound: "direct",
        }),
      ).resolves.toMatchObject({
        description: "Updated role",
        sound: "direct",
        isDefaultAgent: true,
      });
      await expect(
        bdd.updateAgentInstructions(
          owner,
          defaultAgentId,
          "Workspace-specific instructions",
        ),
      ).resolves.toMatchObject({ isDefaultAgent: true });
      const member = api.user({ orgId: admin.orgId, orgRole: "org:member" });
      await expect(
        api.readAgent(member, defaultAgentId),
      ).resolves.toMatchObject({
        isDefaultAgent: true,
        visibility: "public",
      });

      const custom = await api.createAgent(owner, { displayName: "Okou" });
      expect(custom.isDefaultAgent).toBeFalsy();
      await expect(
        api.updateAgent(owner, custom.agentId, {
          displayName: "Research",
          avatarUrl: "preset:2",
          visibility: "private",
        }),
      ).resolves.toMatchObject({
        displayName: "Research",
        avatarUrl: "preset:2",
        visibility: "private",
        isDefaultAgent: false,
      });
      await api.deleteAgent(owner, custom.agentId);
    },
  );

  it("maps onboarding status across the setup, payment, entitlement, and agent-deletion journey", async () => {
    const noOrg = api.user({ orgId: null });
    const admin = api.user();
    const member = api.user({ orgId: admin.orgId, orgRole: "org:member" });

    const noOrgStatus = await api.readOnboardingStatus(noOrg);
    expect(noOrgStatus).toStrictEqual({
      needsOnboarding: false,
      onboardingComplete: false,
      isAdmin: false,
      hasOrg: false,
      hasDefaultAgent: false,
      defaultAgentId: null,
      defaultAgentMetadata: null,
    });

    const memberStatus = await api.readOnboardingStatus(member);
    expect(memberStatus).toStrictEqual({
      needsOnboarding: false,
      onboardingComplete: false,
      isAdmin: false,
      hasOrg: true,
      hasDefaultAgent: false,
      defaultAgentId: null,
      defaultAgentMetadata: null,
    });

    api.acceptAgentStorageWrites();
    const adminBeforeSetup = await api.readOnboardingStatus(admin);
    expect(adminBeforeSetup).toMatchObject({
      needsOnboarding: true,
      onboardingComplete: false,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: true,
      defaultAgentMetadata: {
        displayName: "Okou",
        sound: "professional",
        avatarUrl: DEFAULT_AGENT_AVATAR_URL,
      },
    });
    expect(adminBeforeSetup.defaultAgentId).toBeTruthy();
    if (!adminBeforeSetup.defaultAgentId) {
      throw new Error(
        "Expected lazy onboarding status bootstrap to create an agent",
      );
    }
    const bootstrappedAgentId = adminBeforeSetup.defaultAgentId;

    const bootstrappedBilling = await runsApi.readBillingStatus(admin);
    expect(bootstrappedBilling).toMatchObject({
      credits: 1000,
      tier: "limited-free-1",
      onboardingPaymentPending: false,
    });

    const memberComplete = await api.completeOnboarding(member);
    expect(memberComplete.status).toBe(403);
    expectApiError(memberComplete.body);
    expect(memberComplete.body.error.code).toBe("FORBIDDEN");

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
      hasDefaultAgent: true,
    });

    const agentId = bootstrappedAgentId;

    await runsApi.grantProEntitlement(admin);
    const entitled = await api.readOnboardingStatus(admin);
    expect(entitled).toStrictEqual({
      needsOnboarding: false,
      onboardingComplete: true,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: true,
      defaultAgentId: agentId,
      defaultAgentMetadata: {
        displayName: "Okou",
        sound: "professional",
        avatarUrl: DEFAULT_AGENT_AVATAR_URL,
      },
    });

    await api.requestDeleteAgent(admin, agentId, [400]);
    const orphaned = await api.readOnboardingStatus(admin);
    expect(orphaned).toMatchObject({
      needsOnboarding: false,
      onboardingComplete: true,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: true,
      defaultAgentMetadata: {
        displayName: "Okou",
        sound: "professional",
        avatarUrl: DEFAULT_AGENT_AVATAR_URL,
      },
    });
    expect(orphaned.defaultAgentId).toBeTruthy();
    expect(orphaned.defaultAgentId).toBe(agentId);
    const preservedPaidBilling = await runsApi.readBillingStatus(admin);
    expect(preservedPaidBilling).toMatchObject({
      tier: "pro",
    });
  });
});

describe("AGENT-01 and AGENT-02", () => {
  it("rejects agent metadata updates at unauthenticated, malformed, and missing boundaries", async () => {
    const admin = api.user();
    const missingAgentId = randomUUID();

    const unauthenticated = await api.requestUpdateAgentMetadata(
      null,
      missingAgentId,
      { displayName: "No auth" },
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const malformed = await api.requestUpdateAgentMetadata(
      admin,
      "not-a-valid-agent-id",
      { displayName: "Malformed" },
      [400],
    );
    expectApiError(malformed.body);
    expect(malformed.body.error.code).toBe("BAD_REQUEST");

    const missing = await api.requestUpdateAgentMetadata(
      admin,
      missingAgentId,
      { displayName: "Missing" },
      [404],
    );
    expectApiError(missing.body);
    expect(missing.body.error.code).toBe("NOT_FOUND");
  });

  it("enforces the public agent limit while still allowing private agents", async () => {
    const admin = api.user();
    api.acceptAgentStorageWrites();

    const publicAgents = [];
    for (let index = 0; index < 7; index += 1) {
      publicAgents.push(
        await api.createAgent(admin, {
          displayName: `BDD Public Limit ${index + 1}`,
          visibility: "public",
        }),
      );
    }

    const blocked = await api.requestCreateAgent(
      admin,
      {
        displayName: "BDD Public Limit Blocked",
        visibility: "public",
      },
      [409],
    );
    expectApiError(blocked.body);
    expect(blocked.body.error.code).toBe("CONFLICT");
    expect(blocked.body.error.message).toBe(
      "This organization has reached the maximum number of agents (7). Delete an existing agent before creating a new one.",
    );

    const listed = await api.listAgents(admin);
    const listedPublicAgents = listed.filter((agent) => {
      return agent.visibility === "public";
    });
    expect(listedPublicAgents).toHaveLength(7);
    expect(
      publicAgents.every((agent) => {
        return listedPublicAgents.some((listedAgent) => {
          return listedAgent.agentId === agent.agentId;
        });
      }),
    ).toBeTruthy();

    const privateAfterLimit = await api.createAgent(admin, {
      displayName: "BDD Private After Public Limit",
      visibility: "private",
    });
    expect(privateAfterLimit).toMatchObject({
      displayName: "BDD Private After Public Limit",
      visibility: "private",
    });

    const blockedVisibility = await api.requestUpdateAgentMetadata(
      admin,
      privateAfterLimit.agentId,
      { visibility: "public" },
      [409],
    );
    expectApiError(blockedVisibility.body);
    expect(blockedVisibility.body.error.code).toBe("CONFLICT");
    expect(blockedVisibility.body.error.message).toBe(
      "This organization has reached the maximum number of agents (7). Delete an existing agent before making this agent public.",
    );

    const privateAfterBlockedVisibility = await api.readAgent(
      admin,
      privateAfterLimit.agentId,
    );
    expect(privateAfterBlockedVisibility.visibility).toBe("private");
  });

  it("covers agent isolation, default-agent permissions, and org custom connector enablement", async () => {
    const admin = api.user();
    const member = api.user({
      orgId: admin.orgId,
      orgRole: "org:member",
      email: `member-${shortId()}@example.test`,
    });
    const otherAdmin = api.user();
    await onboardAdmin(admin, { slug: slug("bdd-agent") });
    api.acceptAgentStorageWrites();

    const privateAgent = await api.createAgent(admin, {
      displayName: "BDD Private Agent",
      visibility: "private",
    });
    const memberPrivateRead = await api.requestReadAgent(
      member,
      privateAgent.agentId,
      [404],
    );
    expectApiError(memberPrivateRead.body);
    expect(memberPrivateRead.body.error.code).toBe("NOT_FOUND");

    const publicAgent = await api.createAgent(admin, {
      displayName: "BDD Public Agent",
      visibility: "public",
    });
    const memberPublicRead = await api.readAgent(member, publicAgent.agentId);
    expect(memberPublicRead.agentId).toBe(publicAgent.agentId);

    const crossOrgRead = await api.requestReadAgent(
      otherAdmin,
      publicAgent.agentId,
      [404],
    );
    expectApiError(crossOrgRead.body);
    expect(crossOrgRead.body.error.code).toBe("NOT_FOUND");

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
    const connectorList = await api.listCustomConnectors(admin);
    const listedConnector = connectorList.connectors.find((candidate) => {
      return candidate.id === connector.id;
    });
    expect(listedConnector).toBeDefined();
    expect(listedConnector?.connected).toBeTruthy();
    expect(JSON.stringify(connectorList)).not.toContain(
      "custom-connector-secret",
    );

    const enabled = await api.updateAgentCustomConnectors(
      admin,
      publicAgent.agentId,
      [connector.id],
    );
    expect(enabled.grants).toStrictEqual([
      { customConnectorId: connector.id, permissionNames: [] },
    ]);
    const readEnabled = await api.readAgentCustomConnectors(
      admin,
      publicAgent.agentId,
    );
    expect(readEnabled.grants).toStrictEqual([
      { customConnectorId: connector.id, permissionNames: [] },
    ]);

    const otherAgent = await api.createAgent(otherAdmin, {
      displayName: "Other Org Agent",
      visibility: "private",
    });
    const crossOrgConnector = await api.requestUpdateAgentCustomConnectors(
      otherAdmin,
      otherAgent.agentId,
      [connector.id],
      [400],
    );
    expectApiError(crossOrgConnector.body);
    expect(crossOrgConnector.body.error.code).toBe("VALIDATION_ERROR");

    const cleared = await api.updateAgentCustomConnectors(
      admin,
      publicAgent.agentId,
      [],
    );
    expect(cleared.grants).toStrictEqual([]);

    await api.deleteDefaultCustomConnectorAccount(admin, connector.id);
    const afterDisconnect = await api.listCustomConnectors(admin);
    expect(
      afterDisconnect.connectors.find((candidate) => {
        return candidate.id === connector.id;
      })?.connected,
    ).toBeFalsy();
    await api.deleteCustomConnector(admin, connector.id);
    const afterDelete = await api.listCustomConnectors(admin);
    expect(
      afterDelete.connectors.some((candidate) => {
        return candidate.id === connector.id;
      }),
    ).toBeFalsy();
  });
});
