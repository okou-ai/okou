import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { chatFoldersContract } from "@okouai/api-contracts/contracts/chat-folders";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { chatFolderRoutes } from "../chat-folders";
import { featureSwitchesRoutes } from "../feature-switches";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const STAFF_ORG = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
function api(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  const client = setupApp({
    context,
    routes: [...chatFolderRoutes, ...featureSwitchesRoutes],
  });
  return {
    folders: client(chatFoldersContract),
    switches: client(featureSwitchesContract),
  };
}
async function fixture(orgId = STAFF_ORG) {
  const actor = bdd.user({ orgId });
  bdd.acceptAgentStorageWrites();
  await bdd.readOnboardingStatus(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Folder test",
    visibility: "public",
  });
  const thread = await chat.createThread(actor, {
    agentId: agent.agentId,
    title: "Keep this conversation",
    model: null,
  });
  return { actor, agentId: agent.agentId, threadId: thread.id };
}
async function create(actor: ApiTestUser, agentId: string, name: string) {
  return (
    await accept(
      api(actor).folders.create({
        headers,
        params: { agentId },
        body: { id: randomUUID(), name },
      }),
      [201],
    )
  ).body;
}
async function catalog(actor: ApiTestUser, agentId: string) {
  return (
    await accept(
      api(actor).folders.list({ headers, params: { agentId } }),
      [200],
    )
  ).body;
}
async function move(
  actor: ApiTestUser,
  threadId: string,
  folderId: string | null,
) {
  await accept(
    api(actor).folders.moveThread({
      headers,
      params: { id: threadId },
      body: { folderId },
    }),
    [204],
  );
}

test("staff can organize, rename and delete folders without changing thread state or its legacy feed", async () => {
  await setupApp({ context, routes: chatFolderRoutes, isolatePg: true });
  const { actor, agentId, threadId } = await fixture();
  await chat.pinThread(actor, threadId);
  await chat.requestSetThreadArchived(actor, threadId, true, [204]);
  await chat.requestSetThreadMuted(actor, threadId, true, [204]);
  const before = await chat.readThreadMetadata(actor, threadId);
  const eventsBefore = await chat.requestThreadEvents(actor, {}, [200]);
  const first = await create(actor, agentId, "  Product  ");
  const second = await create(actor, agentId, "Customers");
  expect(first.name).toBe("Product");
  await move(actor, threadId, first.id);
  await accept(
    api(actor).folders.rename({
      headers,
      params: { id: first.id },
      body: { name: "Product launch" },
    }),
    [204],
  );
  await accept(
    api(actor).folders.reorder({
      headers,
      params: { id: second.id },
      body: { beforeId: null, afterId: first.id },
    }),
    [204],
  );
  await expect(catalog(actor, agentId)).resolves.toMatchObject({
    folders: [{ id: second.id }, { id: first.id, name: "Product launch" }],
    memberships: [{ chatThreadId: threadId, folderId: first.id }],
  });
  await move(actor, threadId, second.id);
  await move(actor, threadId, null);
  expect((await catalog(actor, agentId)).memberships).toStrictEqual([]);
  await move(actor, threadId, first.id);
  await accept(
    api(actor).folders.delete({ headers, params: { id: first.id } }),
    [204],
  );
  await expect(catalog(actor, agentId)).resolves.toMatchObject({
    folders: [{ id: second.id }],
    memberships: [],
  });
  await expect(chat.readThreadMetadata(actor, threadId)).resolves.toStrictEqual(
    before,
  );
  expect((await chat.requestThreadEvents(actor, {}, [200])).body).toStrictEqual(
    eventsBefore.body,
  );
});

test("case-insensitive names are unique per owner and stable creation IDs recover an uncertain response", async () => {
  await setupApp({ context, routes: chatFolderRoutes, isolatePg: true });
  const { actor, agentId } = await fixture();
  const id = randomUUID();
  const client = api(actor).folders;
  const request = {
    headers,
    params: { agentId },
    body: { id, name: "Launch" },
  };
  const first = await accept(client.create(request), [201]);
  const repeated = await accept(client.create(request), [201]);
  expect(repeated.body).toStrictEqual(first.body);
  await accept(
    client.create({ ...request, body: { id: randomUUID(), name: " launch " } }),
    [409],
  );
  const second = await create(actor, agentId, "Another");
  await accept(
    api(actor).folders.rename({
      headers,
      params: { id: second.id },
      body: { name: "LAUNCH" },
    }),
    [409],
  );
  expect(
    (await catalog(actor, agentId)).folders.map((folder) => {
      return folder.name;
    }),
  ).toStrictEqual(["Launch", "Another"]);
});

