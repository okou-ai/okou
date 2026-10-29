import { createAuthDeviceSupportApi } from "./helpers/api-bdd-auth-device-support";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { sharedThreadVisibilityContract } from "@okouai/api-contracts/contracts/shared-thread-visibility";
import { installSharedThreadStorage } from "./helpers/shared-thread-storage";
import { array, string, object } from "zod";
import {
  mockGoogleText,
  VERTEX_TEXT_URL,
  vertexTextRequest,
} from "./helpers/google-text";
import { randomUUID } from "node:crypto";
import type { UserMessageInputDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { mockAxiomSdkTelemetryFailure } from "../../../__tests__/mocks";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { sharedThreadRoutes } from "../shared-threads";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const device = createAuthDeviceSupportApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);
const routeMocks = createRouteMocks(context);
const endpoint = VERTEX_TEXT_URL;
const privateTitle = "Unshared confidential acquisition title";
const privateContent = "Unselected confidential acquisition message";
const providerSecret = "Private provider response and credential details";
const selectedContent = "Publish the agreed launch checklist";

beforeEach(() => {
  mockOptionalEnv("GCP_LLM_PROJECT_ID", undefined);
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
    candidates: [
      {
        finishReason:
          finishReason === "length"
            ? "MAX_TOKENS"
            : finishReason === "stop"
              ? "STOP"
              : finishReason,
        content: {
          parts: [
            {
              text: content,
            },
          ],
        },
      },
    ],
  });
}

async function prepareShare(content = selectedContent) {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  // Sharing reads persisted chat events only. Fable keeps both sends queued
  // for the native Runner instead of starting unmocked Pi API-first turns.
  await runs.ensurePersonalSubscriptionModel(actor, {
    model: "claude-fable-5-1",
  });
  const agent = await bdd.createAgent(actor, { displayName: "Sharing test" });
  const { threadId, runId } = await chat.sendAndLaunch(actor, {
    agentId: agent.agentId,
    prompt: content,
  });
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
  expect(meta.body).toStrictEqual({ title });
  expect(meta.headers.get("cache-control")).toBe("no-store");
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
  ];

  it.each(generationCases)(
    "creates one private-content-safe snapshot with $name",
    async ({ response, title }) => {
      const fixture = await prepareShare();
      mockGoogleText();
      const requests: unknown[] = [];
      server.use(
        http.post(endpoint, async ({ request }) => {
          requests.push(vertexTextRequest(await request.json(), request.url));
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
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        model: "gemini-3.1-flash-lite",
        generationConfig: {
          maxOutputTokens: 2048,
          thinkingConfig: { thinkingLevel: "MINIMAL" },
        },
      });
      const prompt = JSON.stringify(requests[0]);
      expect(prompt).toContain(selectedContent);
      expect(prompt).not.toContain(privateTitle);
      expect(prompt).not.toContain(privateContent);
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

  it("removes forwarded chat provenance from the public snapshot", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensurePersonalSubscriptionModel(actor, {
      model: "claude-fable-5-1",
    });
    const agent = await bdd.createAgent(actor, {
      displayName: "Forwarded share test",
    });
    const source = await chat.sendAndLaunch(actor, {
      agentId: agent.agentId,
      prompt: "Source message",
    });
    const sourceTitle = "Private source thread title";
    await chat.renameThread(actor, source.threadId, sourceTitle);
    const targetThread = await chat.createThread(actor, {
      agentId: agent.agentId,
    });
    const quote = "The deployment window is fifteen minutes.";
    const mailId = randomUUID();
    const sentId = `gmail-${randomUUID()}`;
    const userMessage: UserMessageInputDocument = {
      version: 1,
      parts: [
        {
          type: "feedback",
          quote,
          note: [],
          source: { type: "mail", id: mailId, status: "sent", sentId },
        },
      ],
    };
    const forwarded = await chat.sendAndLaunch(actor, {
      agentId: agent.agentId,
      threadId: targetThread.id,
      prompt: "legacy fallback",
      userMessage,
      sourceRunId: source.runId,
    });
    const { events } = await chat.listThreadEvents(actor, targetThread.id);
    const eventId = events.find((event) => {
      return (
        event.eventType === "input.prompt" && event.runId === forwarded.runId
      );
    })?.id;
    if (!eventId) {
      throw new Error("Expected the forwarded input event");
    }

    const created = await accept(
      client().create({
        params: { threadId: targetThread.id },
        headers: authenticate(actor),
        body: { eventIds: [eventId] },
      }),
      [201],
    );
    await flushWaitUntilForTest();
    const shared = await accept(
      client().get({ params: { id: created.body.id } }),
      [200],
    );
    expect(shared.body.messages).toStrictEqual([
      {
        messageIndex: 0,
        role: "user",
        content: `The user quoted this part of your reply:\n\n> ${quote}`,
        runIndex: 0,
      },
    ]);
    const publicData = JSON.stringify(shared.body);
    for (const privateValue of [
      sourceTitle,
      source.runId,
      source.threadId,
      agent.agentId,
      mailId,
      sentId,
    ]) {
      expect(publicData).not.toContain(privateValue);
    }
  });

  it.each(["ingest", "flush", "phase-abort"] as const)(
    "preserves a valid share when telemetry %s fails",
    async (mode) => {
      const fixture = await prepareShare();
      mockGoogleText();
      server.use(
        http.post(endpoint, () => {
          return new HttpResponse(null, { status: 429 });
        }),
      );
      if (mode === "phase-abort") {
        mockAxiomSdkTelemetryFailure({
          mode: "ingest",
          eventTypes: ["shared_thread_phase"],
          error: new DOMException("Telemetry cancelled", "AbortError"),
        });
      } else {
        mockAxiomSdkTelemetryFailure({ mode });
      }
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
    },
  );

  it("preserves API owner cancellation before the provider completes", async () => {
    const fixture = await prepareShare();
    const controller = new AbortController();
    const reason = new DOMException("API owner cancelled", "AbortError");
    const entered = createDeferredPromise<AbortSignal>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    const returned = createDeferredPromise<void>(context.signal);
    mockGoogleText();
    server.use(
      http.post(endpoint, async ({ request }) => {
        entered.resolve(request.signal);
        await release.promise;
        returned.resolve(undefined);
        return completion();
      }),
    );
    const request = client(true, controller.signal).create(
      requestBody(fixture),
    );
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
      { status: "rejected", reason },
    ]);
    expect(providerSignal.aborted).toBeTruthy();
    expect(providerSignal.reason).toBe(reason);
    await expectNoShare(fixture);
    release.resolve(undefined);
    await returned.promise;
    await flushWaitUntilForTest();
    await expectNoShare(fixture);
  });

  it("keeps authentication, ownership and selection failures outside optional generation", async () => {
    const fixture = await prepareShare();
    mockGoogleText();
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
    const unknown = await accept(
      client().create({
        ...requestBody(fixture),
        body: { eventIds: [randomUUID()] },
      }),
      [400],
    );
    expect(unknown.body.error.code).toBe("NO_SHAREABLE_MESSAGES");
    await expectNoShare(fixture);
  });

  it("rejects oversized selections before title generation", async () => {
    const fixture = await prepareShare("A".repeat(2 * 1024 * 1024));
    mockGoogleText();
    const response = await accept(client().create(requestBody(fixture)), [413]);
    expect(response.body.error.code).toBe("SHARED_THREAD_TOO_LARGE");
    await expectNoShare(fixture);
  });
});

