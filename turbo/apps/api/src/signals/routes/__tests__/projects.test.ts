import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import {
  chatThreadsContract,
  chatThreadByIdContract,
  chatThreadDraftContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import { createProjectOperationId } from "@okouai/core/project-operation-id";
import { testContext, accept } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { projectRoutes } from "../projects";
import { chatThreadRoutes } from "../chat-threads";
import { agentDraftRoutes } from "../agent-draft";
import {
  createBddApi,
  type ApiTestUser,
  type ApiTestUserOptions,
} from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
function operation() {
  return createProjectOperationId(now(), randomUUID());
}
function headers(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}
function client() {
  return setupApp({ context, routes: projectRoutes })(projectsContract);
}
function threads() {
  return setupApp({ context, routes: chatThreadRoutes })(chatThreadsContract);
}
function owner(options?: ApiTestUserOptions) {
  const actor = bdd.user(options);
  if (!actor.orgId) {
    throw new Error("Project fixture requires an organization");
  }
  return actor;
}
async function create(
  actor: ApiTestUser,
  name = "Campaign",
  fromThreadId?: string,
) {
  const id = operation();
  return (
    await accept(
      client().create({
        headers: headers(actor),
        body: { id, eventId: id, name, fromThreadId },
      }),
      [201],
    )
  ).body;
}
async function agent(actor: ApiTestUser) {
  bdd.acceptAgentStorageWrites();
  await runs.ensurePersonalSubscriptionModel(actor, {
    model: "claude-sonnet-5-5",
  });
  await createBddIntegrationApi(context).configureNativeSubscriptionModels(
    actor,
  );
  await runs.updateUserModelPreference(actor, "claude-sonnet-5-5");
  return await bdd.createAgent(actor, {
    displayName: "Project Agent",
    visibility: "private",
  });
}
async function thread(actor: ApiTestUser, agentId: string, projectId?: string) {
  return (
    await accept(
      threads().create({
        headers: headers(actor),
        body: {
          agentId,
          clientThreadId: randomUUID(),
          eventId: randomUUID(),
          projectId,
        },
      }),
      [201],
    )
  ).body;
}
async function move(
  actor: ApiTestUser,
  threadId: string,
  projectId: string | null,
  eventId = operation(),
) {
  return await client().membership({
    headers: headers(actor),
    params: { id: threadId },
    body: { projectId, eventId },
  });
}

function reorder(
  actor: ApiTestUser,
  projectId: string,
  targetId: string,
  side: "before" | "after",
  eventId = operation(),
) {
  return client().reorder({
    headers: headers(actor),
    params: { id: projectId },
    body: { targetId, side, eventId },
  });
}
async function listedIds(actor: ApiTestUser) {
  const result = await accept(
    client().list({ headers: headers(actor) }),
    [200],
  );
  return result.body.projects.map((project) => {
    return project.id;
  });
}

describe("private Project order", () => {
  it("moves whole groups before and after targets, preserves rank on rename and appends new Projects", async () => {
    const actor = owner();
    const first = await create(actor, "First");
    const second = await create(actor, "Second");
    const third = await create(actor, "Third");
    expect(first.sortOrder).toStrictEqual(expect.any(String));
    await expect(listedIds(actor)).resolves.toStrictEqual([
      first.id,
      second.id,
      third.id,
    ]);
    await accept(reorder(actor, third.id, first.id, "before"), [204]);
    await expect(listedIds(actor)).resolves.toStrictEqual([
      third.id,
      first.id,
      second.id,
    ]);
    await accept(reorder(actor, first.id, second.id, "after"), [204]);
    const moved = await accept(
      client().get({ headers: headers(actor), params: { id: first.id } }),
      [200],
    );
    const renamed = await accept(
      client().update({
        headers: headers(actor),
        params: { id: first.id },
        body: { eventId: operation(), name: "Renamed" },
      }),
      [200],
    );
    expect(renamed.body.sortOrder).toBe(moved.body.sortOrder);
    const fourth = await create(actor, "Fourth");
    await expect(listedIds(actor)).resolves.toStrictEqual([
      third.id,
      second.id,
      first.id,
      fourth.id,
    ]);
    const events = await accept(
      client().events({ headers: headers(actor), query: { sinceSeqId: 0 } }),
      [200],
    );
    expect(
      events.body.events.filter((event) => {
        return event.kind === "sort_updated";
      }),
    ).toMatchObject([
      { projectId: third.id, sortOrder: expect.any(String) },
      { projectId: first.id, sortOrder: moved.body.sortOrder },
    ]);
  });

  it("settles no-op and replayed moves by event identity without undoing a newer order", async () => {
    const actor = owner();
    const first = await create(actor, "First");
    const second = await create(actor, "Second");
    const third = await create(actor, "Third");
    const eventId = operation();
    await accept(reorder(actor, third.id, first.id, "before", eventId), [204]);
    await accept(reorder(actor, third.id, second.id, "after"), [204]);
    await accept(reorder(actor, third.id, first.id, "before", eventId), [204]);
    await expect(listedIds(actor)).resolves.toStrictEqual([
      first.id,
      second.id,
      third.id,
    ]);
    expect(
      (await reorder(actor, third.id, second.id, "before", eventId)).status,
    ).toBe(409);
    const noop = operation();
    await accept(reorder(actor, third.id, second.id, "after", noop), [204]);
    const events = await accept(
      client().events({ headers: headers(actor), query: { sinceSeqId: 0 } }),
      [200],
    );
    expect(
      events.body.events.filter((event) => {
        return event.id === eventId;
      }),
    ).toHaveLength(1);
    expect(events.body.events).toContainEqual(
      expect.objectContaining({
        id: noop,
        kind: "sort_updated",
        projectId: third.id,
      }),
    );
    await expect(listedIds(actor)).resolves.toStrictEqual([
      first.id,
      second.id,
      third.id,
    ]);
  });

  it("hides foreign source and target Projects from colleagues and other organizations", async () => {
    const actor = owner();
    const first = await create(actor, "First");
    const second = await create(actor, "Second");
    const peer = owner({ orgId: actor.orgId });
    const foreign = await create(peer, "Foreign");
    const elsewhere = owner({ userId: actor.userId });
    const external = await create(elsewhere, "Elsewhere");
    expect((await reorder(peer, first.id, foreign.id, "before")).status).toBe(
      404,
    );
    expect((await reorder(actor, first.id, foreign.id, "before")).status).toBe(
      404,
    );
    expect(
      (await reorder(elsewhere, first.id, external.id, "before")).status,
    ).toBe(404);
    expect((await reorder(actor, first.id, external.id, "before")).status).toBe(
      404,
    );
    await expect(listedIds(actor)).resolves.toStrictEqual([
      first.id,
      second.id,
    ]);
    await expect(listedIds(peer)).resolves.toStrictEqual([foreign.id]);
    await expect(listedIds(elsewhere)).resolves.toStrictEqual([external.id]);
  });

  it("arbitrates competing owner writes without duplicate tail ranks or partial event publication", async () => {
    const actor = owner();
    const initial = await create(actor, "Initial");
    const ids = [operation(), operation()];
    const responses = await Promise.all(
      ids.map((id) => {
        return client().create({
          headers: headers(actor),
          body: { id, eventId: id, name: id },
        });
      }),
    );
    expect(
      responses.map((response) => {
        return response.status;
      }),
    ).toContain(201);
    for (const [index, response] of responses.entries()) {
      expect([201, 409]).toContain(response.status);
      if (response.status === 409) {
        const id = ids[index]!;
        await accept(
          client().create({
            headers: headers(actor),
            body: { id, eventId: id, name: id },
          }),
          [201],
        );
      }
    }
    const listed = await accept(
      client().list({ headers: headers(actor) }),
      [200],
    );
    expect(listed.body.projects[0]?.id).toBe(initial.id);
    expect(
      new Set(
        listed.body.projects.map((project) => {
          return project.sortOrder;
        }),
      ).size,
    ).toBe(3);
    const eventId = operation();
    const duplicate = await Promise.all([
      reorder(actor, initial.id, ids[0]!, "after", eventId),
      reorder(actor, initial.id, ids[0]!, "after", eventId),
    ]);
    expect(
      duplicate.map((response) => {
        return response.status;
      }),
    ).toStrictEqual([204, 204]);
    const events = await accept(
      client().events({ headers: headers(actor), query: { sinceSeqId: 0 } }),
      [200],
    );
    expect(
      events.body.events.map((event) => {
        return event.seqId;
      }),
    ).toStrictEqual([1, 2, 3, 4]);
    expect(events.body.events.at(-1)).toMatchObject({
      id: eventId,
      projectId: initial.id,
      kind: "sort_updated",
    });
  });
});

describe("private cross-Agent Projects", () => {
  it("preserves structured Project references through ordinary Agent and Thread drafts", async () => {
    const actor = owner();
    const project = await create(actor);
    const a = await agent(actor);
    const t = await thread(actor, a.agentId, project.id);
    const draft = {
      draftUserMessage: {
        version: 1 as const,
        parts: [
          {
            type: "project" as const,
            projectId: project.id,
            nameSnapshot: project.name,
          },
          {
            type: "feedback" as const,
            quote: "Review this",
            note: [
              {
                type: "project" as const,
                projectId: project.id,
                nameSnapshot: project.name,
              },
            ],
          },
        ],
      },
      draftAttachments: null,
    };
    const threadApi = setupApp({ context, routes: chatThreadRoutes });
    await accept(
      threadApi(chatThreadByIdContract).patch({
        headers: headers(actor),
        params: { id: t.id },
        body: draft,
      }),
      [204],
    );
    expect(
      (
        await accept(
          threadApi(chatThreadDraftContract).get({
            headers: headers(actor),
            params: { id: t.id },
          }),
          [200],
        )
      ).body,
    ).toStrictEqual(draft);
    const agentApi = setupApp({ context, routes: agentDraftRoutes })(
      agentDraftContract,
    );
    await accept(
      agentApi.patch({
        headers: headers(actor),
        params: { id: a.agentId },
        body: draft,
      }),
      [204],
    );
    expect(
      (
        await accept(
          agentApi.get({
            headers: headers(actor),
            params: { id: a.agentId },
          }),
          [200],
        )
      ).body,
    ).toStrictEqual(draft);
  });

  it("isolates each member’s Projects across colleagues and organizations", async () => {
    const actor = owner();
    const p = await create(actor);
    const peer = bdd.user({ orgId: actor.orgId });
    if (!peer.orgId) {
      throw new Error("Missing org");
    }
    expect(
      (await client().get({ headers: headers(peer), params: { id: p.id } }))
        .status,
    ).toBe(404);
    expect(
      (await accept(client().list({ headers: headers(peer) }), [200])).body
        .projects,
    ).toStrictEqual([]);
    const elsewhere = owner({ userId: actor.userId });
    expect(
      (
        await client().get({
          headers: headers(elsewhere),
          params: { id: p.id },
        })
      ).status,
    ).toBe(404);
  });
  it("keeps Agent identity and activity while moving across Projects and ignores a replayed old move", async () => {
    const actor = owner();
    const a = await agent(actor);
    const b = await bdd.createAgent(actor, {
      displayName: "Other Agent",
      visibility: "private",
    });
    const first = await thread(actor, a.agentId);
    const second = await thread(actor, b.agentId);
    const p = await create(actor, "Launch", first.id);
    const q = await create(actor, "Research");
    expect((await move(actor, second.id, p.id)).status).toBe(200);
    await accept(reorder(actor, q.id, p.id, "before"), [204]);
    const members = (
      await accept(
        client().threads({
          headers: headers(actor),
          params: { id: p.id },
          query: { limit: 100, archived: "all" },
        }),
        [200],
      )
    ).body.threads;
    expect(
      members
        .map((t) => {
          return t.agentId;
        })
        .sort(),
    ).toStrictEqual([a.agentId, b.agentId].sort());
    expect(
      members.find((t) => {
        return t.id === first.id;
      })?.sortAt,
    ).toBe(first.createdAt);
    const old = operation();
    expect((await move(actor, first.id, p.id, old)).status).toBe(200);
    expect((await move(actor, first.id, q.id)).status).toBe(200);
    expect((await move(actor, first.id, p.id, old)).status).toBe(200);
    expect(
      (
        await accept(
          client().threads({
            headers: headers(actor),
            params: { id: q.id },
            query: { limit: 100, archived: "all" },
          }),
          [200],
        )
      ).body.threads.map((t) => {
        return t.id;
      }),
    ).toStrictEqual([first.id]);
    expect((await move(actor, second.id, q.id, old)).status).toBe(409);
    const expired = createProjectOperationId(
      now() - 8 * 86_400_000,
      randomUUID(),
    );
    expect((await move(actor, first.id, p.id, expired)).status).toBe(409);
  });
  it("deletes the Project atomically, clears each membership and never resurrects an old creation", async () => {
    const actor = owner();
    const a = await agent(actor);
    const first = await thread(actor, a.agentId);
    const p = await create(actor, "Launch", first.id);
    const second = await thread(actor, a.agentId, p.id);
    expect(second.projectId).toBe(p.id);
    expect(
      (
        await client().delete({
          headers: headers(actor),
          params: { id: p.id },
          body: { eventId: operation() },
        })
      ).status,
    ).toBe(204);
    expect(
      (await client().get({ headers: headers(actor), params: { id: p.id } }))
        .status,
    ).toBe(404);
    const events = (
      await accept(
        threads().events({ headers: headers(actor), query: {} }),
        [200],
      )
    ).body.events;
    for (const id of [first.id, second.id]) {
      expect(
        events
          .filter((e) => {
            return e.chatThreadId === id && e.kind === "project_updated";
          })
          .at(-1)?.projectId,
      ).toBeNull();
      expect(
        events.some((e) => {
          return e.chatThreadId === id && e.kind === "deleted";
        }),
      ).toBeFalsy();
    }
    expect(
      (
        await client().create({
          headers: headers(actor),
          body: {
            id: p.id,
            eventId: p.id,
            name: "Launch",
            fromThreadId: first.id,
          },
        })
      ).status,
    ).toBe(404);
  });
  it("rejects a missing or foreign source without creating a Project or publishing events", async () => {
    const actor = owner();
    const id = operation();
    expect(
      (
        await client().create({
          headers: headers(actor),
          body: {
            id,
            eventId: id,
            name: "Missing",
            fromThreadId: randomUUID(),
          },
        })
      ).status,
    ).toBe(404);
    expect(
      (await accept(client().list({ headers: headers(actor) }), [200])).body
        .projects,
    ).toStrictEqual([]);
    expect(
      (
        await accept(
          client().events({
            headers: headers(actor),
            query: { sinceSeqId: 0 },
          }),
          [200],
        )
      ).body.events,
    ).toStrictEqual([]);
  });
});

test("serializes concurrent moves, duplicate creates and deletion against new memberships", async () => {
  const actor = owner();
  const a = await agent(actor);
  const first = await thread(actor, a.agentId);
  const p = await create(actor, "Launch");
  const q = await create(actor, "Review");
  const same = operation();
  const [one, two] = await Promise.all([
    client().create({
      headers: headers(actor),
      body: {
        id: same,
        eventId: same,
        name: "Concurrent",
        fromThreadId: first.id,
      },
    }),
    client().create({
      headers: headers(actor),
      body: {
        id: same,
        eventId: same,
        name: "Concurrent",
        fromThreadId: first.id,
      },
    }),
  ]);
  expect([one.status, two.status]).toStrictEqual([201, 201]);
  const moves = await Promise.all([
    move(actor, first.id, p.id),
    move(actor, first.id, q.id),
  ]);
  expect(
    moves.map((r) => {
      return r.status;
    }),
  ).toStrictEqual([200, 200]);
  const events = (
    await accept(
      threads().events({ headers: headers(actor), query: {} }),
      [200],
    )
  ).body.events.filter((e) => {
    return e.chatThreadId === first.id && e.kind === "project_updated";
  });
  const last = events.at(-1);
  if (!last?.projectId) {
    throw new Error("Missing committed membership");
  }
  const members = await accept(
    client().threads({
      headers: headers(actor),
      params: { id: last.projectId },
      query: { limit: 100, archived: "all" },
    }),
    [200],
  );
  expect(
    members.body.threads.map((t) => {
      return t.id;
    }),
  ).toStrictEqual([first.id]);
  const [deletion, joining] = await Promise.all([
    client().delete({
      headers: headers(actor),
      params: { id: p.id },
      body: { eventId: operation() },
    }),
    move(actor, first.id, p.id),
  ]);
  expect([204, 409]).toContain(deletion.status);
  expect([200, 404]).toContain(joining.status);
  if (deletion.status === 204) {
    expect(
      (await client().get({ headers: headers(actor), params: { id: p.id } }))
        .status,
    ).toBe(404);
    const all = (
      await accept(
        threads().events({ headers: headers(actor), query: {} }),
        [200],
      )
    ).body.events;
    const tail = all
      .filter((e) => {
        return e.chatThreadId === first.id && e.kind === "project_updated";
      })
      .at(-1);
    expect(tail?.projectId).not.toBe(p.id);
  }
});

test("publishes immutable owner-scoped metadata snapshots with an exact event tail fence", async () => {
  const { installWorkflowVolumeS3Fixture } =
    await import("./helpers/workflow-volume-s3");
  const { gunzipSync } = await import("node:zlib");
  const { projectSnapshotArchiveSchema } =
    await import("@okouai/api-contracts/validators/projects");
  const actor = owner();
  const storage = installWorkflowVolumeS3Fixture(context);
  const empty = await accept(
    client().snapshot({ headers: headers(actor) }),
    [200],
  );
  expect(empty.body).toMatchObject({ latestEventId: null, latestSeqId: 0 });
  const emptyKeys = new Set(storage.objects.keys());
  const p = await create(actor, "Original");
  const snapshot = await accept(
    client().snapshot({ headers: headers(actor) }),
    [200],
  );
  if (!("url" in snapshot.body)) {
    throw new Error("Project snapshot URL missing");
  }
  const first = [...storage.objects.entries()].find(([key]) => {
    return key.startsWith("project-snapshots/v1/") && !emptyKeys.has(key);
  });
  if (!first) {
    throw new Error("Project metadata was not published");
  }
  const archived = projectSnapshotArchiveSchema.parse(
    JSON.parse(gunzipSync(first[1]).toString("utf8")),
  );
  expect(archived.projects).toStrictEqual([p]);
  expect(archived).toMatchObject({ latestEventId: p.id, latestSeqId: 1 });
  expect(snapshot.body).toMatchObject({
    latestEventId: archived.latestEventId,
    latestSeqId: archived.latestSeqId,
  });
  const q = await create(actor, "Second");
  await accept(reorder(actor, q.id, p.id, "before"), [204]);
  const reordered = await accept(
    client().get({ headers: headers(actor), params: { id: q.id } }),
    [200],
  );
  await accept(
    client().update({
      headers: headers(actor),
      params: { id: p.id },
      body: { eventId: operation(), name: "Renamed" },
    }),
    [200],
  );
  const tail = await accept(
    client().events({
      headers: headers(actor),
      query: { sinceSeqId: archived.latestSeqId },
    }),
    [200],
  );
  expect(tail.body.events).toMatchObject([
    { kind: "created", projectId: q.id, sortOrder: q.sortOrder, seqId: 2 },
    {
      kind: "sort_updated",
      projectId: q.id,
      sortOrder: reordered.body.sortOrder,
      seqId: 3,
    },
    {
      kind: "renamed",
      projectId: p.id,
      name: "Renamed",
      sortOrder: p.sortOrder,
      seqId: 4,
    },
  ]);
  const renamed = await accept(
    client().snapshot({ headers: headers(actor) }),
    [200],
  );
  expect(renamed.body).toMatchObject({
    latestEventId: tail.body.events.at(-1)?.id,
    latestSeqId: 4,
  });
  await expect(listedIds(actor)).resolves.toStrictEqual([q.id, p.id]);
  expect(storage.objects.get(first[0])).toStrictEqual(first[1]);
});
