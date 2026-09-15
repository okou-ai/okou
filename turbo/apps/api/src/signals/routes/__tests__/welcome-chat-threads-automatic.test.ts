import { describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { testContext } from "../../../__tests__/test-context";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const webhooks = createWebhookCallbackApi(context);

async function createdThreadIds(
  actor: ApiTestUser,
): Promise<readonly string[]> {
  const response = await chat.requestThreadEvents(actor, {}, [200]);
  if (response.status !== 200) {
    throw new Error("Expected chat thread lifecycle events");
  }
  return response.body.events.flatMap((event) => {
    return event.kind === "created" ? [event.chatThreadId] : [];
  });
}

async function onlyCreatedThreadId(actor: ApiTestUser): Promise<string> {
  const threadIds = await createdThreadIds(actor);
  expect(threadIds).toHaveLength(1);
  const [threadId] = threadIds;
  if (!threadId) {
    throw new Error("Expected one created thread");
  }
  return threadId;
}

async function enable(actor: ApiTestUser, value = true): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Expected a workspace");
  }
  await updateFeatureSwitchesForUser(
    context,
    { ...actor, orgId: actor.orgId },
    { [FeatureSwitchKey.WelcomeThread]: value },
  );
}

function membershipEvent(actor: ApiTestUser): void {
  if (!actor.orgId) {
    throw new Error("Expected a workspace");
  }
  webhooks.configureClerkWebhookSecret();
  webhooks.verifyNextClerkWebhook({
    type: "organizationMembership.created",
    data: {
      id: `membership-${actor.userId}-${actor.orgId}`,
      organization: { id: actor.orgId },
      public_user_data: { user_id: actor.userId },
      role: actor.orgRole ?? "org:member",
      created_at: now(),
    },
  });
}

async function deliverMembershipCreated(actor: ApiTestUser): Promise<void> {
  membershipEvent(actor);
  await webhooks.requestClerkWebhook("{}", {}, [200]);
  await flushWaitUntilForTest();
}

async function deliverOrganizationCreated(actor: ApiTestUser): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Expected a workspace");
  }
  webhooks.configureClerkWebhookSecret();
  webhooks.verifyNextClerkWebhook({
    type: "organization.created",
    data: {
      id: actor.orgId,
      created_by: actor.userId,
      created_at: now(),
    },
  });
  await webhooks.requestClerkWebhook("{}", {}, [200]);
  await flushWaitUntilForTest();
}

/** An established workspace whose default agent an invited member can use. */
async function establishedWorkspace(): Promise<ApiTestUser> {
  const admin = bdd.user();
  bdd.acceptAgentStorageWrites();
  await bdd.bootstrapLimitedFreeOnboarding(admin, {
    displayName: "Established workspace agent",
  });
  return admin;
}

async function welcomeEvents(actor: ApiTestUser, threadId: string) {
  return await chat.listThreadEventRows(actor, threadId);
}

