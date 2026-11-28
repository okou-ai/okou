import { randomUUID } from "node:crypto";
import {
  chatThreadArchiveContract,
  chatThreadMetadataContract,
  chatThreadMuteContract,
  chatThreadRenameContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { chatThreadRoutes } from "../chat-threads";
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

function app(member: Member) {
  createRouteMocks(context).clerk.session(member.userId, member.orgId);
  return setupApp({ context, routes: chatThreadRoutes });
}

async function createTitledThread(
  member: Member,
  title: string,
): Promise<string> {
  const created = await accept(
    app(member)(chatThreadsContract).create({ headers, body: {} }),
    [201],
  );
  await accept(
    app(member)(chatThreadRenameContract).rename({
      headers,
      params: { id: created.body.id },
      body: { title },
    }),
    [204],
  );
  return created.body.id;
}

function mute(member: Member, threadId: string, eventId?: string) {
  return app(member)(chatThreadMuteContract).mute({
    headers,
    params: { id: threadId },
    query: eventId === undefined ? undefined : { eventId },
  });
}

function unmute(member: Member, threadId: string, eventId?: string) {
  return app(member)(chatThreadMuteContract).unmute({
    headers,
    params: { id: threadId },
    query: eventId === undefined ? undefined : { eventId },
  });
}

async function metadata(member: Member, threadId: string) {
  const read = await accept(
    app(member)(chatThreadMetadataContract).get({
      headers,
      params: { id: threadId },
    }),
    [200],
  );
  return read.body;
}

test("chat-threads-mute-001 keeps the title and archive state through idempotent mute changes", async () => {
  const owner = newMember();
  const threadId = await createTitledThread(owner, "Keep this title");
  await accept(
    app(owner)(chatThreadArchiveContract).archive({
      headers,
      params: { id: threadId },
    }),
    [204],
  );

  const muteEventId = randomUUID();
  await accept(mute(owner, threadId, muteEventId), [204]);
  await accept(mute(owner, threadId), [204]);
  await expect(metadata(owner, threadId)).resolves.toMatchObject({
    title: "Keep this title",
    archived: true,
    muted: true,
  });

  const unmuteEventId = randomUUID();
  await accept(unmute(owner, threadId, unmuteEventId), [204]);
  await expect(metadata(owner, threadId)).resolves.toMatchObject({
    title: "Keep this title",
    archived: true,
    muted: false,
  });

  const feed = await accept(
    app(owner)(chatThreadsContract).events({ headers, query: {} }),
    [200],
  );
  expect(feed.body.events).toContainEqual(
    expect.objectContaining({
      id: muteEventId,
      kind: "sort_touched",
      chatThreadId: threadId,
      muted: true,
    }),
  );
  expect(feed.body.events).toContainEqual(
    expect.objectContaining({
      id: unmuteEventId,
      kind: "sort_touched",
      chatThreadId: threadId,
      muted: false,
    }),
  );
});

test("chat-threads-mute-003 hides the mute endpoints from other users and workspaces", async () => {
  const owner = newMember();
  const threadId = await createTitledThread(owner, "Owner thread");

  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  const anonymous = setupApp({ context, routes: chatThreadRoutes })(
    chatThreadMuteContract,
  );
  await accept(
    anonymous.mute({ headers: {}, params: { id: threadId } }),
    [401],
  );

  const peer = newMember(owner.orgId);
  const ownerElsewhere = newMember();
  const sameUserOtherWorkspace = {
    userId: owner.userId,
    orgId: ownerElsewhere.orgId,
  };
  for (const outsider of [peer, sameUserOtherWorkspace]) {
    await accept(mute(outsider, threadId), [404]);
    await accept(unmute(outsider, threadId), [404]);
  }

  await expect(metadata(owner, threadId)).resolves.toMatchObject({
    muted: false,
  });
});
