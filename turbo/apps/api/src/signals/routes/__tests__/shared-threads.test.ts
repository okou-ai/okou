import { randomUUID } from "node:crypto";

import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { sharedThreadVisibilityContract } from "@okouai/api-contracts/contracts/shared-thread-visibility";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { welcomeChatThreadsContract } from "@okouai/api-contracts/contracts/welcome-chat-threads";
import { createStore } from "ccstate";
import { http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { artifactCatalogRoutes } from "../artifact-catalog";
import { chatThreadRoutes } from "../chat-threads";
import { sharedThreadRoutes } from "../shared-threads";
import { welcomeChatThreadRoutes } from "../welcome-chat-threads";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { projectChatEventRows } from "./helpers/chat-event-test-reader";
import {
  mockGoogleText,
  VERTEX_TEXT_URL,
  vertexTextRequest,
  vertexTextResponse,
} from "./helpers/google-text";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
} from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { installSharedThreadStorage } from "./helpers/shared-thread-storage";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const app = setupApp({
  context,
  routes: [
    ...sharedThreadRoutes,
    ...artifactCatalogRoutes,
    ...welcomeChatThreadRoutes,
    ...chatThreadRoutes,
  ],
});
const shares = app(sharedThreadsContract);
const visibility = app(sharedThreadVisibilityContract);
const catalog = app(artifactCatalogContract);
const welcomeThreads = app(welcomeChatThreadsContract);
const threadEvents = app(chatThreadEventsContract);

function signIn(user: ApiTestUser | null) {
  if (!user) {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    return {};
  }
  createRouteMocks(context).clerk.session(
    user.userId,
    user.orgId,
    user.orgRole ?? "org:admin",
  );
  return headers;
}

/** A member's Thread with one durable text-only message; returns its ID and text. */
async function threadWithMessage(member: ApiTestUser): Promise<{
  readonly threadId: string;
  readonly eventId: string;
  readonly content: string;
}> {
  const created = await accept(
    welcomeThreads.create({
      headers: signIn(member),
      body: { clientThreadId: randomUUID() },
    }),
    [201],
  );
  const threadId = created.body.id;
  const listed = await accept(
    threadEvents.rows({
      headers: signIn(member),
      params: { threadId },
      query: { sinceSeqId: 0, limit: 50 },
    }),
    [200],
  );
  const events = projectChatEventRows(listed.body.rows);
  const message = events.find((event) => {
    return event.eventType === "output.message";
  });
  if (!message || message.eventType !== "output.message" || !message.content) {
    throw new Error("Expected a text message in the Thread");
  }
  return { threadId, eventId: message.id, content: message.content };
}

async function sharedCatalogEntries(member: ApiTestUser, threadId: string) {
  const listed = await accept(
    catalog.list({
      headers: signIn(member),
      query: { kind: "shared-thread", chatThreadId: threadId },
    }),
    [200],
  );
  return listed.body.artifacts;
}

/** Title model fixture that records every shared-title request it answers. */
function titleModel(text: string) {
  mockGoogleText();
  const requests: ReturnType<typeof vertexTextRequest>[] = [];
  server.use(
    http.post(VERTEX_TEXT_URL, async ({ request }) => {
      requests.push(vertexTextRequest(await request.json(), request.url));
      return vertexTextResponse(text);
    }),
  );
  return requests;
}

function setupVisibilityStorage() {
  mockEnv("R2_HOSTED_SITES_BUCKET_NAME", "test-hosted-sites");
  installSharedThreadStorage(context);
}

