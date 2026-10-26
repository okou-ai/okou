import { randomUUID } from "node:crypto";
import { tracing } from "cloudflare:workers";
import { z } from "zod";
import {
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import type { ExecutionContext, Hyperdrive } from "@cloudflare/workers-types";
import { onTestFinished } from "vitest";
import { env } from "../lib/env";
import { createDeferredPromise } from "../signals/utils";
import { testContext } from "./test-context";
import { createRouteMocks } from "../signals/routes/__tests__/helpers/route-test";
import { installDurableUserExportStorage } from "../signals/routes/__tests__/helpers/durable-user-export-storage";
import { mockClerkUsers } from "../signals/routes/__tests__/helpers/clerk-users";
// Do not call setupApp/isolatePg here. The common case-database adapter has no
// selected database and delegates to original.db(), so Worker AsyncLocalStorage
// selects the request's real pg Pool, not a PGlite or test-owned DB handle.
import worker from "../worker";

const context = testContext();
const routeMocks = createRouteMocks(context);

function latch() {
  return createDeferredPromise<void>(context.signal);
}

function actor() {
  const userId = `user_worker_${randomUUID()}`;
  const orgId = `org_worker_${randomUUID()}`;
  routeMocks.clerk.session(userId, orgId);
  mockClerkUsers(context, [
    {
      id: userId,
      firstName: "Worker",
      lastName: "Owner",
      primaryEmailAddressId: "email",
      emailAddresses: [{ id: "email", emailAddress: `${userId}@example.test` }],
      privateMetadata: {},
      publicMetadata: {},
    },
  ]);
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [{ organization: { id: orgId } }],
    totalCount: 1,
  });
}

function caller() {
  const pending: Promise<unknown>[] = [];
  const failures: unknown[] = [];
  const execution = {
    waitUntil(work: Promise<unknown>) {
      pending.push(work);
      // A Workers host observes rejections immediately, including before EOF.
      work.catch((error: unknown) => {
        failures.push(error);
      });
    },
    passThroughOnException() {},
    props: {},
    exports: {},
    tracing,
    abort() {
      throw new Error("Unexpected Workers host abort");
    },
  } satisfies ExecutionContext;
  const databaseUrl = new URL(env("DATABASE_URL"));
  const binding = {
    connectionString: databaseUrl.toString(),
    host: databaseUrl.hostname,
    ip: databaseUrl.hostname,
    port: Number(databaseUrl.port || "5432"),
    user: databaseUrl.username,
    password: databaseUrl.password,
    database: databaseUrl.pathname.slice(1),
    connect(): never {
      throw new Error(
        "Direct Hyperdrive sockets are not supported by the local host",
      );
    },
  } satisfies Hyperdrive;
  async function settle() {
    let joined = 0;
    while (joined < pending.length) {
      const batch = pending.slice(joined);
      joined = pending.length;
      await Promise.allSettled(batch);
    }
    return failures;
  }
  onTestFinished(async () => {
    await settle();
  });
  return {
    settle,
    request(path: string, init: RequestInit = {}) {
      return worker.fetch(
        new Request(`http://worker.local${path}`, {
          ...init,
          signal: AbortSignal.any([
            context.signal,
            ...(init.signal ? [init.signal] : []),
          ]),
          headers: {
            authorization: "Bearer clerk-session",
            "content-type": "application/json",
            ...init.headers,
          },
        }),
        { HYPERDRIVE: binding },
        execution,
      );
    },
  };
}

async function createAgent(name: string) {
  const http = caller();
  const response = await http.request("/api/agents", {
    method: "POST",
    body: JSON.stringify({ displayName: name, visibility: "private" }),
  });
  expect(response.status).toBe(201);
  const body = z
    .object({ agentId: z.string(), displayName: z.string() })
    .parse(await response.json());
  expect(body).toMatchObject({ displayName: name });
  await expect(http.settle()).resolves.toStrictEqual([]);
  return body;
}

test("serves DB-backed foreground writes through response EOF and a subsequent Worker request", async () => {
  actor();
  const created = await createAgent("Worker foreground");
  const http = caller();
  const response = await http.request(`/api/agents/${created.agentId}`);
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    agentId: created.agentId,
    displayName: "Worker foreground",
  });
  await expect(http.settle()).resolves.toStrictEqual([]);
});

