import { randomUUID } from "node:crypto";
import type {
  ExecutionContext,
  Hyperdrive,
  Socket,
  Span,
  Tracing,
} from "@cloudflare/workers-types";
import { expect, test } from "vitest";

import { env } from "../lib/env";
import { createRouteMocks } from "../signals/routes/__tests__/helpers/route-test";
import worker from "../worker";
import { testContext } from "./test-context";

const context = testContext();

/** A span of the Workers tracing SDK that records nothing. */
class UntracedSpan implements Span {
  get isTraced(): boolean {
    return false;
  }
  setAttribute(): this {
    return this;
  }
  setAttributes(): this {
    return this;
  }
  recordException(): void {}
  end(): void {}
}

/** The Workers tracing SDK of a host that traces nothing. */
const untraced: Readonly<Tracing> = {
  enterSpan(_name, callback, ...args) {
    return callback(new UntracedSpan(), ...args);
  },
  startActiveSpan(_name, callback, ...args) {
    return callback(new UntracedSpan(), ...args);
  },
  startSpan() {
    return new UntracedSpan();
  },
  getActiveSpan() {
    return undefined;
  },
  Span: UntracedSpan,
};

/** The Hyperdrive binding for the local database; the pg pool connects over TCP itself. */
function localHyperdrive(): Hyperdrive {
  const connectionString = env("DATABASE_URL");
  const url = new URL(connectionString);
  return {
    connectionString,
    host: url.hostname,
    ip: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
    connect(): Socket {
      throw new Error("Hyperdrive sockets are not used by the pg pool");
    },
  };
}

/** A Cloudflare Worker host whose registered background work is observed. */
function workerHost() {
  const background: Promise<unknown>[] = [];
  const executionContext: ExecutionContext = {
    waitUntil(work: Promise<unknown>) {
      background.push(work);
    },
    passThroughOnException() {},
    exports: {},
    props: {},
    tracing: untraced,
    abort() {},
  };
  const bindings = { HYPERDRIVE: localHyperdrive() };
  return {
    background,
    async request(path: string, init: RequestInit): Promise<Response> {
      return await worker.fetch(
        new Request(`http://api.test${path}`, init),
        bindings,
        executionContext,
      );
    },
  };
}

test("worker-lifecycle-001 serves DB-backed foreground writes through response EOF and a subsequent Worker request", async () => {
  const member = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  };
  createRouteMocks(context).clerk.session(member.userId, member.orgId);
  const headers = {
    authorization: "Bearer clerk-session",
    "content-type": "application/json",
  };
  const host = workerHost();

  const created = await host.request("/api/chat-threads", {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "Worker foreground", model: null }),
  });
  const createdBody: unknown = await created.json();
  if (
    typeof createdBody !== "object" ||
    createdBody === null ||
    !("id" in createdBody) ||
    typeof createdBody.id !== "string"
  ) {
    throw new Error("Expected the created thread");
  }
  const metadata = await host.request(
    `/api/chat-threads/${createdBody.id}/metadata`,
    { headers },
  );
  const metadataBody: unknown = await metadata.json();
  const settled = await Promise.allSettled(host.background);

  expect(created.status).toBe(201);
  expect(createdBody).toMatchObject({ title: "Worker foreground" });
  expect(metadata.status).toBe(200);
  expect(metadataBody).toMatchObject({
    id: createdBody.id,
    title: "Worker foreground",
  });
  expect(
    settled.filter((result) => {
      return result.status === "rejected";
    }),
  ).toStrictEqual([]);
});
