import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  workflowsCollectionContract,
  workflowsDetailContract,
  type WorkflowCreateRequest,
} from "@okouai/api-contracts/contracts/workflows";
import { synthesizeWorkflowSkillMd } from "@okouai/core/skill-document";
import { onTestFinished, vi } from "vitest";

import { nowDate } from "../../../lib/time";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  assertWorkflowPreparationUnlockedFixture,
  holdWorkflowCreationThreadFixture,
  readWorkflowPreparationFixture,
  readWorkflowPublicationFixture,
} from "../../../test-fixtures/workflow-creation";
import { createDeferredPromise } from "../../utils";
import { workflowsRoutes } from "../workflows";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const mocks = createRouteMocks(context);
const chat = createChatFilesBddApi(context);
type OrgActor = ApiTestUser & { readonly orgId: string };

function deferred<T>() {
  const pending = createDeferredPromise<T>(context.signal);
  return {
    promise: pending.promise,
    resolve: (value: T) => {
      if (!pending.settled()) {
        pending.resolve(value);
      }
    },
  };
}

function headers(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

function client(signal = context.signal, rethrowErrors = false) {
  return setupApp({ context, routes: workflowsRoutes, signal, rethrowErrors })(
    workflowsCollectionContract,
  );
}

function detailClient() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowsDetailContract,
  );
}

async function setupCreation() {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  const agent = await bdd.createAgent(actor, {
    displayName: "Atomic publication agent",
    visibility: "public",
  });
  const thread = await chat.createThread(actor, {
    agentId: agent.agentId,
    title: "Creation thread",
  });
  const body: WorkflowCreateRequest = {
    agentId: agent.agentId,
    chatThreadId: thread.id,
    name: `atomic-${randomUUID().slice(0, 8)}`,
    description: "Creation publication regression",
    instruction: "Read the attached reference and produce the report.",
    files: [
      { path: "references/input.txt", content: "Original attachment: 世界" },
      { path: "script.sh", content: "echo report" },
    ],
  };
  if (!actor.orgId) {
    throw new Error("Expected an organization");
  }
  return { actor: { ...actor, orgId: actor.orgId }, agent, thread, body };
}

function installS3Fixture() {
  const objects = new Map<string, Buffer>();
  let beforeCommand: (command: unknown) => void | Promise<void> = () => {};
  context.mocks.s3.send.mockImplementation(async (command: unknown) => {
    await beforeCommand(command);
    if (command instanceof PutObjectCommand) {
      const { Key: key, Body: body } = command.input;
      if (!key || !(typeof body === "string" || body instanceof Uint8Array)) {
        throw new Error("Expected a volume object body and key");
      }
      objects.set(key, Buffer.from(body));
      return {};
    }
    if (
      command instanceof HeadObjectCommand ||
      command instanceof GetObjectCommand
    ) {
      const key = command.input.Key;
      const body = key ? objects.get(key) : undefined;
      if (!body) {
        throw Object.assign(new Error("Object not found"), {
          name: "NotFound",
          $metadata: { httpStatusCode: 404 },
        });
      }
      return { ContentLength: body.length, Body: Readable.from([body]) };
    }
    if (command instanceof ListObjectsV2Command) {
      const prefix = command.input.Prefix;
      if (!prefix) {
        throw new Error("Expected a scoped cleanup prefix");
      }
      return {
        Contents: [...objects]
          .filter(([key]) => {
            return key.startsWith(prefix);
          })
          .map(([Key, body]) => {
            return {
              Key,
              Size: body.length,
              LastModified: nowDate(),
            };
          }),
      };
    }
    if (command instanceof DeleteObjectsCommand) {
      for (const object of command.input.Delete?.Objects ?? []) {
        if (object.Key) {
          objects.delete(object.Key);
        }
      }
    }
    return {};
  });
  return {
    objects,
    intercept(callback: (command: unknown) => void | Promise<void>) {
      beforeCommand = callback;
    },
  };
}