describe("conversation share visibility", () => {
  it("shared-threads-015 (1/2) creates a private snapshot without exposing content or title anonymously", async () => {
    setupVisibilityStorage();
    const bdd = createBddApi(context);
    const owner = bdd.user();
    if (!owner.orgId) {
      throw new Error("Expected organization ID");
    }
    const store = createStore();
    await store.set(
      seedOrgMembership$,
      {
        orgId: owner.orgId,
        userId: owner.userId,
        role: "admin",
        name: "Origin Workspace",
      },
      context.signal,
    );
    const { threadId, eventId, content } = await threadWithMessage(owner);
    const uppercaseId = randomUUID().toUpperCase();

    const created = await accept(
      visibility.create({
        headers: signIn(owner),
        params: { threadId },
        body: { id: uppercaseId, eventIds: [eventId], audience: "private" },
      }),
      [201],
    );
    const shareId = created.body.id;
    expect(shareId).toBe(uppercaseId.toLowerCase());

    const [anonRead, anonMeta] = await Promise.all([
      accept(
        shares.get({ headers: signIn(null), params: { id: shareId } }),
        [404],
      ),
      accept(shares.meta({ params: { id: shareId } }), [404]),
    ]);
    expect(anonRead.headers.get("cache-control")).toBe("no-store");
    expect(anonMeta.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify([anonRead.body, anonMeta.body])).not.toContain(
      content,
    );
  });

  it("shared-threads-015 (2/2) allows the owner to read the private snapshot while blocking a stranger", async () => {
    setupVisibilityStorage();
    const bdd = createBddApi(context);
    const owner = bdd.user();
    const stranger = bdd.user();
    if (!owner.orgId || !stranger.orgId) {
      throw new Error("Expected organization IDs");
    }
    const store = createStore();
    await store.set(
      seedOrgMembership$,
      {
        orgId: owner.orgId,
        userId: owner.userId,
        role: "admin",
        name: "Origin Workspace",
      },
      context.signal,
    );
    await store.set(
      seedOrgMembership$,
      {
        orgId: stranger.orgId,
        userId: stranger.userId,
        role: "admin",
        name: "Other Workspace",
      },
      context.signal,
    );
    const { threadId, eventId, content } = await threadWithMessage(owner);
    const uppercaseId = randomUUID().toUpperCase();

    const created = await accept(
      visibility.create({
        headers: signIn(owner),
        params: { threadId },
        body: { id: uppercaseId, eventIds: [eventId], audience: "private" },
      }),
      [201],
    );
    const shareId = created.body.id;

    const ownerRead = await accept(
      shares.get({ headers: signIn(owner), params: { id: shareId } }),
      [200],
    );
    expect(ownerRead.body.messages).toStrictEqual([
      { messageIndex: 0, role: "assistant", content },
    ]);

    const strangerHeaders = signIn(stranger);
    await Promise.all([
      accept(
        shares.get({ headers: strangerHeaders, params: { id: shareId } }),
        [404],
      ),
      accept(
        visibility.get({ headers: strangerHeaders, params: { id: shareId } }),
        [403, 404],
      ),
    ]);
  });

  it("shared-threads-016 changes an existing text-only link and checks membership in its original workspace on every read", async () => {
    setupVisibilityStorage();
    const bdd = createBddApi(context);
    const owner = bdd.user();
    const recipient = bdd.user({ orgId: owner.orgId, orgRole: "org:member" });
    if (!owner.orgId) {
      throw new Error("Expected owner organization ID");
    }
    const workspaceName = "Original Workspace";
    const store = createStore();
    await store.set(
      seedOrgMembership$,
      {
        orgId: owner.orgId,
        userId: owner.userId,
        role: "admin",
        name: workspaceName,
      },
      context.signal,
    );
    await store.set(
      seedOrgMembership$,
      {
        orgId: owner.orgId,
        userId: recipient.userId,
        role: "member",
        name: workspaceName,
      },
      context.signal,
    );
    const { threadId, eventId, content } = await threadWithMessage(owner);
    const created = await accept(
      shares.create({
        headers: signIn(owner),
        params: { threadId },
        body: { eventIds: [eventId] },
      }),
      [201],
    );
    const shareId = created.body.id;

    const initial = await accept(
      visibility.get({ headers: signIn(owner), params: { id: shareId } }),
      [200],
    );
    expect(initial.body.audience).toBe("public");

    const orgUpdated = await accept(
      visibility.update({
        headers: signIn(owner),
        params: { id: shareId.toUpperCase() },
        body: {
          audience: "organization",
          expectedRevision: initial.body.revision,
        },
      }),
      [200],
    );
    expect(orgUpdated.body).toMatchObject({
      id: shareId,
      audience: "organization",
      organization: { id: owner.orgId, name: workspaceName },
    });

    await Promise.all([
      accept(
        shares.get({ headers: signIn(null), params: { id: shareId } }),
        [404],
      ),
      accept(shares.meta({ params: { id: shareId } }), [404]),
    ]);

    const memberRead = await accept(
      shares.get({ headers: signIn(recipient), params: { id: shareId } }),
      [200],
    );
    expect(memberRead.body.messages).toStrictEqual([
      { messageIndex: 0, role: "assistant", content },
    ]);

    await store.set(
      deleteOrgMembership$,
      { orgId: owner.orgId, userId: recipient.userId },
      context.signal,
    );
    await accept(
      shares.get({ headers: signIn(recipient), params: { id: shareId } }),
      [404],
    );

    await store.set(
      seedOrgMembership$,
      {
        orgId: owner.orgId,
        userId: recipient.userId,
        role: "member",
        name: workspaceName,
      },
      context.signal,
    );
    const privateUpdated = await accept(
      visibility.update({
        headers: signIn(owner),
        params: { id: shareId },
        body: {
          audience: "private",
          expectedRevision: orgUpdated.body.revision,
        },
      }),
      [200],
    );
    await accept(
      shares.get({ headers: signIn(recipient), params: { id: shareId } }),
      [404],
    );

    await accept(
      visibility.update({
        headers: signIn(owner),
        params: { id: shareId },
        body: {
          audience: "public",
          expectedRevision: privateUpdated.body.revision,
        },
      }),
      [200],
    );
    const publicRead = await accept(
      shares.get({ headers: signIn(null), params: { id: shareId } }),
      [200],
    );
    expect(publicRead.body.messages).toStrictEqual(memberRead.body.messages);
  });

  it("shared-threads-017 rejects stale edits and unauthorized changes while preserving private access", async () => {
    setupVisibilityStorage();
    const bdd = createBddApi(context);
    const owner = bdd.user();
    const stranger = bdd.user();
    if (!owner.orgId || !stranger.orgId) {
      throw new Error("Expected organization IDs");
    }
    const store = createStore();
    await store.set(
      seedOrgMembership$,
      {
        orgId: owner.orgId,
        userId: owner.userId,
        role: "admin",
        name: "Owner Org",
      },
      context.signal,
    );
    await store.set(
      seedOrgMembership$,
      {
        orgId: stranger.orgId,
        userId: stranger.userId,
        role: "admin",
        name: "Stranger Org",
      },
      context.signal,
    );
    const { threadId, eventId, content } = await threadWithMessage(owner);

    const created = await accept(
      visibility.create({
        headers: signIn(owner),
        params: { threadId },
        body: { eventIds: [eventId], audience: "organization" },
      }),
      [201],
    );
    const shareId = created.body.id;

    const initial = await accept(
      visibility.get({ headers: signIn(owner), params: { id: shareId } }),
      [200],
    );
    const staleRevision = initial.body.revision;

    const privateUpdated = await accept(
      visibility.update({
        headers: signIn(owner),
        params: { id: shareId },
        body: { audience: "private", expectedRevision: staleRevision },
      }),
      [200],
    );
    const currentRevision = privateUpdated.body.revision;

    await accept(
      visibility.update({
        headers: signIn(owner),
        params: { id: shareId },
        body: { audience: "public", expectedRevision: staleRevision },
      }),
      [409],
    );
    await accept(
      visibility.update({
        headers: signIn(stranger),
        params: { id: shareId },
        body: { audience: "public", expectedRevision: currentRevision },
      }),
      [404],
    );
    await accept(
      visibility.update({
        headers: signIn({ ...owner, orgId: stranger.orgId }),
        params: { id: shareId },
        body: { audience: "public", expectedRevision: currentRevision },
      }),
      [403, 404],
    );

    await accept(
      shares.get({ headers: signIn(null), params: { id: shareId } }),
      [404],
    );
    const ownerRead = await accept(
      shares.get({ headers: signIn(owner), params: { id: shareId } }),
      [200],
    );
    expect(ownerRead.body.messages).toStrictEqual([
      { messageIndex: 0, role: "assistant", content },
    ]);
  });
});

