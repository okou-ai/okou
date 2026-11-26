import { randomUUID } from "node:crypto";

import { onboardingStatusContract } from "@okouai/api-contracts/contracts/onboarding";
import {
  chatThreadByIdContract,
  chatThreadEventsContract,
  chatThreadMetadataContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatThreadRoutes } from "../chat-threads";
import { onboardingStatusRoutes } from "../onboarding-status";
import { userPreferencesRoutes } from "../user-preferences";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

interface Member {
  readonly userId: string;
  readonly orgId: string;
}

function newMember(orgId = `org_${randomUUID()}`): Member {
  return { userId: `user_${randomUUID()}`, orgId };
}

function signIn(
  member: Member,
  role: "org:admin" | "org:member" = "org:member",
) {
  createRouteMocks(context).clerk.session(member.userId, member.orgId, role);
  return setupApp({
    context,
    routes: [
      ...chatThreadRoutes,
      ...onboardingStatusRoutes,
      ...userPreferencesRoutes,
    ],
  });
}

function membershipCreated(member: Member) {
  return {
    type: "organizationMembership.created",
    data: {
      id: `orgmem_${randomUUID()}`,
      role: "org:member",
      created_at: now(),
      organization: { id: member.orgId },
      public_user_data: { user_id: member.userId },
    },
  } as const;
}

/** Clerk delivers one signed webhook per event; verification is the SDK boundary. */
async function deliver(
  events: readonly (
    | ReturnType<typeof membershipCreated>
    | {
        readonly type: "organization.created";
        readonly data: Record<string, unknown>;
      }
  )[],
) {
  const webhooks = createWebhookCallbackApi(context);
  webhooks.configureClerkWebhookSecret();
  for (const event of events) {
    webhooks.verifyNextClerkWebhook(event);
  }
  const responses = await Promise.all(
    events.map(() => {
      return webhooks.requestClerkWebhook("{}", {}, [200]);
    }),
  );
  await flushWaitUntilForTest();
  return responses;
}

async function createdThreadIds(member: Member): Promise<string[]> {
  const feed = await accept(
    signIn(member)(chatThreadsContract).events({ headers, query: {} }),
    [200],
  );
  return feed.body.events
    .filter((event) => {
      return event.kind === "created";
    })
    .map((event) => {
      return event.chatThreadId;
    });
}

async function eventRows(member: Member, threadId: string) {
  const rows = await accept(
    signIn(member)(chatThreadEventsContract).rows({
      headers,
      params: { threadId },
      query: { sinceSeqId: 0 },
    }),
    [200],
  );
  return rows.body.rows;
}

async function metadataId(member: Member, threadId: string) {
  const read = await accept(
    signIn(member)(chatThreadMetadataContract).get({
      headers,
      params: { id: threadId },
    }),
    [200],
  );
  return read.body.id;
}

async function onlyThread(member: Member): Promise<string> {
  const ids = await createdThreadIds(member);
  expect(ids).toHaveLength(1);
  const [threadId] = ids;
  if (threadId === undefined) {
    throw new Error("Expected one created thread");
  }
  return threadId;
}

describe("automatic welcome thread delivery", () => {
  it("welcome-chat-threads-automatic-001 delivers one welcome thread to an invited member", async () => {
    const admin = newMember();
    const member = newMember(admin.orgId);

    await deliver([membershipCreated(member)]);

    const threadId = await onlyThread(member);
    await expect(metadataId(member, threadId)).resolves.toBe(threadId);
    const rows = await eventRows(member, threadId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: "output.message",
      seqId: 1,
      runId: null,
    });
  });

  it("welcome-chat-threads-automatic-003 delivers a separate welcome in each workspace", async () => {
    const first = newMember();
    const second = { userId: first.userId, orgId: `org_${randomUUID()}` };

    await deliver([membershipCreated(first)]);
    await deliver([membershipCreated(second)]);

    const firstThread = await onlyThread(first);
    const secondThread = await onlyThread(second);
    expect(firstThread).not.toBe(secondThread);
    for (const [member, threadId] of [
      [first, firstThread],
      [second, secondThread],
    ] as const) {
      const rows = await eventRows(member, threadId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload?.content).toContain(
        "**Your preferences belong in personal Instructions.**",
      );
    }
  });

  it("welcome-chat-threads-automatic-004 delivers the workspace creator's welcome from organization.created", async () => {
    const creator = newMember();

    await deliver([
      {
        type: "organization.created",
        data: {
          id: creator.orgId,
          created_by: creator.userId,
          created_at: now(),
        },
      },
    ]);

    const threadId = await onlyThread(creator);
    await expect(metadataId(creator, threadId)).resolves.toBe(threadId);
    await expect(eventRows(creator, threadId)).resolves.toHaveLength(1);
  });

  it("welcome-chat-threads-automatic-006 keeps one thread across concurrent deliveries and a redelivery", async () => {
    const admin = newMember();
    const member = newMember(admin.orgId);
    const event = membershipCreated(member);

    const concurrent = await deliver([event, event]);
    expect(
      concurrent.map((response) => {
        return response.status;
      }),
    ).toStrictEqual([200, 200]);
    const threadId = await onlyThread(member);
    const rows = await eventRows(member, threadId);
    expect(rows).toHaveLength(1);

    await accept(
      signIn(member)(userPreferencesContract).update({
        headers,
        body: { locale: "zh-Hans" },
      }),
      [200],
    );
    await deliver([event]);

    await expect(eventRows(member, threadId)).resolves.toStrictEqual(rows);
    await expect(onlyThread(member)).resolves.toBe(threadId);
    await expect(metadataId(member, threadId)).resolves.toBe(threadId);
  });

  it("welcome-chat-threads-automatic-007 never brings back a welcome thread the member deleted", async () => {
    const admin = newMember();
    const member = newMember(admin.orgId);
    await deliver([membershipCreated(member)]);
    const threadId = await onlyThread(member);
    await accept(
      signIn(member)(chatThreadByIdContract).delete({
        headers,
        params: { id: threadId },
        body: undefined,
      }),
      [204],
    );

    await accept(
      signIn(member)(onboardingStatusContract).getStatus({ headers }),
      [200],
    );
    await accept(
      signIn(member)(chatThreadsContract).snapshot({ headers }),
      [200],
    );
    await flushWaitUntilForTest();

    await expect(createdThreadIds(member)).resolves.toStrictEqual([threadId]);
    await accept(
      signIn(member)(chatThreadByIdContract).get({
        headers,
        params: { id: threadId },
      }),
      [404],
    );
  });
});
