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
});

describe("ORG-03 onboarding status mapping", () => {});