describe("optional shared-thread titles", () => {
  it("shared-threads-011 rejects unauthenticated, foreign and empty selections without a share", async () => {
    const bdd = createBddApi(context);
    const owner = bdd.user();
    const teammate = bdd.user({ orgId: owner.orgId, orgRole: "org:member" });
    const stranger = bdd.user();
    const { threadId, eventId } = await threadWithMessage(owner);
    const titleRequests = titleModel("Release notes");
    const body = { eventIds: [eventId] };

    await accept(
      shares.create({ headers: signIn(null), params: { threadId }, body }),
      [401],
    );
    await accept(
      shares.create({
        headers: signIn(teammate),
        params: { threadId },
        body,
      }),
      [404],
    );
    await accept(
      shares.create({
        headers: signIn(stranger),
        params: { threadId },
        body,
      }),
      [404],
    );
    const unknown = await accept(
      shares.create({
        headers: signIn(owner),
        params: { threadId },
        body: { eventIds: [randomUUID()] },
      }),
      [400],
    );

    expect(unknown.body.error.code).toBe("NO_SHAREABLE_MESSAGES");
    await expect(sharedCatalogEntries(owner, threadId)).resolves.toStrictEqual(
      [],
    );
    expect(titleRequests).toStrictEqual([]);
  });
});

describe("client-generated shared-thread IDs", () => {
  it("shared-threads-013 publishes the share under the ID the client already copied", async () => {
    const bdd = createBddApi(context);
    const owner = bdd.user();
    const { threadId, eventId, content } = await threadWithMessage(owner);
    const clientShareId = randomUUID();

    const created = await accept(
      shares.create({
        headers: signIn(owner),
        params: { threadId },
        body: { id: clientShareId, eventIds: [eventId] },
      }),
      [201],
    );
    expect(created.body).toStrictEqual({ id: clientShareId });

    const [shareRead, metaRead, catalogEntries] = await Promise.all([
      accept(
        shares.get({ headers: signIn(null), params: { id: clientShareId } }),
        [200],
      ),
      accept(shares.meta({ params: { id: clientShareId } }), [200]),
      sharedCatalogEntries(owner, threadId),
    ]);

    expect(shareRead.body).toStrictEqual({
      id: clientShareId,
      title: "Shared conversation",
      messages: [{ messageIndex: 0, role: "assistant", content }],
    });
    expect(metaRead.body).toStrictEqual({ title: "Shared conversation" });
    expect(catalogEntries).toStrictEqual([
      expect.objectContaining({
        kind: "shared-thread",
        sharedThreadId: clientShareId,
        title: "Shared conversation",
      }),
    ]);
  });
});
