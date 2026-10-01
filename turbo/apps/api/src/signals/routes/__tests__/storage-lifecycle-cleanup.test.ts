import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  agentsByIdContract,
  agentsMainContract,
} from "@okouai/api-contracts/contracts/agents";
import { testStorageObjectCleanupContract } from "@okouai/api-contracts/contracts/test-storage-object-cleanup";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
  workflowsDetailContract,
} from "@okouai/api-contracts/contracts/workflows";
import {
  getCustomSkillStorageName,
  getInstructionsStorageName,
} from "@okouai/core/storage-names";
import { HttpResponse, http } from "msw";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import {
  replaceUnpublishedStorageGenerationFixture,
  retainLegacySharedStoragePrefixFixture,
} from "../../../test-fixtures/storage-object-cleanup";
import { testStorageObjectCleanupRoutes } from "../test-storage-object-cleanup";
import { agentsRoutes } from "../agents";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";
import { mockGmailConnectorOAuth } from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext({ connectorCatalog: true });
const bdd = createBddApi(context);
const mocks = createRouteMocks(context);
const storages = createStoragesBddApi(context);
const runs = createRunsApi(context);
const workflowApi = createWorkflowsBddApi(context);

type Lifecycle = "agent" | "workflow";
type Failure = "list" | "partial-delete" | "lost-delete-receipt";

