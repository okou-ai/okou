import { randomUUID } from "node:crypto";
import {
  chatThreadMarkReadContract,
  chatThreadMarkUnreadContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatThreadRoutes } from "../chat-threads";
import { chatThreadMarkReadRoutes } from "../chat-threads-mark-read";
import { chatThreadMarkUnreadRoutes } from "../chat-threads-mark-unread";
import { channelsPublishedTo } from "./helpers/realtime-publications";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const sessionHeaders = Object.freeze({ authorization: "Bearer clerk-session" });

interface Member {
  readonly userId: string;
  readonly orgId: string;
}

function newMember(orgId = `org_${randomUUID()}`): Member {
  return { userId: `user_${randomUUID()}`, orgId };
}

function signIn(member: Member): void {
  createRouteMocks(context).clerk.session(member.userId, member.orgId);
}

async function createThread(member: Member): Promise<string> {
  signIn(member);
  const created = await accept(
    setupApp({ context, routes: chatThreadRoutes })(chatThreadsContract).create(
      { headers: sessionHeaders, body: {} },
    ),
    [201],
  );
  return created.body.id;
}

function markRead(member: Member, threadId: string) {
  signIn(member);
  return setupApp({ context, routes: chatThreadMarkReadRoutes })(
    chatThreadMarkReadContract,
  ).markRead({ headers: sessionHeaders, params: { id: threadId } });
}

function markUnread(member: Member, threadId: string) {
  signIn(member);
  return setupApp({ context, routes: chatThreadMarkUnreadRoutes })(
    chatThreadMarkUnreadContract,
  ).markUnread({ headers: sessionHeaders, params: { id: threadId } });
}

describe("chat thread read cursor", () => {
  it("chat-thread-read-cursor-005 hides another member's thread and an unknown thread from read state changes", async () => {
    const owner = newMember();
    const peer = newMember(owner.orgId);
    const threadId = await createThread(owner);

    await accept(markRead(peer, threadId), [404]);
    await accept(markUnread(peer, threadId), [404]);

    const unknownThreadId = randomUUID();
    await accept(markRead(owner, unknownThreadId), [404]);
    await accept(markUnread(owner, unknownThreadId), [404]);

    await flushWaitUntilForTest();
    expect(
      channelsPublishedTo(context.mocks, "chatThreadReadCursorUpdated"),
    ).toStrictEqual([]);
  });
});