describe("automatic welcome thread delivery", () => {
  it("delivers one welcome thread to an invited member", async () => {
    const admin = await establishedWorkspace();
    const member = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
    await enable(member);

    await deliverMembershipCreated(member);

    const threadId = await onlyCreatedThreadId(member);
    const metadata = await chat.readThreadMetadata(member, threadId);
    expect(metadata.id).toBe(threadId);
    const rows = await welcomeEvents(member, threadId);
    expect(rows).toMatchObject([
      { seqId: 1, eventType: "output.message", runId: null },
    ]);
  });

  it("delivers a separate welcome to each member of a workspace", async () => {
    const admin = await establishedWorkspace();
    const firstMember = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
    const secondMember = bdd.user({
      orgId: admin.orgId,
      orgRole: "org:member",
    });
    await enable(firstMember);
    await enable(secondMember);

    await deliverMembershipCreated(firstMember);
    await deliverMembershipCreated(secondMember);

    const firstThreadId = await onlyCreatedThreadId(firstMember);
    const secondThreadId = await onlyCreatedThreadId(secondMember);
    expect(secondThreadId).not.toBe(firstThreadId);
    await expect(
      welcomeEvents(firstMember, firstThreadId),
    ).resolves.toHaveLength(1);
    await expect(
      welcomeEvents(secondMember, secondThreadId),
    ).resolves.toHaveLength(1);
  });

  it("delivers a separate welcome to the same member in each workspace", async () => {
    const firstAdmin = await establishedWorkspace();
    const secondAdmin = await establishedWorkspace();
    const firstMembership = bdd.user({
      orgId: firstAdmin.orgId,
      orgRole: "org:member",
    });
    const secondMembership = bdd.user({
      userId: firstMembership.userId,
      orgId: secondAdmin.orgId,
      orgRole: "org:member",
    });
    await enable(firstMembership);
    await enable(secondMembership);

    await deliverMembershipCreated(firstMembership);
    await deliverMembershipCreated(secondMembership);

    const firstThreadId = await onlyCreatedThreadId(firstMembership);
    const secondThreadId = await onlyCreatedThreadId(secondMembership);
    expect(secondThreadId).not.toBe(firstThreadId);
    await expect(
      welcomeEvents(firstMembership, firstThreadId),
    ).resolves.toHaveLength(1);
    await expect(
      welcomeEvents(secondMembership, secondThreadId),
    ).resolves.toHaveLength(1);
  });

  it.each([
    {
      registration: "organization.created",
      deliver: deliverOrganizationCreated,
    },
    {
      registration: "organizationMembership.created",
      deliver: deliverMembershipCreated,
    },
  ])(
    "delivers a workspace creator's welcome from $registration, once bootstrap publishes the default agent",
    async ({ deliver }) => {
      const creator = bdd.user();
      bdd.acceptAgentStorageWrites();
      await enable(creator);
      // `organization.created` carries no membership side effects at all, so
      // the only trigger that can reach this creator is the moment bootstrap
      // publishes the workspace default agent.
      await deliver(creator);

      // Bootstrap is unaffected by the welcome work chained behind it.
      await expect(bdd.readOnboardingStatus(creator)).resolves.toMatchObject({
        hasDefaultAgent: true,
      });
      const threadId = await onlyCreatedThreadId(creator);
      await expect(
        chat.readThreadMetadata(creator, threadId),
      ).resolves.toMatchObject({ id: threadId });
      await expect(welcomeEvents(creator, threadId)).resolves.toHaveLength(1);
    },
  );

  it("keeps one thread across a redelivered event and two concurrent deliveries", async () => {
    const admin = await establishedWorkspace();
    const member = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
    await enable(member);

    // Two deliveries in flight at once.
    membershipEvent(member);
    membershipEvent(member);
    await Promise.all([
      webhooks.requestClerkWebhook("{}", {}, [200]),
      webhooks.requestClerkWebhook("{}", {}, [200]),
    ]);
    await flushWaitUntilForTest();
    const threadId = await onlyCreatedThreadId(member);
    await expect(welcomeEvents(member, threadId)).resolves.toHaveLength(1);

    // Clerk redelivery after the first attempt committed.
    await deliverMembershipCreated(member);
    await expect(createdThreadIds(member)).resolves.toStrictEqual([threadId]);
    await expect(welcomeEvents(member, threadId)).resolves.toHaveLength(1);
    await expect(
      chat.readThreadMetadata(member, threadId),
    ).resolves.toMatchObject({ id: threadId });
  });

  it("creates nothing when the switch is disabled for the workspace", async () => {
    const admin = await establishedWorkspace();
    const member = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });

    await deliverMembershipCreated(member);

    await expect(createdThreadIds(member)).resolves.toStrictEqual([]);
  });

  it("abandons the invocation when the workspace default agent is not ready", async () => {
    const member = bdd.user({ orgRole: "org:member" });
    await enable(member);

    // A member never triggers workspace bootstrap, so no default agent can
    // appear for this workspace and nothing is scheduled to look again.
    await deliverMembershipCreated(member);

    await expect(createdThreadIds(member)).resolves.toStrictEqual([]);
    await deliverMembershipCreated(member);
    await expect(createdThreadIds(member)).resolves.toStrictEqual([]);
  });

  it("never delivers again after the recipient deletes the thread", async () => {
    const admin = await establishedWorkspace();
    const member = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
    await enable(member);
    await deliverMembershipCreated(member);
    const threadId = await onlyCreatedThreadId(member);
    await chat.requestDeleteThread(member, threadId, [204]);

    // Ordinary app entry. The trigger is the registration event alone: nothing
    // on this path re-checks whether the recipient still has a welcome.
    await bdd.readOnboardingStatus(member);
    await chat.getThreadSnapshot(member);
    await expect(createdThreadIds(member)).resolves.toStrictEqual([threadId]);

    await expect(
      chat.requestReadThread(member, threadId, [404]),
    ).resolves.toMatchObject({ status: 404 });
  });
});
