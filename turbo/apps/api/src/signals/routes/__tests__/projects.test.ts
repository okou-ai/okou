import { gunzipSync } from "node:zlib";
import {
  chatThreadByIdContract,
  chatThreadDraftContract,
  chatThreadsContract,
  type UserMessageInputDocument,
  type UserMessageInputPart,
} from "@okouai/api-contracts/contracts/chat-threads";
import { composerDraftContract } from "@okouai/api-contracts/contracts/composer-draft";
import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import { v7 } from "uuid";

import { setupApp } from "../../../__tests__/test-helpers";
import { accept, testContext } from "../../../__tests__/test-context";
import { now } from "../../../lib/time";
import { chatThreadRoutes } from "../chat-threads";
import { chatThreadDraftGetRoutes } from "../chat-threads-draft-get";
import { chatThreadPatchRoutes } from "../chat-threads-patch";
import { composerDraftRoutes } from "../composer-draft";
import { projectRoutes } from "../projects";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

/** Project operation identities are fresh UUIDv7 values. */
function operationId(msecs = now()) {
  return v7({ msecs });
}

function api() {
  return setupApp({ context, routes: projectRoutes })(projectsContract);
}

function as(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return api();
}

async function onboardedMember(): Promise<ApiTestUser> {
  const member = bdd.user();
  bdd.acceptStorageWrites();
  await bdd.completeOnboarding(member);
  return member;
}

async function createProject(
  actor: ApiTestUser,
  name: string,
  fromThreadId?: string,
) {
  const projectId = operationId();
  const response = await accept(
    as(actor).create({
      headers,
      body: {
        id: projectId,
        eventId: projectId,
        name,
        ...(fromThreadId === undefined ? {} : { fromThreadId }),
      },
    }),
    [201],
  );
  return response.body;
}

async function listNames(actor: ApiTestUser) {
  const response = await accept(as(actor).list({ headers }), [200]);
  return response.body.projects.map((project) => {
    return project.name;
  });
}

async function reorder(
  actor: ApiTestUser,
  id: string,
  targetId: string,
  side: "before" | "after",
) {
  const response = await accept(
    as(actor).reorder({
      headers,
      params: { id },
      body: { eventId: operationId(), targetId, side },
    }),
    [204],
  );
  return response.status;
}

/** Record immutable snapshot archives written to object storage. */
function recordSnapshots() {
  const archives: unknown[] = [];
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const { constructor, input } = command as {
      readonly constructor: { readonly name: string };
      readonly input: Record<string, unknown>;
    };
    if (
      constructor.name === "PutObjectCommand" &&
      String(input.Key).startsWith("project-snapshots/v1/")
    ) {
      archives.push(
        JSON.parse(gunzipSync(input.Body as Uint8Array).toString("utf8")),
      );
    }
    return Promise.resolve({});
  });
  context.mocks.s3.getSignedUrl.mockResolvedValue(
    "https://r2.example.com/project-snapshot.json.gz",
  );
  return archives;
}