test("folders are personal and membership cannot cross users, organizations or Agents", async () => {
  await setupApp({ context, routes: chatFolderRoutes, isolatePg: true });
  const { actor, agentId, threadId } = await fixture();
  const own = await create(actor, agentId, "Private organization");
  const other = bdd.user({ orgId: STAFF_ORG });
  await bdd.readOnboardingStatus(other);
  await expect(catalog(other, agentId)).resolves.toStrictEqual({
    folders: [],
    memberships: [],
  });
  const otherFolder = await create(other, agentId, "Private organization");
  await accept(
    api(other).folders.rename({
      headers,
      params: { id: own.id },
      body: { name: "Stolen" },
    }),
    [404],
  );
  await accept(
    api(other).folders.moveThread({
      headers,
      params: { id: threadId },
      body: { folderId: otherFolder.id },
    }),
    [404],
  );
  await accept(
    api(actor).folders.moveThread({
      headers,
      params: { id: threadId },
      body: { folderId: otherFolder.id },
    }),
    [404],
  );
  const anotherAgent = await bdd.createAgent(actor, {
    displayName: "Another Agent",
  });
  const anotherFolder = await create(
    actor,
    anotherAgent.agentId,
    "Same owner, different Agent",
  );
  await accept(
    api(actor).folders.moveThread({
      headers,
      params: { id: threadId },
      body: { folderId: anotherFolder.id },
    }),
    [404],
  );
  const outsideOrg = { ...actor, orgId: `org_${randomUUID()}` };
  await bdd.readOnboardingStatus(outsideOrg);
  await accept(
    api(outsideOrg).folders.list({ headers, params: { agentId } }),
    [403],
  );
  await move(actor, threadId, own.id);
  expect((await catalog(actor, agentId)).memberships).toStrictEqual([
    { chatThreadId: threadId, folderId: own.id },
  ]);
});

test("non-staff overrides cannot opt in, and staff opt-out/reset preserves existing data", async () => {
  await setupApp({ context, routes: chatFolderRoutes, isolatePg: true });
  const { actor, agentId, threadId } = await fixture();
  const folder = await create(actor, agentId, "Keep me");
  await move(actor, threadId, folder.id);
  await accept(
    api(actor).switches.update({
      headers,
      body: { switches: { [FeatureSwitchKey.ChatThreadFolders]: false } },
    }),
    [200],
  );
  await accept(
    api(actor).folders.list({ headers, params: { agentId } }),
    [403],
  );
  await accept(
    api(actor).folders.moveThread({
      headers,
      params: { id: threadId },
      body: { folderId: null },
    }),
    [403],
  );
  await accept(api(actor).switches.delete({ headers }), [200]);
  expect((await catalog(actor, agentId)).memberships).toStrictEqual([
    { chatThreadId: threadId, folderId: folder.id },
  ]);
  const outsider = bdd.user();
  await bdd.readOnboardingStatus(outsider);
  const enabled = await accept(
    api(outsider).switches.update({
      headers,
      body: { switches: { [FeatureSwitchKey.ChatThreadFolders]: true } },
    }),
    [200],
  );
  expect(
    enabled.body.effectiveSwitches?.[FeatureSwitchKey.ChatThreadFolders],
  ).toBeFalsy();
  const client = api(outsider).folders;
  await accept(client.list({ headers, params: { agentId } }), [403]);
  await accept(
    client.create({
      headers,
      params: { agentId },
      body: { id: randomUUID(), name: "No access" },
    }),
    [403],
  );
  await accept(
    client.rename({
      headers,
      params: { id: folder.id },
      body: { name: "No access" },
    }),
    [403],
  );
  await accept(
    client.reorder({
      headers,
      params: { id: folder.id },
      body: { beforeId: null, afterId: null },
    }),
    [403],
  );
  await accept(client.delete({ headers, params: { id: folder.id } }), [403]);
  await accept(
    client.moveThread({
      headers,
      params: { id: threadId },
      body: { folderId: folder.id },
    }),
    [403],
  );
});

test("concurrent creation is deterministic and deleting a thread removes only its membership", async () => {
  await setupApp({ context, routes: chatFolderRoutes, isolatePg: true });
  const { actor, agentId, threadId } = await fixture();
  const [a] = await Promise.all([
    create(actor, agentId, "A"),
    create(actor, agentId, "B"),
  ]);
  await create(actor, agentId, "C");
  const moved = await create(actor, agentId, "Move into a concurrent gap");
  const initial = await catalog(actor, agentId);
  const before = initial.folders[0]!;
  const after = initial.folders[1]!;
  await accept(
    api(actor).folders.reorder({
      headers,
      params: { id: moved.id },
      body: { beforeId: before.id, afterId: after.id },
    }),
    [204],
  );
  const firstRead = await catalog(actor, agentId);
  expect(
    firstRead.folders.slice(0, 3).map((folder) => {
      return folder.id;
    }),
  ).toStrictEqual([before.id, moved.id, after.id]);
  const secondRead = await catalog(actor, agentId);
  expect(firstRead).toStrictEqual(secondRead);
  expect(firstRead.folders).toHaveLength(4);
  await move(actor, threadId, a.id);
  const beforeDelete = await catalog(actor, agentId);
  await chat.deleteThread(actor, threadId);
  await expect(catalog(actor, agentId)).resolves.toStrictEqual({
    ...beforeDelete,
    memberships: [],
  });
});
