import { initContract } from "@okouai/api-contracts/contracts/base";
import { expect, test } from "vitest";
import { z } from "zod";

import { testContext } from "../../signals/__tests__/test-helpers.ts";

const context = testContext();
const c = initContract();
const contracts = c.router({
  read: {
    method: "GET",
    path: "/api/mock-contracts/:id",
    pathParams: z.object({ id: z.string() }),
    query: z.object({ limit: z.coerce.number().int() }),
    responses: { 200: z.object({ id: z.string(), limit: z.number() }) },
  },
  update: {
    method: "PATCH",
    path: "/api/mock-contracts/:id",
    pathParams: z.object({ id: z.string() }),
    body: z.object({ title: z.string() }),
    responses: { 200: z.object({ id: z.string(), title: z.string() }) },
  },
  cookie: {
    method: "GET",
    path: "/api/mock-cookies",
    responses: { 200: z.object({ cookies: z.string().nullable() }) },
  },
  optional: {
    method: "GET",
    path: "/api/mock-optional/:id?",
    pathParams: z.object({ id: z.string().optional() }),
    responses: { 200: z.object({ id: z.string().nullable() }) },
  },
  thread: {
    method: "GET",
    path: "/api/chat-threads/:id",
    pathParams: z.object({ id: z.string() }),
    responses: { 200: z.object({ id: z.string() }) },
  },
  snapshot: {
    method: "GET",
    path: "/api/chat-threads/snapshot",
    responses: { 200: z.object({ source: z.literal("snapshot") }) },
  },
  account: {
    method: "GET",
    path: "/api/connector-accounts/:connectionId",
    pathParams: z.object({ connectionId: z.string() }),
    responses: { 200: z.object({ connectionId: z.string() }) },
  },
  accounts: {
    method: "GET",
    path: "/api/connector-accounts/connections",
    responses: { 200: z.object({ source: z.literal("accounts") }) },
  },
  events: {
    method: "GET",
    path: "/api/chat-threads/events",
    responses: { 200: z.object({ source: z.literal("events") }) },
  },
});

test("Contract mocks dispatch methods and decode path, query, and JSON inputs", async () => {
  context.mocks.api(contracts.read, ({ params, query, respond }) => {
    return respond(200, { id: params.id, limit: query.limit });
  });
  context.mocks.api(contracts.update, ({ params, body, respond }) => {
    return respond(200, { id: params.id, title: body.title });
  });
  const url = "http://localhost/api/mock-contracts/entry%20one";

  const read = await fetch(`${url}?limit=2`);
  expect(read.status).toBe(200);
  await expect(read.json()).resolves.toStrictEqual({
    id: "entry one",
    limit: 2,
  });

  const update = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Updated title" }),
  });
  expect(update.status).toBe(200);
  await expect(update.json()).resolves.toStrictEqual({
    id: "entry one",
    title: "Updated title",
  });

  context.mocks.api(contracts.read, ({ params, respond }) => {
    return respond(200, { id: params.id, limit: 3 });
  });
  const replaced = await fetch(`${url}?limit=2`);
  await expect(replaced.json()).resolves.toStrictEqual({
    id: "entry one",
    limit: 3,
  });
});

test("Nonmatching contract mocks do not duplicate cookies on the matched request", async () => {
  context.mocks.browser.cookie("browser-preference=compact");
  context.mocks.api(contracts.cookie, ({ request, respond }) => {
    return respond(200, { cookies: request.headers.get("cookie") });
  });
  // Both a different path and a different method precede the matching handler.
  context.mocks.api(contracts.read, ({ params, query, respond }) => {
    return respond(200, { id: params.id, limit: query.limit });
  });
  context.mocks.api(contracts.update, ({ params, body, respond }) => {
    return respond(200, { id: params.id, title: body.title });
  });

  // A route prefix appearing only in the query is not a matching path.
  const response = await fetch(
    "http://localhost/api/mock-cookies?next=/api/mock-contracts/ignored",
    { credentials: "include" },
  );
  expect(response.status).toBe(200);
  const body = contracts.cookie.responses[200].parse(await response.json());
  expect(body.cookies).toBe("browser-preference=compact");
});

test.each([
  { url: "http://localhost/api/mock-optional", id: null },
  { url: "http://localhost/api/mock-optional/", id: null },
  {
    url: "http://localhost/API/MOCK-OPTIONAL/entry%20one/",
    id: "entry one",
  },
  {
    url: "https://api.preview.test/gateway/api/mock-optional/entry%20one",
    id: "entry one",
  },
])(
  "Contract mocks preserve optional path matching for $url",
  async ({ url, id }) => {
    context.mocks.api(contracts.optional, ({ params, respond }) => {
      return respond(200, { id: params.id ?? null });
    });

    const response = await fetch(url);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ id });
  },
);

test("Thread detail mocks leave static siblings to their own handlers", async () => {
  context.mocks.api(contracts.snapshot, ({ respond }) => {
    return respond(200, { source: "snapshot" });
  });
  context.mocks.api(contracts.events, ({ respond }) => {
    return respond(200, { source: "events" });
  });
  context.mocks.api(contracts.thread, ({ params, respond }) => {
    return respond(200, { id: params.id });
  });

  const snapshot = await fetch("http://localhost/api/chat-threads/snapshot");
  await expect(snapshot.json()).resolves.toStrictEqual({ source: "snapshot" });
  const events = await fetch("http://localhost/api/chat-threads/events");
  await expect(events.json()).resolves.toStrictEqual({ source: "events" });
  const detail = await fetch("http://localhost/api/chat-threads/thread-one");
  await expect(detail.json()).resolves.toStrictEqual({ id: "thread-one" });
});

test("Account detail mocks leave static lists to their own handlers", async () => {
  context.mocks.api(contracts.accounts, ({ respond }) => {
    return respond(200, { source: "accounts" });
  });

  context.mocks.api(contracts.account, ({ params, respond }) => {
    return respond(200, { connectionId: params.connectionId });
  });

  const list = await fetch(
    "http://localhost/api/connector-accounts/connections?kind=builtin&connectorSlug=github",
  );
  await expect(list.json()).resolves.toStrictEqual({ source: "accounts" });
  const detail = await fetch(
    "http://localhost/api/connector-accounts/account-one",
  );
  await expect(detail.json()).resolves.toStrictEqual({
    connectionId: "account-one",
  });
});
