import { randomUUID } from "node:crypto";

import { morningBriefPreferenceContract } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { orgMembersContract } from "@okouai/api-contracts/contracts/org-member-routes";
import { orgLeaveContract } from "@okouai/api-contracts/contracts/org-routes";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { morningBriefPreferenceRoutes } from "../morning-brief-preference";
import { orgMembersRoutes } from "../org-members";
import { orgReadRoutes } from "../org-read";
import { userPreferencesRoutes } from "../user-preferences";
import {
  createAuthOrgAgentsBddApi,
  type ApiTestUser,
} from "./helpers/api-bdd-auth-org";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const api = createAuthOrgAgentsBddApi(context);
const integrations = createBddIntegrationApi(context);
const webhooks = createWebhookCallbackApi(context);

function organizationId(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Membership deletion fixture requires an organization");
  }
  return actor.orgId;
}

function membership(actor: ApiTestUser, id = `orgmem_${randomUUID()}`) {
  return {
    id,
    role: actor.orgRole ?? "org:member",
    organization: { id: organizationId(actor) },
    publicUserData: { userId: actor.userId },
    createdAt: now(),
  };
}

function members() {
  const admin = api.user();
  const member = api.user({ orgId: admin.orgId, orgRole: "org:member" });
  api.mockClerkOrg(admin, { members: [{ actor: admin }, { actor: member }] });
  return { admin, member };
}

function preferences(actor: ApiTestUser) {
  return setupApp({ context, routes: userPreferencesRoutes })(
    userPreferencesContract,
  ).get({ headers: api.authenticate(actor) });
}

async function connectedMember() {
  const owners = members();
  api.acceptAgentStorageWrites();
  integrations.configureSlackAppMocks();
  await api.bootstrapLimitedFreeOnboarding(owners.admin, {
    displayName: "Membership identity fixture",
  });
  const installed = await integrations.installSlackWorkspace(owners.admin);
  await integrations.connectSlackUser(owners.member, {
    workspaceId: installed.teamId,
    slackUserId: `U_IDENTITY_${randomUUID().replaceAll("-", "")}`,
  });
  await accept(
    setupApp({ context, routes: userPreferencesRoutes })(
      userPreferencesContract,
    ).update({
      headers: api.authenticate(owners.member),
      body: { locale: "ja-JP", sendMode: "cmd-enter", theme: "dark" },
    }),
    [200],
  );
  // Onboarding helpers configure their own directory. Restore both external
  // identities so admin removal can find the intended member by email.
  api.mockClerkOrg(owners.admin, {
    members: [{ actor: owners.admin }, { actor: owners.member }],
  });
  const before = await accept(preferences(owners.member), [200]);
  const slackBefore = await integrations.requestSlackConnectStatus(
    owners.member,
    [200],
  );
  expect(slackBefore.body).toMatchObject({ isConnected: true });
  return { ...owners, before: before.body, slackBefore: slackBefore.body };
}

async function deliverDeletion(
  member: ApiTestUser,
  identity: Readonly<Record<string, unknown>>,
) {
  webhooks.configureClerkWebhookSecret();
  webhooks.verifyNextClerkWebhook({
    type: "organizationMembership.deleted",
    data: {
      organization_id: organizationId(member),
      user_id: member.userId,
      ...identity,
    },
  });
  await webhooks.requestClerkWebhook("{}", {}, [200]);
  await flushWaitUntilForTest();
}

async function readMemberResources(member: ApiTestUser) {
  const current = await accept(preferences(member), [200]);
  const slack = await integrations.requestSlackConnectStatus(member, [200]);
  return { preferences: current.body, slack: slack.body };
}

type Removal = "leave" | "admin removal";

function remove(
  method: Removal,
  owners: { readonly admin: ApiTestUser; readonly member: ApiTestUser },
) {
  return method === "leave"
    ? setupApp({ context, routes: orgReadRoutes })(orgLeaveContract).leave({
        headers: api.authenticate(owners.member),
        body: {},
      })
    : setupApp({ context, routes: orgMembersRoutes })(
        orgMembersContract,
      ).removeMember({
        headers: api.authenticate(owners.admin),
        body: { email: owners.member.email },
      });
}

