import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createProjectOperationId } from "@okouai/core/project-operation-id";
import { testContext, accept } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { projectRoutes } from "../projects";
import { chatThreadRoutes } from "../chat-threads";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
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
async function owner() {
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Project fixture requires an organization");
  }
  await updateFeatureSwitchesForUser(
    context,
    { ...actor, orgId: actor.orgId },
    { [FeatureSwitchKey.Projects]: true },
  );
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

describe("private cross-Agent Projects", () => {
  it("is disabled by default and isolates colleagues and organizations", async () => {
    const disabled = bdd.user();
    expect((await client().list({ headers: headers(disabled) })).status).toBe(
      404,
    );
    const actor = await owner();
    const p = await create(actor);
    const peer = bdd.user({ orgId: actor.orgId });
    if (!peer.orgId) {
      throw new Error("Missing org");
    }
    await updateFeatureSwitchesForUser(
      context,
      { ...peer, orgId: peer.orgId },
      { [FeatureSwitchKey.Projects]: true },
    );
    expect(
      (await client().get({ headers: headers(peer), params: { id: p.id } }))
        .status,
    ).toBe(404);
    expect(
      (await accept(client().list({ headers: headers(peer) }), [200])).body
        .projects,
    ).toEqual([]);
    const elsewhere = await owner();
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
    const actor = await owner();
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
    ).toEqual([a.agentId, b.agentId].sort());
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
    ).toEqual([first.id]);
    expect((await move(actor, second.id, q.id, old)).status).toBe(409);
    const expired = createProjectOperationId(
      now() - 8 * 86400000,
      randomUUID(),
    );
    expect((await move(actor, first.id, p.id, expired)).status).toBe(409);
  });
  it("deletes the Project atomically, clears each membership and never resurrects an old creation", async () => {
    const actor = await owner();
    const a = await agent(actor);
    const first = await thread(actor, a.agentId);
    const p = await create(actor, "Launch", first.id);
    const second = await thread(actor, a.agentId, p.id);
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
            return e.chatThreadId === id && e.projectMembershipUpdated;
          })
          .at(-1)?.projectId,
      ).toBeNull();
      expect(
        events.some((e) => {
          return e.chatThreadId === id && e.kind === "deleted";
        }),
      ).toBe(false);
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
    const actor = await owner();
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
    ).toEqual([]);
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
    ).toEqual([]);
  });
});
