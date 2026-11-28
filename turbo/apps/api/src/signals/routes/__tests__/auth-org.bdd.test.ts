import { randomUUID } from "node:crypto";

import { testContext } from "../../../__tests__/test-context";
import { createAuthOrgBddApi } from "./helpers/api-bdd-auth-org";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { publicPlanLifecycle } from "./helpers/public-plan-lifecycle";

const context = testContext();
const api = createAuthOrgBddApi(context);
const runs = createRunsApi(context);

describe("AUTH-01 and ORG-03", () => {
  it("auth-org.bdd-001 reads the signed-in identity and completes workspace onboarding", async () => {
    const admin = api.user();
    const homeless = api.user({ orgId: null });
    api.acceptStorageWrites();
    api.mockClerkOrg(admin, { name: "BDD Chain Org" });

    await expect(api.readMe(admin)).resolves.toStrictEqual({
      userId: admin.userId,
      email: admin.email,
      orgId: admin.orgId,
    });
    await expect(api.readOrg(admin)).resolves.toMatchObject({
      id: admin.orgId,
      name: "BDD Chain Org",
      role: "admin",
    });
    const missing = await api.requestReadOrg(homeless, [404]);
    expect(JSON.stringify(missing.body)).toContain("NOT_FOUND");

    await api.bootstrapLimitedFreeOnboarding(admin);
    await expect(api.readOnboardingStatus(admin)).resolves.toMatchObject({
      onboardingComplete: true,
    });
    const repeated = await api.bootstrapLimitedFreeOnboarding(admin);
    expect(repeated.status).toBe(200);
    await expect(runs.readBillingStatus(admin)).resolves.toMatchObject({
      tier: "limited-free-1",
      onboardingPaymentPending: false,
    });
  });

  it("auth-org.bdd-007 maps onboarding status across setup, completion and a Pro plan", async () => {
    const homeless = api.user({ orgId: null });
    const admin = api.user();
    const member = api.user({ orgId: admin.orgId, orgRole: "org:member" });
    api.acceptStorageWrites();
    api.mockClerkOrg(admin, {
      members: [{ actor: admin }, { actor: member }],
    });

    await expect(api.readOnboardingStatus(homeless)).resolves.toStrictEqual({
      needsOnboarding: false,
      onboardingComplete: false,
      isAdmin: false,
      hasOrg: false,
    });
    await expect(api.readOnboardingStatus(member)).resolves.toMatchObject({
      needsOnboarding: true,
      hasOrg: true,
      isAdmin: false,
    });
    await expect(api.readOnboardingStatus(admin)).resolves.toMatchObject({
      needsOnboarding: true,
      isAdmin: true,
    });

    await api.provisionWorkspace(admin);
    await expect(runs.readBillingStatus(admin)).resolves.toMatchObject({
      credits: 0,
      creditGrants: [],
      tier: "limited-free-1",
      onboardingPaymentPending: false,
    });
    await expect(runs.readUsagePackCredits(admin)).resolves.toMatchObject({
      totalCredits: 1000,
      bonusCredits: 1000,
    });

    await api.completeOnboarding(member);
    await expect(api.readOnboardingStatus(admin)).resolves.toMatchObject({
      needsOnboarding: true,
    });
    const completed = await api.completeOnboarding(admin);
    expect(completed.body).toStrictEqual({
      onboardingComplete: true,
      needsOnboarding: false,
    });
    await expect(api.readOnboardingStatus(admin)).resolves.toMatchObject({
      onboardingComplete: true,
      needsOnboarding: false,
    });

    await publicPlanLifecycle(context, admin, "pro").update("active");
    await expect(api.readOnboardingStatus(admin)).resolves.toMatchObject({
      onboardingComplete: true,
      needsOnboarding: false,
    });
    await expect(runs.readBillingStatus(admin)).resolves.toMatchObject({
      tier: "pro",
    });
  });
});