function headers(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

function prefixOf(key: string) {
  return key.split("/").slice(0, 2).join("/");
}

function objectStore() {
  const objects = new Map<string, Buffer>();
  let failure: Failure | undefined;
  let beforeList: (() => Promise<void>) | undefined;
  let beforePut: ((key: string) => void | Promise<void>) | undefined;
  function readObject(key: string | undefined) {
    const body = key ? objects.get(key) : undefined;
    if (!body) {
      throw Object.assign(new Error("Missing object"), {
        name: "NotFound",
        $metadata: { httpStatusCode: 404 },
      });
    }
    return { ContentLength: body.length, Body: Readable.from([body]) };
  }
  context.mocks.s3.send.mockImplementation(async (command: unknown) => {
    if (command instanceof PutObjectCommand) {
      const { Key: key, Body: body } = command.input;
      if (!key || !(typeof body === "string" || body instanceof Uint8Array)) {
        throw new Error("Expected a volume object body and key");
      }
      await beforePut?.(key);
      objects.set(key, Buffer.from(body));
      return {};
    }
    if (
      command instanceof HeadObjectCommand ||
      command instanceof GetObjectCommand
    ) {
      return readObject(command.input.Key);
    }
    if (command instanceof ListObjectsV2Command) {
      await beforeList?.();
      if (failure === "list") {
        failure = undefined;
        throw new Error("R2 listing failed");
      }
      const keys = [...objects.keys()]
        .filter((key) => {
          return key.startsWith(command.input.Prefix ?? "");
        })
        .sort();
      const page = keys.slice(0, command.input.MaxKeys ?? 1000);
      return {
        Contents: page.map((Key) => {
          return {
            Key,
            Size: objects.get(Key)?.length,
            LastModified: new Date(0),
          };
        }),
        IsTruncated: page.length < keys.length,
      };
    }
    if (command instanceof DeleteObjectsCommand) {
      const keys =
        command.input.Delete?.Objects?.flatMap((object) => {
          return object.Key ? [object.Key] : [];
        }) ?? [];
      if (failure === "partial-delete") {
        failure = undefined;
        const [removed, remaining] = keys;
        if (removed) {
          objects.delete(removed);
        }
        return { Errors: [{ Key: remaining, Code: "InternalError" }] };
      }
      for (const key of keys) {
        objects.delete(key);
      }
      if (failure === "lost-delete-receipt") {
        failure = undefined;
        throw new Error("Delete response lost after removing objects");
      }
      return {};
    }
    return {};
  });
  return {
    objects,
    failNext(value: Failure) {
      failure = value;
    },
    beforeListing(callback: () => Promise<void>) {
      beforeList = callback;
    },
    beforeUpload(callback: (key: string) => void | Promise<void>) {
      beforePut = callback;
    },
  };
}

async function createWorkflow(actor: ApiTestUser, agentId: string) {
  return (
    await accept(
      setupApp({ context, routes: workflowsRoutes })(
        workflowsCollectionContract,
      ).create({
        headers: headers(actor),
        body: {
          agentId,
          name: `cleanup-${randomUUID()}`,
          instruction: "Retained workflow instructions",
        },
      }),
      [201],
    )
  ).body.id;
}

async function retry(actor: ApiTestUser) {
  if (!actor.orgId) {
    throw new Error("Expected an organization-scoped cleanup owner");
  }
  return await accept(
    setupApp({ context, routes: testStorageObjectCleanupRoutes })(
      testStorageObjectCleanupContract,
    ).retry({
      body: { kind: "organization", orgId: actor.orgId },
    }),
    [200],
  );
}

async function deleteTarget(
  actor: ApiTestUser,
  kind: Lifecycle,
  id: string,
  signal = context.signal,
) {
  if (kind === "agent") {
    return await setupApp({
      context,
      routes: agentsRoutes,
      signal,
      rethrowErrors: true,
    })(agentsByIdContract).delete({
      headers: headers(actor),
      params: { id },
    });
  }
  return await setupApp({
    context,
    routes: workflowsRoutes,
    signal,
    rethrowErrors: true,
  })(workflowsDetailContract).delete({
    headers: headers(actor),
    params: { workflowId: id },
  });
}

async function assertAbsent(actor: ApiTestUser, kind: Lifecycle, id: string) {
  if (kind === "agent") {
    await bdd.requestReadAgent(actor, id, [404]);
  } else {
    await accept(
      setupApp({ context, routes: workflowsRoutes })(
        workflowsDetailContract,
      ).get({
        headers: headers(actor),
        params: { workflowId: id },
      }),
      [404],
    );
  }
  await expect(
    storages.listStorages(actor, "organization"),
  ).resolves.not.toContainEqual(
    expect.objectContaining({
      name:
        kind === "agent"
          ? getInstructionsStorageName(id)
          : getCustomSkillStorageName(id),
    }),
  );
}

function keysUnder(objects: Map<string, Buffer>, prefix: string) {
  return [...objects.keys()].filter((key) => {
    return key.startsWith(`${prefix}/`);
  });
}

describe("durable ordinary Storage lifecycle cleanup", () => {
  it.each([
    ["agent", "list"],
    ["workflow", "list"],
    ["agent", "partial-delete"],
    ["workflow", "partial-delete"],
    ["agent", "lost-delete-receipt"],
    ["workflow", "lost-delete-receipt"],
  ] as const)(
    "recovers %s cleanup after %s with no source row left",
    async (kind, failure) => {
      const actor = bdd.user();
      const s3 = objectStore();
      const agent = await bdd.createAgent(actor, {});
      const before = new Set(s3.objects.keys());
      const id =
        kind === "agent"
          ? agent.agentId
          : await createWorkflow(actor, agent.agentId);
      const targetKeys = [...s3.objects.keys()].filter((key) => {
        return kind === "agent" || !before.has(key);
      });
      const firstKey = targetKeys[0];
      if (!firstKey) {
        throw new Error("Expected published Storage objects");
      }
      const prefix = prefixOf(firstKey);
      const peer = bdd.user();
      const retained = await bdd.createAgent(peer, {});
      const retainedKeys = [...s3.objects.keys()].filter((key) => {
        return key.startsWith(`${peer.orgId}/`);
      });
      const siblingKey = `${prefix}-sibling/keep.txt`;
      s3.objects.set(siblingKey, Buffer.from("sibling"));
      s3.beforeListing(async () => {
        await assertAbsent(actor, kind, id);
      });
      s3.failNext(failure);
      await accept(deleteTarget(actor, kind, id), [204]);
      await assertAbsent(actor, kind, id);
      expect(keysUnder(s3.objects, prefix)).toHaveLength(
        failure === "list" ? 2 : failure === "partial-delete" ? 1 : 0,
      );
      expect((await retry(actor)).body.processed).toBe(1);
      expect(keysUnder(s3.objects, prefix)).toHaveLength(0);
      expect(s3.objects.has(siblingKey)).toBeTruthy();
      expect(
        retainedKeys.every((key) => {
          return s3.objects.has(key);
        }),
      ).toBeTruthy();
      await expect(
        bdd.readAgent(peer, retained.agentId),
      ).resolves.toMatchObject({ agentId: retained.agentId });
      expect((await retry(actor)).body.processed).toBe(0);
    },
  );

  it("retains a same-organization peer's live legacy prefix reference", async () => {
    const actor = bdd.user();
    const s3 = objectStore();
    const target = await bdd.createAgent(actor, {});
    const targetKey = [...s3.objects.keys()][0];
    const existingKeys = new Set(s3.objects.keys());
    const peer = await bdd.createAgent(actor, {});
    const peerKey = [...s3.objects.keys()].find((key) => {
      return !existingKeys.has(key);
    });
    if (!actor.orgId || !targetKey || !peerKey) {
      throw new Error("Expected uniquely owned Storage uploads");
    }
    // Historical shared prefixes cannot be produced by the current API. The
    // fixture owns only these two API-created generations; all verification
    // remains on user-visible APIs and the external object-store boundary.
    await retainLegacySharedStoragePrefixFixture(
      {
        orgId: actor.orgId,
        targetObjectKey: targetKey,
        retainedObjectKey: peerKey,
      },
      context.signal,
    );
    const before = new Set(s3.objects.keys());
    await accept(deleteTarget(actor, "agent", target.agentId), [204]);
    await assertAbsent(actor, "agent", target.agentId);
    expect((await retry(actor)).body.processed).toBe(1);
    expect(new Set(s3.objects.keys())).toStrictEqual(before);
    await expect(bdd.readAgent(actor, peer.agentId)).resolves.toMatchObject({
      agentId: peer.agentId,
    });
  });

  it("inventories cascaded Workflow volumes and yields a bounded page", async () => {
    const actor = bdd.user();
    const s3 = objectStore();
    const agent = await bdd.createAgent(actor, {});
    const workflowId = await createWorkflow(actor, agent.agentId);
    const prefixes = new Set([...s3.objects.keys()].map(prefixOf));
    const prefix = prefixes.values().next().value;
    if (!prefix) {
      throw new Error("Expected an owned Storage prefix");
    }
    for (let index = 0; index < 1001; index++) {
      s3.objects.set(`${prefix}/extra-${index}.txt`, Buffer.from("extra"));
    }
    await accept(deleteTarget(actor, "agent", agent.agentId), [204]);
    await assertAbsent(actor, "agent", agent.agentId);
    await assertAbsent(actor, "workflow", workflowId);
    expect(s3.objects.size).toBe(3);
    expect((await retry(actor)).body.processed).toBe(1);
    expect(s3.objects.size).toBe(0);
  });

  it.each(["agent", "workflow"] as const)(
    "retains %s inventory when event-watch cancellation skips the post-commit purge",
    async (kind) => {
      const actor = bdd.user();
      await runs.grantProEntitlement(actor, { tier: "team" });
      const s3 = objectStore();
      const agent = await bdd.createAgent(actor, {});
      const workflowId = await createWorkflow(actor, agent.agentId);
      mockGmailConnectorOAuth({
        email: `${actor.userId}@example.test`,
        subject: actor.userId,
      });
      await workflowApi.connectConnector(actor, "gmail");
      mockOptionalEnv(
        "GMAIL_PUBSUB_TOPIC_NAME",
        "projects/test/topics/gmail-events",
      );
      server.use(
        http.post(
          "https://gmail.googleapis.com/gmail/v1/users/me/watch",
          () => {
            return HttpResponse.json({
              historyId: "1",
              expiration: "4102444800000",
            });
          },
        ),
      );
      await accept(
        setupApp({ context, routes: workflowAutomationsRoutes })(
          workflowAutomationsContract,
        ).create({
          headers: headers(actor),
          params: { workflowId },
          body: {
            kind: "event",
            eventType: "gmail-new-message",
            eventConfig: { provider: "gmail", event: "new_message" },
          },
        }),
        [201],
      );
      const controller = new AbortController();
      server.use(
        http.post("https://gmail.googleapis.com/gmail/v1/users/me/stop", () => {
          controller.abort();
          return new HttpResponse(null, { status: 204 });
        }),
      );
      const before = [...s3.objects.keys()];
      const id = kind === "agent" ? agent.agentId : workflowId;
      await expect(
        deleteTarget(
          actor,
          kind,
          id,
          AbortSignal.any([context.signal, controller.signal]),
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
      await assertAbsent(actor, kind, id);
      expect([...s3.objects.keys()]).toStrictEqual(before);
      expect((await retry(actor)).body.processed).toBe(
        kind === "agent" ? 2 : 1,
      );
      if (kind === "agent") {
        expect(s3.objects.size).toBe(0);
      } else {
        expect(s3.objects.size).toBe(2);
        await expect(
          bdd.readAgent(actor, agent.agentId),
        ).resolves.toMatchObject({ agentId: agent.agentId });
      }
    },
  );

  it.each(["agent", "workflow"] as const)(
    "preserves the original %s creation error and resumes failed compensation",
    async (kind) => {
      const actor = bdd.user();
      const s3 = objectStore();
      const existingAgent = await bdd.createAgent(actor, {});
      const retained = new Set(s3.objects.keys());
      const originalError = new Error("Original archive upload failure");
      s3.beforeUpload((key) => {
        if (key.endsWith("/archive.tar.gz")) {
          throw originalError;
        }
      });
      s3.failNext("list");
      const request =
        kind === "agent"
          ? setupApp({ context, routes: agentsRoutes, rethrowErrors: true })(
              agentsMainContract,
            ).create({ headers: headers(actor), body: {} })
          : setupApp({ context, routes: workflowsRoutes, rethrowErrors: true })(
              workflowsCollectionContract,
            ).create({
              headers: headers(actor),
              body: {
                agentId: existingAgent.agentId,
                name: `failed-${randomUUID()}`,
              },
            });
      await expect(request).rejects.toBe(originalError);
      expect(s3.objects.size).toBe(retained.size + 1);
      await expect(
        storages.listStorages(actor, "organization"),
      ).resolves.toHaveLength(1);
      expect((await retry(actor)).body.processed).toBe(1);
      expect(new Set(s3.objects.keys())).toStrictEqual(retained);
      await expect(
        bdd.readAgent(actor, existingAgent.agentId),
      ).resolves.toMatchObject({ agentId: existingAgent.agentId });
    },
  );

  it.each(["agent", "workflow"] as const)(
    "keeps %s compensation durable after the creation request is cancelled",
    async (kind) => {
      const actor = bdd.user();
      const s3 = objectStore();
      const existingAgent = await bdd.createAgent(actor, {});
      const retained = new Set(s3.objects.keys());
      const controller = new AbortController();
      const originalError = new DOMException(
        "Creation cancelled",
        "AbortError",
      );
      s3.beforeUpload((key) => {
        if (key.endsWith("/archive.tar.gz")) {
          controller.abort(originalError);
        }
      });
      s3.failNext("list");
      const signal = AbortSignal.any([context.signal, controller.signal]);
      const request =
        kind === "agent"
          ? setupApp({
              context,
              routes: agentsRoutes,
              signal,
              rethrowErrors: true,
            })(agentsMainContract).create({ headers: headers(actor), body: {} })
          : setupApp({
              context,
              routes: workflowsRoutes,
              signal,
              rethrowErrors: true,
            })(workflowsCollectionContract).create({
              headers: headers(actor),
              body: {
                agentId: existingAgent.agentId,
                name: `cancelled-${randomUUID()}`,
              },
            });
      await expect(request).rejects.toBe(originalError);
      expect(s3.objects.size).toBe(retained.size + 2);
      await expect(
        storages.listStorages(actor, "organization"),
      ).resolves.toHaveLength(1);
      expect((await retry(actor)).body.processed).toBe(1);
      expect(new Set(s3.objects.keys())).toStrictEqual(retained);
    },
  );

  it.each(["agent", "workflow"] as const)(
    "does not compensate a replacement %s Storage generation",
    async (kind) => {
      const actor = bdd.user();
      const s3 = objectStore();
      const existingAgent = await bdd.createAgent(actor, {});
      const originalError = new Error(
        "Original upload failed after infrastructure replacement",
      );
      let replacement:
        | { readonly storageName: string; readonly s3Prefix: string }
        | undefined;
      s3.beforeUpload(async (key) => {
        if (key.endsWith("/archive.tar.gz")) {
          if (!actor.orgId) {
            throw new Error("Expected an owned organization");
          }
          // No production API can replace an unpublished canonical generation.
          // This narrow infrastructure fixture owns only the row identified by
          // this test's externally observed upload key, never shared state.
          replacement = await replaceUnpublishedStorageGenerationFixture(
            { orgId: actor.orgId, objectKey: key },
            context.signal,
          );
          s3.objects.set(
            `${replacement.s3Prefix}/keep.txt`,
            Buffer.from("replacement generation"),
          );
          throw originalError;
        }
      });
      const request =
        kind === "agent"
          ? setupApp({ context, routes: agentsRoutes, rethrowErrors: true })(
              agentsMainContract,
            ).create({ headers: headers(actor), body: {} })
          : setupApp({ context, routes: workflowsRoutes, rethrowErrors: true })(
              workflowsCollectionContract,
            ).create({
              headers: headers(actor),
              body: {
                agentId: existingAgent.agentId,
                name: `replacement-${randomUUID()}`,
              },
            });
      await expect(request).rejects.toBe(originalError);
      if (!replacement) {
        throw new Error("Expected the replacement generation");
      }
      await expect(
        storages.listStorages(actor, "organization"),
      ).resolves.toContainEqual(
        expect.objectContaining({ name: replacement.storageName }),
      );
      expect((await retry(actor)).body.processed).toBe(0);
      expect(s3.objects.has(`${replacement.s3Prefix}/keep.txt`)).toBeTruthy();
    },
  );
});