async function assertAbsent(actor: OrgActor, workflowId: string, name: string) {
  const listed = await accept(
    client().list({ headers: headers(actor) }),
    [200],
  );
  expect(
    listed.body.map((workflow) => {
      return workflow.name;
    }),
  ).not.toContain(name);
  await accept(
    detailClient().run({
      headers: headers(actor),
      params: { workflowId },
    }),
    [404],
  );
  const state = await readWorkflowPublicationFixture(actor.orgId, workflowId);
  expect(state.workflow).toStrictEqual([]);
  expect(state.mappings).toStrictEqual([]);
  expect(state.versions).toStrictEqual([]);
  expect(
    state.storage.every((storage) => {
      return storage.headVersionId === null;
    }),
  ).toBeTruthy();
  return state;
}

async function assertReadable(
  actor: OrgActor,
  workflowId: string,
  body: WorkflowCreateRequest,
) {
  const detail = await accept(
    detailClient().get({ headers: headers(actor), params: { workflowId } }),
    [200],
  );
  expect(detail.body).toMatchObject({
    id: workflowId,
    instruction: body.instruction,
    fileContents: body.files,
  });
}

describe("Workflow creation publication", () => {
  it("keeps uploads outside publication locks and atomically publishes all rows after files are ready", async () => {
    const { actor, agent, thread, body } = await setupCreation();
    const s3 = installS3Fixture();
    const started = deferred<string>();
    const release = deferred<void>();
    s3.intercept(async (command) => {
      if (command instanceof PutObjectCommand && command.input.Key) {
        started.resolve(command.input.Key);
        await release.promise;
      }
    });
    const creating = client().create({ headers: headers(actor), body });
    onTestFinished(async () => {
      release.resolve();
      await creating;
    });
    const objectKey = await started.promise;
    const prepared = await readWorkflowPreparationFixture(
      actor.orgId,
      objectKey,
    );
    await assertAbsent(actor, prepared.workflowId, body.name);
    await assertWorkflowPreparationUnlockedFixture(
      agent.agentId,
      prepared.storageId,
    );
    release.resolve();
    const created = await accept(creating, [201]);
    expect(created.body).toMatchObject({
      id: prepared.workflowId,
      name: body.name,
      visibility: "private",
    });
    await assertReadable(actor, created.body.id, body);
    const state = await readWorkflowPublicationFixture(
      actor.orgId,
      created.body.id,
    );
    expect(
      state.mappings.map((mapping) => {
        return mapping.chatThreadId;
      }),
    ).toStrictEqual([thread.id]);
    expect(state.versions).toHaveLength(1);
    expect(state.storage[0]?.headVersionId).toBe(state.versions[0]?.id);
    const transactions = [
      ...state.workflow,
      ...state.mappings,
      ...state.storage,
      ...state.versions,
    ].map((row) => {
      return row.transaction;
    });
    expect(transactions).toHaveLength(4);
    expect(new Set(transactions).size).toBe(1);
    const archive = [...s3.objects].find(([key]) => {
      return key.endsWith("/archive.tar.gz");
    })?.[1];
    expect(archive).toBeDefined();
    if (!archive) {
      throw new Error("Expected the published archive");
    }
    expect(gunzipSync(archive).toString("utf8")).toContain(
      synthesizeWorkflowSkillMd({
        name: body.name,
        description: body.description ?? null,
        instruction: body.instruction ?? null,
      }),
    );
  });

  it.each([
    "archive upload",
    "manifest upload",
    "archive verification",
    "manifest verification",
  ])(
    "does not publish after %s fails and permits the same create after recovery",
    async (phase) => {
      const { actor, body } = await setupCreation();
      const s3 = installS3Fixture();
      const started = deferred<string>();
      const release = deferred<void>();
      s3.intercept(async (command) => {
        if (command instanceof PutObjectCommand && command.input.Key) {
          started.resolve(command.input.Key);
          await release.promise;
        }
        const uploading = phase.endsWith("upload");
        if (
          (uploading && command instanceof PutObjectCommand) ||
          (!uploading && command instanceof HeadObjectCommand)
        ) {
          const suffix = phase.startsWith("archive")
            ? "/archive.tar.gz"
            : "/manifest.json";
          if (command.input.Key?.endsWith(suffix)) {
            throw Object.assign(
              new Error("Storage unavailable after SDK attempts"),
              {
                name: "ServiceUnavailable",
                $metadata: { httpStatusCode: 503, attempts: 3 },
              },
            );
          }
        }
      });
      const creating = Promise.allSettled([
        client(context.signal, true).create({ headers: headers(actor), body }),
      ]);
      onTestFinished(async () => {
        release.resolve();
        await creating;
      });
      const prepared = await readWorkflowPreparationFixture(
        actor.orgId,
        await started.promise,
      );
      release.resolve();
      expect((await creating)[0]).toMatchObject({
        status: "rejected",
        reason: {
          name: "ServiceUnavailable",
          $metadata: { httpStatusCode: 503, attempts: 3 },
        },
      });
      const state = await assertAbsent(actor, prepared.workflowId, body.name);
      expect(state.storage).toStrictEqual([]);
      expect(s3.objects.size).toBe(0);
      s3.intercept(() => {});
      const recovered = await accept(
        client().create({ headers: headers(actor), body }),
        [201],
      );
      await assertReadable(actor, recovered.body.id, body);
    },
  );

  it("cleans up an aborted upload with a separate signal and leaves the name available", async () => {
    const { actor, body } = await setupCreation();
    const s3 = installS3Fixture();
    const controller = new AbortController();
    const started = deferred<string>();
    const release = deferred<void>();
    s3.intercept(async (command) => {
      if (command instanceof PutObjectCommand && command.input.Key) {
        started.resolve(command.input.Key);
        await release.promise;
      }
    });
    const creating = Promise.allSettled([
      client(AbortSignal.any([context.signal, controller.signal]), true).create(
        { headers: headers(actor), body },
      ),
    ]);
    onTestFinished(async () => {
      release.resolve();
      await creating;
    });
    const prepared = await readWorkflowPreparationFixture(
      actor.orgId,
      await started.promise,
    );
    controller.abort();
    release.resolve();
    expect((await creating)[0]).toMatchObject({
      status: "rejected",
      reason: { name: "AbortError" },
    });
    expect(
      (await assertAbsent(actor, prepared.workflowId, body.name)).storage,
    ).toStrictEqual([]);
    expect(s3.objects.size).toBe(0);
    const recovered = await accept(
      client().create({ headers: headers(actor), body }),
      [201],
    );
    await assertReadable(actor, recovered.body.id, body);
  });

  it("publishes independent workflows on the same agent while another publication waits on its thread", async () => {
    const { actor, thread, body } = await setupCreation();
    installS3Fixture();
    const boundary = await holdWorkflowCreationThreadFixture(
      thread.id,
      context.signal,
    );
    const creating = client().create({ headers: headers(actor), body });
    const settledPublication = Promise.allSettled([boundary.done, creating]);
    onTestFinished(async () => {
      boundary.release();
      await settledPublication;
    });
    await vi.waitFor(async () => {
      await expect(boundary.blockedPids()).resolves.toHaveLength(1);
    });

    const independentBody = {
      ...body,
      name: `${body.name}-independent`,
      chatThreadId: undefined,
    };
    const independent = client().create({
      headers: headers(actor),
      body: independentBody,
    });
    const settledIndependent = Promise.allSettled([independent]);
    onTestFinished(async () => {
      boundary.release();
      await settledIndependent;
    });
    const published = await accept(independent, [201]);
    await assertReadable(actor, published.body.id, independentBody);
    await expect(boundary.blockedPids()).resolves.toHaveLength(1);

    boundary.release();
    await boundary.done;
    const created = await accept(creating, [201]);
    await assertReadable(actor, created.body.id, body);
  });

  it.each(["public", "private"] as const)(
    "publishes one winner for concurrent %s creates and preserves its files",
    async (visibility) => {
      const { actor, body: input } = await setupCreation();
      const body = { ...input, visibility };
      const s3 = installS3Fixture();
      const started = deferred<void>();
      const release = deferred<void>();
      const attempts: { workflowId: string; storageId: string }[] = [];
      s3.intercept(async (command) => {
        if (
          command instanceof PutObjectCommand &&
          command.input.Key?.endsWith("/archive.tar.gz")
        ) {
          attempts.push(
            await readWorkflowPreparationFixture(
              actor.orgId,
              command.input.Key,
            ),
          );
          if (attempts.length === 2) {
            started.resolve();
          }
          await release.promise;
        }
      });
      const requests = Promise.all([
        client().create({ headers: headers(actor), body }),
        client().create({ headers: headers(actor), body }),
      ]);
      onTestFinished(async () => {
        release.resolve();
        await requests;
      });
      await started.promise;
      release.resolve();
      const results = await requests;
      expect(
        results
          .map((result) => {
            return result.status;
          })
          .sort(),
      ).toStrictEqual([201, 409]);
      const winner = results.find((result) => {
        return result.status === 201;
      });
      if (!winner || winner.status !== 201) {
        throw new Error("Expected one successful creation");
      }
      const loser = attempts.find((attempt) => {
        return attempt.workflowId !== winner.body.id;
      });
      if (!loser) {
        throw new Error("Expected a losing creation attempt");
      }
      const loserState = await readWorkflowPublicationFixture(
        actor.orgId,
        loser.workflowId,
      );
      expect(loserState).toStrictEqual({
        workflow: [],
        mappings: [],
        storage: [],
        versions: [],
      });
      expect(s3.objects.size).toBe(2);
      await assertReadable(actor, winner.body.id, body);
    },
  );

  it("rolls back an interrupted publication transaction without publishing a binding or HEAD", async () => {
    const { actor, thread, body } = await setupCreation();
    const s3 = installS3Fixture();
    const started = deferred<string>();
    s3.intercept((command) => {
      if (command instanceof PutObjectCommand && command.input.Key) {
        started.resolve(command.input.Key);
      }
    });
    const boundary = await holdWorkflowCreationThreadFixture(
      thread.id,
      context.signal,
    );
    const creating = Promise.allSettled([
      client(context.signal, true).create({ headers: headers(actor), body }),
    ]);
    onTestFinished(async () => {
      boundary.release();
      await boundary.done;
      await creating;
    });
    const prepared = await readWorkflowPreparationFixture(
      actor.orgId,
      await started.promise,
    );
    await vi.waitFor(async () => {
      await expect(boundary.blockedPids()).resolves.toHaveLength(1);
    });
    await assertAbsent(actor, prepared.workflowId, body.name);
    const [pid] = await boundary.blockedPids();
    if (!pid) {
      throw new Error("Expected the blocked publication backend");
    }
    await boundary.cancelBlockedPublication(pid);
    expect((await creating)[0]).toMatchObject({
      status: "rejected",
      reason: { cause: { code: "57014" } },
    });
    boundary.release();
    await boundary.done;
    expect(
      (await assertAbsent(actor, prepared.workflowId, body.name)).storage,
    ).toStrictEqual([]);
    const recovered = await accept(
      client().create({ headers: headers(actor), body }),
      [201],
    );
    await assertReadable(actor, recovered.body.id, body);
  });

  it.each(["notification failure", "post-commit cancellation"])(
    "preserves the committed Workflow after %s",
    async (failure) => {
      const { actor, body } = await setupCreation();
      const s3 = installS3Fixture();
      const controller = new AbortController();
      context.mocks.ably.publish.mockImplementationOnce(() => {
        if (failure === "post-commit cancellation") {
          controller.abort();
        }
        throw new Error("Notification unavailable");
      });
      const [response] = await Promise.allSettled([
        client(
          AbortSignal.any([context.signal, controller.signal]),
          true,
        ).create({ headers: headers(actor), body }),
      ]);
      expect(response).toMatchObject(
        failure === "notification failure"
          ? { status: "fulfilled", value: { status: 201 } }
          : { status: "rejected", reason: { name: "AbortError" } },
      );
      const listed = await accept(
        client().list({ headers: headers(actor) }),
        [200],
      );
      const workflow = listed.body.find((workflow) => {
        return workflow.name === body.name;
      });
      if (!workflow) {
        throw new Error("Expected the committed Workflow");
      }
      await assertReadable(actor, workflow.id, body);
      const state = await readWorkflowPublicationFixture(
        actor.orgId,
        workflow.id,
      );
      expect(state.versions).toHaveLength(1);
      expect(state.mappings).toHaveLength(1);
      expect(s3.objects.size).toBe(2);
    },
  );

  it("preserves the original upload error when cleanup fails and leaves other Workflows intact", async () => {
    const { actor, body } = await setupCreation();
    const other = await setupCreation();
    const s3 = installS3Fixture();
    const sameOrg = await accept(
      client().create({
        headers: headers(actor),
        body: { ...body, name: `${body.name}-existing` },
      }),
      [201],
    );
    const otherOrg = await accept(
      client().create({ headers: headers(other.actor), body: other.body }),
      [201],
    );
    const originalError = new Error("Original archive upload failure");
    s3.intercept((command) => {
      if (
        command instanceof PutObjectCommand &&
        command.input.Key?.endsWith("/archive.tar.gz")
      ) {
        throw originalError;
      }
      if (command instanceof ListObjectsV2Command) {
        throw new Error("Cleanup storage unavailable");
      }
    });
    await expect(
      client(context.signal, true).create({ headers: headers(actor), body }),
    ).rejects.toBe(originalError);
    const listed = await accept(
      client().list({ headers: headers(actor) }),
      [200],
    );
    expect(
      listed.body.map((workflow) => {
        return workflow.name;
      }),
    ).not.toContain(body.name);
    await assertReadable(actor, sameOrg.body.id, body);
    await assertReadable(other.actor, otherOrg.body.id, other.body);
  });
  it.each(["agent deleted", "agent access revoked", "thread deleted"])(
    "revalidates publication after %s during upload",
    async (change) => {
      const { actor, agent, thread, body } = await setupCreation();
      const creator =
        change === "agent access revoked"
          ? {
              ...bdd.user({ orgId: actor.orgId, orgRole: "org:member" }),
              orgId: actor.orgId,
            }
          : actor;
      const s3 = installS3Fixture();
      const started = deferred<string>();
      const release = deferred<void>();
      s3.intercept(async (command) => {
        if (command instanceof PutObjectCommand && command.input.Key) {
          started.resolve(command.input.Key);
          await release.promise;
        }
      });
      const creating = client().create({ headers: headers(creator), body });
      onTestFinished(async () => {
        release.resolve();
        await creating;
      });
      const prepared = await readWorkflowPreparationFixture(
        actor.orgId,
        await started.promise,
      );
      if (change === "agent deleted") {
        await bdd.deleteAgent(actor, agent.agentId);
      } else if (change === "agent access revoked") {
        await bdd.updateAgentMetadata(actor, agent.agentId, {
          visibility: "private",
        });
      } else {
        await chat.deleteThread(actor, thread.id);
      }
      release.resolve();
      const result = await creating;
      if (change === "thread deleted") {
        expect(result.status).toBe(201);
        await assertReadable(actor, prepared.workflowId, body);
        const state = await readWorkflowPublicationFixture(
          actor.orgId,
          prepared.workflowId,
        );
        expect(state.mappings).toStrictEqual([]);
        expect(state.versions).toHaveLength(1);
      } else {
        expect(result.status).toBe(change === "agent deleted" ? 404 : 403);
        const state = await assertAbsent(
          creator,
          prepared.workflowId,
          body.name,
        );
        expect(state.storage).toStrictEqual([]);
      }
    },
  );

  it("does not reserve the name when the supplied files cannot be materialized", async () => {
    const { actor, body } = await setupCreation();
    const s3 = installS3Fixture();
    const [failed] = await Promise.allSettled([
      client(context.signal, true).create({
        headers: headers(actor),
        body: {
          ...body,
          files: [
            { path: "directory", content: "file" },
            { path: "directory/child.txt", content: "nested file" },
          ],
        },
      }),
    ]);
    expect(failed).toMatchObject({
      status: "rejected",
      reason: { code: "EEXIST" },
    });
    const listed = await accept(
      client().list({ headers: headers(actor) }),
      [200],
    );
    expect(
      listed.body.map((workflow) => {
        return workflow.name;
      }),
    ).not.toContain(body.name);
    expect(s3.objects.size).toBe(0);
    const recovered = await accept(
      client().create({ headers: headers(actor), body }),
      [201],
    );
    await assertReadable(actor, recovered.body.id, body);
  });
});
