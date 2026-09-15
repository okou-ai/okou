import { randomUUID } from "node:crypto";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { mockAxiomSdkTelemetryFailure } from "../../../__tests__/mocks";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { rejectSharedThreadArtifactWrites } from "../../../test-fixtures/shared-thread";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { sharedThreadRoutes } from "../shared-threads";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);
const routeMocks = createRouteMocks(context);
const endpoint = "https://openrouter.ai/api/v1/chat/completions";
const privateTitle = "Unshared confidential acquisition title";
const privateContent = "Unselected confidential acquisition message";
const providerSecret = "Private provider response and credential details";
const selectedContent = "Publish the agreed launch checklist";

beforeEach(() => {
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
});

function client(rethrowErrors = false, signal = context.signal) {
  return setupApp({
    context,
    routes: sharedThreadRoutes,
    rethrowErrors,
    signal,
  })(sharedThreadsContract);
}

function authenticate(actor: ApiTestUser) {
  routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

function completion(content = "**Launch checklist**", finishReason = "stop") {
  return HttpResponse.json({
    choices: [
      {
        finish_reason: finishReason,
        ...(finishReason === "length"
          ? { native_finish_reason: "MAX_TOKENS" }
          : {}),
        message: { content },
      },
    ],
  });
}

function brokenBody(error: Error) {
  return new HttpResponse(
    new ReadableStream({
      start(controller) {
        controller.error(error);
      },
    }),
  );
}

async function prepareShare(content = selectedContent) {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, { displayName: "Sharing test" });
  const sent = await accept(
    chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: content,
      },
      [201],
    ),
    [201],
  );
  const { threadId, runId } = sent.body;
  if (!runId) {
    throw new Error("Expected a new chat run");
  }
  await chat.renameThread(actor, threadId, privateTitle);
  await chat.requestSendEvent(
    actor,
    {
      agentId: agent.agentId,
      threadId,
      prompt: privateContent,
    },
    [201],
  );
  await flushWaitUntilForTest();
  const { events } = await chat.listThreadEvents(actor, threadId);
  const eventId = events.find((event) => {
    return event.eventType === "input.prompt" && event.runId === runId;
  })?.id;
  if (!eventId) {
    throw new Error("Expected the selected event");
  }
  return { actor, threadId, eventId, content };
}

type ShareFixture = Awaited<ReturnType<typeof prepareShare>>;

function requestBody(fixture: ShareFixture) {
  return {
    params: { threadId: fixture.threadId },
    headers: authenticate(fixture.actor),
    body: { eventIds: [fixture.eventId, fixture.eventId] },
  };
}

async function expectSharedSnapshot(
  fixture: ShareFixture,
  id: string,
  title: string,
) {
  const shared = await accept(client().get({ params: { id } }), [200]);
  expect(shared.body).toStrictEqual({
    id,
    title,
    publicBrand: "okou",
    messages: [
      {
        messageIndex: 0,
        role: "user",
        content: fixture.content,
        runIndex: 0,
      },
    ],
  });
  expect(shared.headers.get("cache-control")).toBe("no-store");
  const meta = await accept(client().meta({ params: { id } }), [200]);
  expect(meta.body).toStrictEqual({ title, publicBrand: "okou" });
  expect(meta.headers.get("cache-control")).toBe(
    "public, max-age=31536000, s-maxage=31536000, immutable",
  );
  const catalog = await chat.listArtifactCatalog(fixture.actor, {
    kind: "shared-thread",
    chatThreadId: fixture.threadId,
  });
  expect(catalog.artifacts).toHaveLength(1);
  const artifact = catalog.artifacts[0];
  if (!artifact) {
    throw new Error("Expected one share artifact");
  }
  expect(artifact).toMatchObject({ kind: "shared-thread", title });
  const detail = await chat.getArtifactCatalogEntry(fixture.actor, artifact.id);
  expect(detail).toMatchObject({
    kind: "shared-thread",
    title,
    sharedThread: { id },
  });
  const publicData = JSON.stringify([shared.body, meta.body, catalog, detail]);
  for (const secret of [privateTitle, privateContent, providerSecret]) {
    expect(publicData).not.toContain(secret);
  }
}

async function expectNoShare(fixture: ShareFixture) {
  const catalog = await chat.listArtifactCatalog(fixture.actor, {
    kind: "shared-thread",
    chatThreadId: fixture.threadId,
  });
  expect(catalog.artifacts).toStrictEqual([]);
}