describe("private Projects", () => {
  it("projects-008 isolates each member's Projects across colleagues and organizations", async () => {
    const owner = await onboardedMember();
    const project = await createProject(owner, "Owner project");
    const colleague = bdd.user({ orgId: owner.orgId, orgRole: "org:member" });
    const elsewhere = bdd.user({ userId: owner.userId });

    const colleagueRead = await accept(
      as(colleague).get({ headers, params: { id: project.id } }),
      [404],
    );
    expect(colleagueRead.status).toBe(404);
    await expect(listNames(colleague)).resolves.toStrictEqual([]);
    const otherOrgRead = await accept(
      as(elsewhere).get({ headers, params: { id: project.id } }),
      [404],
    );
    expect(otherOrgRead.status).toBe(404);
  });

  it("projects-002 moves Projects before and after targets, keeps rank on rename and appends new Projects", async () => {
    const member = await onboardedMember();
    const first = await createProject(member, "First");
    const second = await createProject(member, "Second");
    const third = await createProject(member, "Third");
    for (const project of [first, second, third]) {
      expect(typeof project.sortOrder).toBe("string");
    }
    await expect(listNames(member)).resolves.toStrictEqual([
      "First",
      "Second",
      "Third",
    ]);
    const before = await accept(
      as(member).events({ headers, query: { sinceSeqId: 0 } }),
      [200],
    );
    const sinceSeqId = Math.max(
      0,
      ...before.body.events.map((event) => {
        return event.seqId;
      }),
    );

    await expect(reorder(member, third.id, first.id, "before")).resolves.toBe(
      204,
    );
    await expect(listNames(member)).resolves.toStrictEqual([
      "Third",
      "First",
      "Second",
    ]);
    await expect(reorder(member, first.id, second.id, "after")).resolves.toBe(
      204,
    );
    await expect(listNames(member)).resolves.toStrictEqual([
      "Third",
      "Second",
      "First",
    ]);
    const firstRank = (
      await accept(as(member).get({ headers, params: { id: first.id } }), [200])
    ).body.sortOrder;

    const renamed = await accept(
      as(member).update({
        headers,
        params: { id: first.id },
        body: { eventId: operationId(), name: "First renamed" },
      }),
      [200],
    );
    expect(renamed.body.sortOrder).toBe(firstRank);
    await createProject(member, "Fourth");
    await expect(listNames(member)).resolves.toStrictEqual([
      "Third",
      "Second",
      "First renamed",
      "Fourth",
    ]);

    const events = await accept(
      as(member).events({ headers, query: { sinceSeqId } }),
      [200],
    );
    const sorts = events.body.events.filter((event) => {
      return event.kind === "sort_updated";
    });
    expect(
      sorts.map((event) => {
        return event.projectId;
      }),
    ).toStrictEqual([third.id, first.id]);
    expect(sorts[1]?.sortOrder).toBe(firstRank);
  });

  it("projects-001 archives and restores a Project with its original member", async () => {
    const member = await onboardedMember();
    const project = await createProject(member, "Archive me");
    const thread = await chat.createThread(member, {
      model: null,
      projectId: project.id,
    });
    const archives = recordSnapshots();

    const archived = await accept(
      as(member).update({
        headers,
        params: { id: project.id },
        body: { eventId: operationId(), archived: true },
      }),
      [200],
    );
    expect(archived.body.archived).toBeTruthy();
    const lastArchivedAt = archived.body.lastArchivedAt;
    expect(typeof lastArchivedAt).toBe("string");
    const snapshot = await accept(as(member).snapshot({ headers }), [200]);
    expect(archives).toHaveLength(1);
    expect(archives[0]).toMatchObject({
      projects: [{ id: project.id, archived: true, lastArchivedAt }],
    });
    expect(
      (archives[0] as { readonly projects: readonly unknown[] }).projects,
    ).toHaveLength(1);

    await accept(
      as(member).update({
        headers,
        params: { id: project.id },
        body: { eventId: operationId(), archived: false },
      }),
      [200],
    );
    const events = await accept(
      as(member).events({
        headers,
        query: { sinceSeqId: snapshot.body.latestSeqId },
      }),
      [200],
    );
    expect(events.body.events).toHaveLength(1);
    expect(events.body.events[0]).toMatchObject({
      projectId: project.id,
      archived: false,
      lastArchivedAt,
    });
    const restored = await accept(
      as(member).get({ headers, params: { id: project.id } }),
      [200],
    );
    expect(restored.body).toMatchObject({
      lastArchivedAt,
      sortOrder: project.sortOrder,
    });
    const threads = await accept(
      as(member).threads({
        headers,
        params: { id: project.id },
        query: { archived: "all" },
      }),
      [200],
    );
    expect(threads.body.threads).toHaveLength(1);
    expect(threads.body.threads[0]).toMatchObject({
      id: thread.id,
      archived: false,
    });
  });

  it("projects-007 preserves structured Project references through Thread and composer drafts", async () => {
    const member = await onboardedMember();
    const project = await createProject(member, "Launch");
    const thread = await chat.createThread(member, { projectId: project.id });
    const mention: Extract<UserMessageInputPart, { type: "project" }> = {
      type: "project",
      projectId: project.id,
      nameSnapshot: "Launch",
    };
    const draftUserMessage: UserMessageInputDocument = {
      version: 1,
      parts: [
        { type: "text", text: "Review " },
        mention,
        {
          type: "feedback",
          quote: "the launch plan",
          note: [{ type: "text", text: "Compare with " }, mention],
        },
      ],
    };
    createRouteMocks(context).clerk.session(
      member.userId,
      member.orgId,
      member.orgRole,
    );

    const savedThread = await accept(
      setupApp({ context, routes: chatThreadPatchRoutes })(
        chatThreadByIdContract,
      ).patch({
        headers,
        params: { id: thread.id },
        body: { draftUserMessage },
      }),
      [204],
    );
    expect(savedThread.status).toBe(204);
    const threadDraft = await accept(
      setupApp({ context, routes: chatThreadDraftGetRoutes })(
        chatThreadDraftContract,
      ).get({ headers, params: { id: thread.id } }),
      [200],
    );
    expect(threadDraft.body.draftUserMessage).toStrictEqual(draftUserMessage);

    const composer = setupApp({ context, routes: composerDraftRoutes })(
      composerDraftContract,
    );
    const savedComposer = await accept(
      composer.patch({ headers, body: { draftUserMessage } }),
      [204],
    );
    expect(savedComposer.status).toBe(204);
    const composerDraft = await accept(composer.get({ headers }), [200]);
    expect(composerDraft.body.draftUserMessage).toStrictEqual(draftUserMessage);
  });

  it("projects-009 keeps thread activity across Project moves and ignores a replayed old move", async () => {
    const member = await onboardedMember();
    const first = await chat.createThread(member, { model: null });
    const second = await chat.createThread(member, { model: null });
    const launch = await createProject(member, "Launch", first.id);
    const research = await createProject(member, "Research");
    const move = async (
      threadId: string,
      projectId: string,
      eventId: string,
      status: 200 | 409,
    ) => {
      const response = await accept(
        as(member).membership({
          headers,
          params: { id: threadId },
          body: { eventId, projectId },
        }),
        [status],
      );
      return response.status;
    };
    const threadIds = async (projectId: string) => {
      const response = await accept(
        as(member).threads({
          headers,
          params: { id: projectId },
          query: { archived: "all" },
        }),
        [200],
      );
      return response.body.threads;
    };

    await expect(move(second.id, launch.id, operationId(), 200)).resolves.toBe(
      200,
    );
    await reorder(member, research.id, launch.id, "before");
    const launchThreads = await threadIds(launch.id);
    expect(
      launchThreads
        .map((thread) => {
          return thread.id;
        })
        .sort(),
    ).toStrictEqual([first.id, second.id].sort());
    const firstThread = launchThreads.find((thread) => {
      return thread.id === first.id;
    });
    expect(firstThread?.sortAt).toBe(firstThread?.createdAt);

    const oldMove = operationId();
    await expect(move(first.id, launch.id, oldMove, 200)).resolves.toBe(200);
    await expect(move(first.id, research.id, operationId(), 200)).resolves.toBe(
      200,
    );
    await expect(move(first.id, launch.id, oldMove, 200)).resolves.toBe(200);
    expect(
      (await threadIds(research.id)).map((thread) => {
        return thread.id;
      }),
    ).toStrictEqual([first.id]);

    await expect(move(second.id, research.id, oldMove, 409)).resolves.toBe(409);
    const expired = operationId(now() - 8 * 24 * 60 * 60 * 1000);
    await expect(move(second.id, research.id, expired, 409)).resolves.toBe(409);
  });

  it("projects-010 deletes the Project, clears each membership and never resurrects the old creation", async () => {
    const member = await onboardedMember();
    const first = await chat.createThread(member, { model: null });
    const launch = await createProject(member, "Launch", first.id);
    const second = await chat.createThread(member, {
      model: null,
      projectId: launch.id,
    });
    const listed = await accept(
      as(member).threads({
        headers,
        params: { id: launch.id },
        query: { archived: "all" },
      }),
      [200],
    );
    expect(
      listed.body.threads.find((thread) => {
        return thread.id === second.id;
      })?.projectId,
    ).toBe(launch.id);

    const deleted = await accept(
      as(member).delete({
        headers,
        params: { id: launch.id },
        body: { eventId: operationId() },
      }),
      [204],
    );
    expect(deleted.status).toBe(204);
    const read = await accept(
      as(member).get({ headers, params: { id: launch.id } }),
      [404],
    );
    expect(read.status).toBe(404);

    createRouteMocks(context).clerk.session(
      member.userId,
      member.orgId,
      member.orgRole,
    );
    const threadEvents = await accept(
      setupApp({ context, routes: chatThreadRoutes })(
        chatThreadsContract,
      ).events({ headers, query: {} }),
      [200],
    );
    for (const thread of [first, second]) {
      const events = threadEvents.body.events.filter((event) => {
        return event.chatThreadId === thread.id;
      });
      const lastMembership = events
        .filter((event) => {
          return event.kind === "project_updated";
        })
        .at(-1);
      expect(lastMembership?.projectId).toBeNull();
      expect(
        events.some((event) => {
          return event.kind === "deleted";
        }),
      ).toBeFalsy();
    }

    const recreated = await accept(
      as(member).create({
        headers,
        body: {
          id: launch.id,
          eventId: launch.id,
          name: "Launch",
          fromThreadId: first.id,
        },
      }),
      [404],
    );
    expect(recreated.status).toBe(404);
  });

  it("projects-011 rejects a missing source thread without creating a Project or publishing events", async () => {
    const member = await onboardedMember();
    const projectId = operationId();

    const created = await accept(
      as(member).create({
        headers,
        body: {
          id: projectId,
          eventId: projectId,
          name: "Orphan",
          fromThreadId: operationId(),
        },
      }),
      [404],
    );

    expect(created.status).toBe(404);
    await expect(listNames(member)).resolves.toStrictEqual([]);
    const events = await accept(
      as(member).events({ headers, query: { sinceSeqId: 0 } }),
      [200],
    );
    expect(events.body.events).toStrictEqual([]);
  });
});