test.each(["eof", "cancel"] as const)(
  "continues admitted export DB work after response %s while a concurrent request finishes",
  async (completion) => {
    actor();
    await createAgent(`Export via ${completion}`);
    const entered = latch();
    const release = latch();
    context.signal.addEventListener(
      "abort",
      () => {
        if (!release.settled()) {
          release.resolve();
        }
      },
      { once: true },
    );
    let blocked = false;
    const documents: string[] = [];
    installDurableUserExportStorage(context, {
      afterWrite: async (command) => {
        if (command instanceof PutObjectCommand) {
          const body = command.input.Body;
          if (typeof body === "string") {
            documents.push(body);
          } else if (body instanceof Uint8Array) {
            documents.push(Buffer.from(body).toString());
          }
          if (!blocked) {
            blocked = true;
            entered.resolve();
            await release.promise;
          }
        }
      },
    });
    const owner = caller();
    const response = await owner.request("/api/user/export", {
      method: "POST",
    });
    expect(response.status).toBe(202);
    await entered.promise;
    if (completion === "eof") {
      await expect(response.json()).resolves.toMatchObject({
        jobId: expect.any(String),
        status: expect.stringMatching(/pending|running/),
      });
    } else {
      await response.body!.cancel("caller stopped reading");
    }
    // Finishing an independent request must not dispose the blocked owner's DB.
    await createAgent("Concurrent foreground");
    release.resolve();
    await expect(owner.settle()).resolves.toStrictEqual([]);
    const observer = caller();
    const status = await observer.request("/api/user/export");
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      job: { status: expect.stringMatching(/running|completed/) },
    });
    await expect(observer.settle()).resolves.toStrictEqual([]);
    expect(documents.join("\n")).toContain(`Export via ${completion}`);
  },
);

test("completes admitted foreground upload after the HTTP caller disconnects", async () => {
  actor();
  const entered = latch();
  const release = latch();
  context.signal.addEventListener(
    "abort",
    () => {
      if (!release.settled()) {
        release.resolve();
      }
    },
    { once: true },
  );
  const receipts: string[] = [];
  context.mocks.s3.send.mockImplementation(async (command: unknown) => {
    if (command instanceof PutObjectCommand) {
      return {};
    }
    if (command instanceof CreateMultipartUploadCommand) {
      entered.resolve();
      await release.promise;
      return { UploadId: "owned-worker-upload" };
    }
    if (command instanceof AbortMultipartUploadCommand) {
      receipts.push(String(command.input.UploadId));
      return {};
    }
    throw new Error("Unexpected external S3 operation");
  });
  const http = caller();
  const controller = new AbortController();
  onTestFinished(() => {
    controller.abort();
  });
  const response = http.request("/api/uploads/prepare", {
    method: "POST",
    signal: controller.signal,
    body: JSON.stringify({
      filename: "foreground.txt",
      contentType: "text/plain",
      size: 6 * 1024 * 1024,
      multipart: true,
    }),
  });
  await entered.promise;
  controller.abort(new DOMException("Caller disconnected", "AbortError"));
  await createAgent("Surviving foreground");
  release.resolve();
  const completed = await response;
  expect(completed.status).toBe(200);
  await expect(completed.json()).resolves.toMatchObject({
    multipart: { uploadId: "owned-worker-upload" },
  });
  await expect(http.settle()).resolves.toStrictEqual([]);
  expect(receipts).toStrictEqual([]);
});

test("retains the publicly accepted export job after a background provider receipt fails", async () => {
  actor();
  await createAgent("Export with uncertain provider receipt");
  const entered = latch();
  const release = latch();
  context.signal.addEventListener(
    "abort",
    () => {
      if (!release.settled()) {
        release.resolve();
      }
    },
    { once: true },
  );
  installDurableUserExportStorage(context, {
    afterWrite: async () => {
      entered.resolve();
      await release.promise;
      throw new Error("S3 receipt unavailable");
    },
  });
  const owner = caller();
  const response = await owner.request("/api/user/export", { method: "POST" });
  expect(response.status).toBe(202);
  const accepted = z.object({ jobId: z.string() }).parse(await response.json());
  await entered.promise;
  release.resolve();
  // Export handles provider failure by persisting a durable retry, not rejecting
  // its waitUntil. This does not pretend to cover raw host waitUntil rejection.
  await expect(owner.settle()).resolves.toStrictEqual([]);
  const observer = caller();
  const status = await observer.request("/api/user/export");
  expect(status.status).toBe(200);
  await expect(status.json()).resolves.toMatchObject({
    job: { id: accepted.jobId, status: "pending" },
    canExport: false,
  });
  const repeated = await observer.request("/api/user/export", {
    method: "POST",
  });
  expect(repeated.status).toBe(202);
  await expect(repeated.json()).resolves.toMatchObject({
    jobId: accepted.jobId,
    status: "pending",
  });
  await expect(observer.settle()).resolves.toStrictEqual([]);
});