describe("client-generated shared-thread IDs", () => {
  it("publishes the share under the ID the client already copied", async () => {
    const fixture = await prepareShare();
    const id = randomUUID();
    const created = await accept(
      client().create({
        ...requestBody(fixture),
        body: { eventIds: [fixture.eventId], id },
      }),
      [201],
    );
    expect(created.body.id).toBe(id);
    await flushWaitUntilForTest();
    await expectSharedSnapshot(fixture, id, "Shared conversation");
  });

  it("rejects an ID that already names another user's share without touching it", async () => {
    const owner = await prepareShare();
    const existing = await accept(client().create(requestBody(owner)), [201]);
    await flushWaitUntilForTest();
    const intruder = await prepareShare("Intruder content");
    const response = await accept(
      client().create({
        ...requestBody(intruder),
        body: { eventIds: [intruder.eventId], id: existing.body.id },
      }),
      [409],
    );
    expect(response.body.error.code).toBe("CONFLICT");
    await expectSharedSnapshot(owner, existing.body.id, "Shared conversation");
    await expectNoShare(intruder);
  });
});

function conversationMembers(actor: ApiTestUser) {
  const organization = { id: actor.orgId, name: "Original workspace" };
  const members = new Set([actor.userId]);
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
    (input) => {
      const request = object({
        organizationId: string(),
        userId: array(string()),
      }).parse(input);
      return Promise.resolve({
        data:
          request.organizationId === actor.orgId
            ? request.userId
                .filter((id) => {
                  return members.has(id);
                })
                .map((id) => {
                  return {
                    publicUserData: { userId: id },
                    organization,
                    role: "org:member",
                  };
                })
            : [],
        totalCount: members.size,
      });
    },
  );
  return members;
}

function visibilityClient() {
  return setupApp({ context, routes: sharedThreadRoutes })(
    sharedThreadVisibilityContract,
  );
}