describe("membership deletion identity", () => {
  it.each([
    { label: "missing", identity: {} },
    { label: "non-string", identity: { id: 123 } },
    { label: "empty", identity: { id: "" } },
    { label: "whitespace-only", identity: { id: " \t\n" } },
    { label: "leading-whitespace", identity: { id: " orgmem_padded" } },
    { label: "trailing-whitespace", identity: { id: "orgmem_padded " } },
  ])(
    "preserves preferences and Slack for a signed $label membership ID",
    async ({ identity }) => {
      const fixture = await connectedMember();
      await deliverDeletion(fixture.member, identity);
      await expect(readMemberResources(fixture.member)).resolves.toStrictEqual({
        preferences: fixture.before,
        slack: fixture.slackBefore,
      });
    },
  );

  it("still removes preferences and Slack for a valid ordinary deletion", async () => {
    const fixture = await connectedMember();
    await deliverDeletion(fixture.member, {
      id: membership(fixture.member).id,
    });
    await expect(readMemberResources(fixture.member)).resolves.toMatchObject({
      preferences: { locale: null, sendMode: "enter", theme: null },
      slack: { isConnected: false },
    });
  });

  describe.each(["leave", "admin removal"] as const)("%s", (method) => {
    it.each([
      "missing ID",
      "non-string ID",
      "empty ID",
      "whitespace-only ID",
      "padded ID",
      "wrong organization",
      "wrong user",
    ] as const)(
      "preserves local resources when Clerk returns %s",
      async (invalid) => {
        const fixture = await connectedMember();
        const deleted = membership(fixture.member);
        const response = {
          ...deleted,
          ...(invalid === "missing ID" ? { id: undefined } : {}),
          ...(invalid === "non-string ID" ? { id: 123 } : {}),
          ...(invalid === "empty ID" ? { id: "" } : {}),
          ...(invalid === "whitespace-only ID" ? { id: " \t" } : {}),
          ...(invalid === "padded ID" ? { id: ` ${deleted.id}` } : {}),
          ...(invalid === "wrong organization"
            ? { organization: { id: `org_other_${randomUUID()}` } }
            : {}),
          ...(invalid === "wrong user"
            ? { publicUserData: { userId: `user_other_${randomUUID()}` } }
            : {}),
        };
        context.mocks.clerk.organizations.deleteOrganizationMembership.mockResolvedValueOnce(
          response,
        );
        await accept(remove(method, fixture), [500]);
        await flushWaitUntilForTest();
        await expect(
          readMemberResources(fixture.member),
        ).resolves.toStrictEqual({
          preferences: fixture.before,
          slack: fixture.slackBefore,
        });
      },
    );

    it("still removes local resources after a valid Clerk deletion", async () => {
      const fixture = await connectedMember();
      context.mocks.clerk.organizations.deleteOrganizationMembership.mockResolvedValueOnce(
        membership(fixture.member),
      );
      await accept(remove(method, fixture), [200]);
      await expect(readMemberResources(fixture.member)).resolves.toMatchObject({
        preferences: { locale: null, sendMode: "enter", theme: null },
        slack: { isConnected: false },
      });
    });

    it("preserves local resources when Clerk rejects deletion and permits a valid retry", async () => {
      const fixture = await connectedMember();
      context.mocks.clerk.organizations.deleteOrganizationMembership.mockRejectedValueOnce(
        new Error("Synthetic Clerk deletion failure"),
      );
      await accept(remove(method, fixture), [500]);
      await expect(readMemberResources(fixture.member)).resolves.toStrictEqual({
        preferences: fixture.before,
        slack: fixture.slackBefore,
      });

      context.mocks.clerk.organizations.deleteOrganizationMembership.mockResolvedValueOnce(
        membership(fixture.member),
      );
      await accept(remove(method, fixture), [200]);
      await expect(readMemberResources(fixture.member)).resolves.toMatchObject({
        preferences: { locale: null, sendMode: "enter", theme: null },
        slack: { isConnected: false },
      });
    });

    it.each([false, true])(
      "uses the returned generation for pending enrollment (matches: %s)",
      async (matches) => {
        const owners = members();
        const pendingId = `orgmem_pending_${randomUUID()}`;
        const earlierId = `orgmem_earlier_${randomUUID()}`;
        // Use an eligible created event, then keep its enrollment pending by
        // withholding the timezone prerequisite. Its intent is publicly visible
        // as `preparing`, independently of the later parent metadata cleanup.
        webhooks.configureClerkWebhookSecret();
        webhooks.verifyNextClerkWebhook({
          type: "organizationMembership.created",
          data: {
            id: pendingId,
            organization: { id: organizationId(owners.member) },
            public_user_data: { user_id: owners.member.userId },
            role: "org:member",
            created_at: now() + 60_000,
          },
        });
        await webhooks.requestClerkWebhook("{}", {}, [200]);
        await flushWaitUntilForTest();
        await updateFeatureSwitchesForUser(
          context,
          {
            orgId: organizationId(owners.member),
            userId: owners.member.userId,
          },
          { [FeatureSwitchKey.MorningBrief]: true },
        );
        const readBrief = () => {
          return setupApp({ context, routes: morningBriefPreferenceRoutes })(
            morningBriefPreferenceContract,
          ).get({ headers: api.authenticate(owners.member) });
        };
        const before = await accept(readBrief(), [200]);
        expect(before.body).toMatchObject({
          status: "preparing",
          enabled: true,
        });

        context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
          {
            data: [
              membership(owners.admin),
              membership(owners.member, matches ? earlierId : pendingId),
            ],
          },
        );
        context.mocks.clerk.organizations.deleteOrganizationMembership.mockResolvedValueOnce(
          membership(owners.member, matches ? pendingId : earlierId),
        );
        await accept(remove(method, owners), [200]);
        const after = await accept(readBrief(), [200]);
        expect(after.body).toMatchObject({
          status: matches ? "paused" : "preparing",
          enabled: !matches,
        });
      },
    );
  });
});