describe("ORG-01 and ORG-02", () => {
  it("auth-org.bdd-004 blocks invitations until a canceled plan is reactivated", async () => {
    const admin = api.user();
    const inviteeEmail = `invitee_${randomUUID()}@example.test`;
    api.acceptStorageWrites();
    api.mockClerkOrg(admin);
    await api.bootstrapLimitedFreeOnboarding(admin);
    const plan = publicPlanLifecycle(context, admin, "pro");
    await plan.update("canceled");
    const invitations =
      context.mocks.clerk.organizations.createOrganizationInvitation;
    invitations.mockClear();

    const blocked = await api.requestInviteMember(
      admin,
      { email: inviteeEmail, role: "member" },
      [403],
    );
    expect(blocked.body).toMatchObject({
      error: { message: "Reactivate your workspace plan to invite members" },
    });
    expect(invitations).not.toHaveBeenCalled();

    await plan.update("active");
    await expect(runs.readBillingStatus(admin)).resolves.toMatchObject({
      status: "active",
    });
    await api.inviteMember(admin, { email: inviteeEmail, role: "member" });
    expect(invitations).toHaveBeenCalledWith(
      expect.objectContaining({ emailAddress: inviteeEmail }),
    );
  });

  it("auth-org.bdd-006 (1/4) shows each role its org and lets only the admin rename it", async () => {
    const { admin, member, workspace } = await onboardedBddOrg();

    await expect(api.readOrg(admin)).resolves.toMatchObject({
      name: "BDD Org",
      role: "admin",
    });
    await expect(api.readOrg(member)).resolves.toMatchObject({
      role: "member",
    });
    await expect(renameBddOrg(admin, workspace)).resolves.toMatchObject({
      name: "BDD Org Updated",
    });
    const memberRename = await api.requestUpdateOrg(
      member,
      { name: "Member rename" },
      [403],
    );
    expect(memberRename.body).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("auth-org.bdd-006 (2/4) lists the renamed org's people and lets only the admin invite", async () => {
    const { admin, member, requester, invitation, request, workspace } =
      await onboardedBddOrg();
    await renameBddOrg(admin, workspace);

    const listed = await api.listMembers(admin);
    expect(listed).toMatchObject({
      name: "BDD Org Updated",
      role: "admin",
      pendingInvitations: [{ id: invitation.id, email: invitation.email }],
      membershipRequests: [{ id: request.id, userId: requester.userId }],
    });
    expect(
      listed.members.map(({ email }) => {
        return email;
      }),
    ).toContain(member.email);

    const inviteeEmail = `invitee_${randomUUID()}@example.test`;
    const invited = await api.inviteMember(admin, {
      email: inviteeEmail,
      role: "member",
    });
    expect(invited.message).toContain("Invitation sent");
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        emailAddress: inviteeEmail,
        role: "org:member",
        redirectUrl: "http://localhost:3002",
      }),
    );
    const memberInvite = await api.requestInviteMember(
      member,
      { email: `other_${randomUUID()}@example.test`, role: "member" },
      [403],
    );
    expect(memberInvite.body).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("auth-org.bdd-006 (3/4) revokes, promotes, settles requests and removes the member", async () => {
    const { admin, member, invitation, request, workspace } =
      await onboardedBddOrg();
    await renameBddOrg(admin, workspace);

    const messages = [
      (await api.revokeInvitation(admin, invitation.id)).message,
      (
        await api.updateMemberRole(admin, {
          email: member.email,
          role: "admin",
        })
      ).message,
      (await api.acceptMembershipRequest(admin, { requestId: request.id }))
        .message,
      (await api.rejectMembershipRequest(admin, { requestId: request.id }))
        .message,
      (await api.removeMember(admin, { email: member.email })).message,
    ];
    expect(messages).toStrictEqual([
      "Invitation revoked",
      `Updated role for ${member.email}`,
      "Membership request accepted",
      "Membership request rejected",
      `Removed ${member.email} from org`,
    ]);
    api.mockClerkOrg(admin, {
      ...workspace,
      name: "BDD Org Updated",
      members: [{ actor: admin }],
    });
    const after = await api.listMembers(admin);
    expect(
      after.members.map(({ email }) => {
        return email;
      }),
    ).not.toContain(member.email);
  });

  it("auth-org.bdd-006 (4/4) lets the member leave and the admin delete the org", async () => {
    const { admin, member } = await onboardedBddOrg();

    await expect(api.leaveOrg(member)).resolves.toMatchObject({
      message: "Left org",
    });
    await expect(api.deleteOrg(admin)).resolves.toMatchObject({
      message: "Organization deleted",
    });
  });
});

/**
 * An administrator's onboarded "BDD Org" with a member, a pending invitation
 * and another user's pending membership request.
 */
async function onboardedBddOrg() {
  const admin = api.user();
  const member = api.user({ orgId: admin.orgId, orgRole: "org:member" });
  const requester = api.user({ orgId: null });
  const invitation = {
    id: `orginv_${randomUUID()}`,
    email: `pending_${randomUUID()}@example.test`,
  };
  const request = { id: `orgmemreq_${randomUUID()}`, actor: requester };
  const workspace = {
    name: "BDD Org",
    members: [{ actor: admin }, { actor: member }],
    pendingInvitations: [invitation],
    membershipRequests: [request],
  };
  api.acceptStorageWrites();
  api.mockClerkOrg(admin, workspace);
  await api.bootstrapLimitedFreeOnboarding(admin);
  return { admin, member, requester, invitation, request, workspace };
}

function renameBddOrg(
  admin: ReturnType<typeof api.user>,
  workspace: Parameters<typeof api.mockClerkOrg>[1],
) {
  api.mockClerkOrg(admin, { ...workspace, name: "BDD Org Updated" });
  return api.updateOrg(admin, { name: "BDD Org Updated" });
}