describe("optional shared-thread titles", () => {
  // One shape per externally distinguishable outcome: a usable title, or the
  // fixed fallback. Which provider code or transport fault produced a failure
  // reaches the public snapshot identically.
  const generationCases = [
    {
      name: "healthy title",
      response: () => {
        return completion();
      },
      title: "Launch checklist",
    },
    {
      name: "rate limit",
      response: () => {
        return new HttpResponse(providerSecret, { status: 429 });
      },
      title: "Shared conversation",
    },
    {
      name: "auth failure",
      response: () => {
        return new HttpResponse(providerSecret, { status: 401 });
      },
      title: "Shared conversation",
    },
    {
      name: "network failure",
      response: () => {
        return HttpResponse.error();
      },
      title: "Shared conversation",
    },
    {
      name: "unknown defect",
      response: () => {
        return brokenBody(new TypeError(providerSecret));
      },
      title: "Shared conversation",
    },
    {
      name: "empty interpreted title",
      response: () => {
        return completion("---");
      },
      title: "Shared conversation",
    },
    {
      // A public snapshot keeps its title forever, so a partial one is worse
      // than the fixed fallback.
      name: "exhausted token budget",
      response: () => {
        return completion("A Truncated Shared Title That Must", "length");
      },
      title: "Shared conversation",
    },
    {
      name: "invalid JSON",
      response: () => {
        return new HttpResponse(providerSecret);
      },
      title: "Shared conversation",
    },
  ];

  it.each(generationCases)(
    "creates one private-content-safe snapshot with $name",
    async ({ response, title }) => {
      const fixture = await prepareShare();
      mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter");
      const prompts: string[] = [];
      server.use(
        http.post(endpoint, async ({ request }) => {
          prompts.push(await request.text());
          return response();
        }),
      );
      const created = await accept(
        client().create(requestBody(fixture)),
        [201],
      );
      expect(Object.keys(created.body)).toStrictEqual(["id"]);
      await flushWaitUntilForTest();
      await expectSharedSnapshot(fixture, created.body.id, title);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain(selectedContent);
      expect(prompts[0]).not.toContain(privateTitle);
      expect(prompts[0]).not.toContain(privateContent);
      expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
    },
  );

  it("uses the fixed title and calls no provider without model configuration", async () => {
    const fixture = await prepareShare();
    const requests: string[] = [];
    server.use(
      http.post(endpoint, ({ request }) => {
        requests.push(request.url);
        return completion();
      }),
    );
    const created = await accept(client().create(requestBody(fixture)), [201]);
    await flushWaitUntilForTest();
    await expectSharedSnapshot(fixture, created.body.id, "Shared conversation");
    expect(requests).toStrictEqual([]);
  });

  it.each(["ingest", "flush"] as const)(
    "preserves a valid share when telemetry %s fails",
    async (mode) => {
      const fixture = await prepareShare();
      mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter");
      server.use(
        http.post(endpoint, () => {
          return new HttpResponse(null, { status: 429 });
        }),
      );
      mockAxiomSdkTelemetryFailure({ mode });
      const created = await accept(
        client().create(requestBody(fixture)),
        [201],
      );
      await expect(flushWaitUntilForTest()).resolves.toBeUndefined();
      await expectSharedSnapshot(
        fixture,
        created.body.id,
        "Shared conversation",
      );
      expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
    },
  );

  it("preserves cancellation before request dispatch", async () => {
    const fixture = await prepareShare();
    const controller = new AbortController();
    const reason = new DOMException("Caller cancelled", "AbortError");
    controller.abort(reason);
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter");
    const requests: string[] = [];
    server.use(
      http.post(endpoint, ({ request }) => {
        requests.push(request.url);
        return completion();
      }),
    );
    await expect(
      client(true).create({
        ...requestBody(fixture),
        fetchOptions: { signal: controller.signal },
      }),
    ).rejects.toBe(reason);
    await flushWaitUntilForTest();
    await expectNoShare(fixture);
    expect(requests).toStrictEqual([]);
    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
  });

  it.each([
    { late: "success", cancellation: "request" },
    { late: "rejection", cancellation: "request" },
    { late: "success", cancellation: "lifecycle" },
  ])(
    "preserves $cancellation cancellation before the provider's late $late",
    async ({ late, cancellation }) => {
      const fixture = await prepareShare();
      const controller = new AbortController();
      const reason =
        late === "success"
          ? new DOMException("Caller deadline", "TimeoutError")
          : new DOMException("Caller cancelled", "AbortError");
      const entered = createDeferredPromise<AbortSignal>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      const returned = createDeferredPromise<void>(context.signal);
      mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter");
      server.use(
        http.post(endpoint, async ({ request }) => {
          entered.resolve(request.signal);
          await release.promise;
          returned.resolve(undefined);
          return late === "success" ? completion() : HttpResponse.error();
        }),
      );
      const request = client(
        late === "success",
        cancellation === "lifecycle" ? controller.signal : context.signal,
      ).create({
        ...requestBody(fixture),
        fetchOptions: {
          signal: cancellation === "request" ? controller.signal : undefined,
        },
      });
      const outcome = Promise.allSettled([request]);
      onTestFinished(async () => {
        controller.abort(reason);
        if (!release.settled()) {
          release.resolve(undefined);
        }
        await outcome;
      });
      const providerSignal = await entered.promise;
      controller.abort(reason);
      await expect(outcome).resolves.toStrictEqual([
        {
          status: "rejected",
          reason:
            late === "success"
              ? reason
              : expect.objectContaining({
                  message: expect.stringContaining(
                    "Unknown response status 500",
                  ),
                }),
        },
      ]);
      expect(providerSignal.aborted).toBeTruthy();
      expect(providerSignal.reason).toBe(reason);
      await expectNoShare(fixture);
      release.resolve(undefined);
      await returned.promise;
      await flushWaitUntilForTest();
      await expectNoShare(fixture);
      expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
    },
  );

  it("keeps authentication, ownership and selection failures outside optional generation", async () => {
    const fixture = await prepareShare();
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter");
    await accept(
      client().create({ ...requestBody(fixture), headers: {} }),
      [401],
    );
    for (const actor of [
      bdd.user({ orgId: fixture.actor.orgId }),
      bdd.user(),
    ]) {
      await accept(
        client().create({
          ...requestBody(fixture),
          headers: authenticate(actor),
        }),
        [404],
      );
    }
    const empty = await accept(
      client().create({ ...requestBody(fixture), body: { eventIds: [] } }),
      [400],
    );
    expect(empty.body.error.code).toBe("BAD_REQUEST");
    const unknown = await accept(
      client().create({
        ...requestBody(fixture),
        body: { eventIds: [randomUUID()] },
      }),
      [400],
    );
    expect(unknown.body.error.code).toBe("NO_SHAREABLE_MESSAGES");
    await expectNoShare(fixture);
    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
  });

  it("rejects oversized selections before title generation", async () => {
    const fixture = await prepareShare("A".repeat(2 * 1024 * 1024));
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter");
    const response = await accept(client().create(requestBody(fixture)), [413]);
    expect(response.body.error.code).toBe("SHARED_THREAD_TOO_LARGE");
    await expectNoShare(fixture);
    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
  });

  it("rolls back the share when the real artifact write fails after title degradation", async () => {
    const fixture = await prepareShare();
    if (!fixture.actor.orgId) {
      throw new Error("Expected a test-owned organization");
    }
    // The scoped infrastructure fault is the only non-public setup: no user
    // input can force this second transaction statement to fail independently.
    const release = await rejectSharedThreadArtifactWrites(
      fixture.actor.orgId,
      context.signal,
    );
    onTestFinished(release);
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter");
    server.use(
      http.post(endpoint, () => {
        return new HttpResponse(null, { status: 429 });
      }),
    );
    await expect(client().create(requestBody(fixture))).rejects.toThrow(
      "Unknown response status 500 for POST /api/chat-threads/:threadId/shared-threads",
    );
    await flushWaitUntilForTest();
    expect(context.mocks.sentry.captureException).toHaveBeenCalledOnce();
    // PostgreSQL reports the attempted public share ID through the external
    // error capture. Verify rollback using both public read endpoints.
    const error = z
      .object({
        cause: z.object({
          code: z.literal("23514"),
          detail: z.string().uuid(),
        }),
      })
      .parse(context.mocks.sentry.captureException.mock.calls[0]?.[0]);
    await accept(client().get({ params: { id: error.cause.detail } }), [404]);
    await accept(client().meta({ params: { id: error.cause.detail } }), [404]);
    await expectNoShare(fixture);
  });
});