describe("conversation share visibility", () => {
  it("creates a private snapshot without publishing its content or title", async () => {
    const f = await prepareShare();
    installSharedThreadStorage(context);
    conversationMembers(f.actor);
    await device.updateFeatureSwitches(f.actor, {
      [FeatureSwitchKey.SharedThreadVisibility]: true,
    });
    const created = await accept(
      visibilityClient().create({
        ...requestBody(f),
        body: {
          eventIds: [f.eventId],
          id: randomUUID().toUpperCase(),
          audience: "private",
        },
      }),
      [201],
    );
    const id = created.body.id;
    const anonymous = await accept(client().get({ params: { id } }), [404]);
    expect(JSON.stringify(anonymous.body)).not.toContain(f.content);
    expect(anonymous.headers.get("cache-control")).toBe("no-store");
    const meta = await accept(client().meta({ params: { id } }), [404]);
    expect(meta.headers.get("cache-control")).toBe("no-store");
    const ownerView = await accept(
      client().get({ params: { id }, headers: authenticate(f.actor) }),
      [200],
    );
    expect(ownerView.body.messages[0]?.content).toBe(f.content);
    const stranger = bdd.user();
    await accept(
      client().get({ params: { id }, headers: authenticate(stranger) }),
      [404],
    );
    await accept(
      visibilityClient().get({
        params: { id },
        headers: authenticate(stranger),
      }),
      [403, 404],
    );
  });

  it("changes an existing text-only link and checks membership in its original workspace on every read", async () => {
    const f = await prepareShare();
    installSharedThreadStorage(context);
    const members = conversationMembers(f.actor);
    const created = await accept(client().create(requestBody(f)), [201]);
    const id = created.body.id;
    await device.updateFeatureSwitches(f.actor, {
      [FeatureSwitchKey.SharedThreadVisibility]: true,
    });
    const status = await accept(
      visibilityClient().get({
        params: { id },
        headers: authenticate(f.actor),
      }),
      [200],
    );
    expect(status.body.audience).toBe("public");
    const updated = await accept(
      visibilityClient().update({
        params: { id: id.toUpperCase() },
        headers: authenticate(f.actor),
        body: {
          audience: "organization",
          expectedRevision: status.body.revision,
        },
      }),
      [200],
    );
    expect(updated.body.organization).toStrictEqual({
      id: f.actor.orgId,
      name: "Original workspace",
    });
    await accept(client().get({ params: { id } }), [404]);
    await accept(client().meta({ params: { id } }), [404]);
    const recipient = bdd.user();
    members.add(recipient.userId);
    const received = await accept(
      client().get({ params: { id }, headers: authenticate(recipient) }),
      [200],
    );
    expect(received.body.messages[0]?.content).toBe(f.content);
    members.delete(recipient.userId);
    await accept(
      client().get({ params: { id }, headers: authenticate(recipient) }),
      [404],
    );
    const privateResult = await accept(
      visibilityClient().update({
        params: { id },
        headers: authenticate(f.actor),
        body: { audience: "private", expectedRevision: updated.body.revision },
      }),
      [200],
    );
    members.add(recipient.userId);
    await accept(
      client().get({ params: { id }, headers: authenticate(recipient) }),
      [404],
    );
    await accept(
      visibilityClient().update({
        params: { id },
        headers: authenticate(f.actor),
        body: {
          audience: "public",
          expectedRevision: privateResult.body.revision,
        },
      }),
      [200],
    );
    const publicView = await accept(client().get({ params: { id } }), [200]);
    expect(publicView.body.messages).toStrictEqual(received.body.messages);
  });

  it("rejects stale edits and keeps restrictions when visibility management is disabled", async () => {
    const f = await prepareShare();
    installSharedThreadStorage(context);
    conversationMembers(f.actor);
    await device.updateFeatureSwitches(f.actor, {
      [FeatureSwitchKey.SharedThreadVisibility]: true,
    });
    const created = await accept(
      visibilityClient().create({
        ...requestBody(f),
        body: { eventIds: [f.eventId], audience: "organization" },
      }),
      [201],
    );
    const id = created.body.id;
    const status = await accept(
      visibilityClient().get({
        params: { id },
        headers: authenticate(f.actor),
      }),
      [200],
    );
    const next = await accept(
      visibilityClient().update({
        params: { id },
        headers: authenticate(f.actor),
        body: { audience: "private", expectedRevision: status.body.revision },
      }),
      [200],
    );
    await accept(
      visibilityClient().update({
        params: { id },
        headers: authenticate(f.actor),
        body: { audience: "public", expectedRevision: status.body.revision },
      }),
      [409],
    );
    const other = bdd.user();
    await device.updateFeatureSwitches(other, {
      [FeatureSwitchKey.SharedThreadVisibility]: true,
    });
    await accept(
      visibilityClient().update({
        params: { id },
        headers: authenticate(other),
        body: { audience: "public", expectedRevision: next.body.revision },
      }),
      [404],
    );
    routeMocks.clerk.session(f.actor.userId, other.orgId);
    await accept(
      visibilityClient().update({
        params: { id },
        headers: { authorization: "Bearer clerk-session" },
        body: { audience: "public", expectedRevision: next.body.revision },
      }),
      [403, 404],
    );
    await device.updateFeatureSwitches(f.actor, {
      [FeatureSwitchKey.SharedThreadVisibility]: false,
    });
    await accept(
      visibilityClient().update({
        params: { id },
        headers: authenticate(f.actor),
        body: { audience: "public", expectedRevision: next.body.revision },
      }),
      [403],
    );
    await accept(
      visibilityClient().create({
        ...requestBody(f),
        body: { eventIds: [f.eventId], audience: "private" },
      }),
      [403],
    );
    await accept(client().get({ params: { id } }), [404]);
    const ownerView = await accept(
      client().get({ params: { id }, headers: authenticate(f.actor) }),
      [200],
    );
    expect(ownerView.body.messages[0]?.content).toBe(f.content);
  });
});
