import { randomUUID } from "node:crypto";

import {
  chatThreadImageModelContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { chatThreadRoutes } from "../chat-threads";
import { chatThreadImageModelRoutes } from "../chat-threads-image-model";

const context = testContext();
const store = createStore();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const api = createRunsApi(context);

interface ChatThreadFixture {
  readonly userId: string;
  readonly orgId: string;
  readonly threadId: string;
}

async function seedChatThread(title: string): Promise<ChatThreadFixture> {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  const { providerId } = await api.ensureOrgModelProvider(actor);
  await api.updateOrgModelPolicies(actor, [
    {
      model: "claude-sonnet-5",
      isDefault: true,
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      modelProviderId: providerId,
    },
  ]);
  const agent = await bdd.createAgent(actor, {
    displayName: "Chat thread image model agent",
    visibility: "private",
  });
  const thread = await chat.createThread(actor, {
    agentId: agent.agentId,
    title,
    model: "claude-sonnet-5",
  });
  if (!actor.orgId) {
    throw new Error("Expected the seeded actor to belong to an org");
  }
  await store.set(
    seedOrgMembership$,
    { orgId: actor.orgId, userId: actor.userId },
    context.signal,
  );
  return { userId: actor.userId, orgId: actor.orgId, threadId: thread.id };
}

function okouToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly capabilities: readonly Capability[];
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "okou",
    userId: args.userId,
    orgId: args.orgId,
    runId: `run_${randomUUID()}`,
    capabilities: [...args.capabilities],
    iat: seconds,
    exp: seconds + 600,
  });
}

function imageModelClient() {
  return setupApp({ context, routes: chatThreadImageModelRoutes })(
    chatThreadImageModelContract,
  );
}

function threadsClient() {
  return setupApp({ context, routes: chatThreadRoutes })(chatThreadsContract);
}

function rawImageModelRequest(
  threadId: string,
  token: string,
  body: Record<string, unknown>,
) {
  return setupRawAppRequest({
    context,
    routes: chatThreadImageModelRoutes,
  })(`/api/chat-threads/${threadId}/image-model`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function readImageModelEvents(token: string) {
  const response = await accept(
    threadsClient().events({
      headers: { authorization: `Bearer ${token}` },
      query: {},
    }),
    [200],
  );
  if (!("events" in response.body)) {
    throw new Error("Expected the event page");
  }
  return response.body.events.filter((event) => {
    return event.kind === "image_model_updated";
  });
}

describe("POST /api/chat-threads/:id/image-model", () => {
  it("pins a canonical image model and records one event", async () => {
    const fixture = await seedChatThread("Product launch still");
    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
    });

    await accept(
      imageModelClient().update({
        headers: { authorization: `Bearer ${token}` },
        params: { id: fixture.threadId },
        body: { model: "fal-ai/flux-pro/v1.1" },
      }),
      [204],
    );

    await expect(readImageModelEvents(token)).resolves.toMatchObject([
      {
        chatThreadId: fixture.threadId,
        selectedImageModel: "fal-ai/flux-pro/v1.1",
      },
    ]);
  });

  it("clears the pin so resolution can fall through to defaults", async () => {
    const fixture = await seedChatThread("Product launch still");
    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
    });

    await accept(
      imageModelClient().update({
        headers: { authorization: `Bearer ${token}` },
        params: { id: fixture.threadId },
        body: { model: "gpt-image-2" },
      }),
      [204],
    );
    await accept(
      imageModelClient().update({
        headers: { authorization: `Bearer ${token}` },
        params: { id: fixture.threadId },
        body: { model: null },
      }),
      [204],
    );

    await expect(readImageModelEvents(token)).resolves.toMatchObject([
      { selectedImageModel: "gpt-image-2" },
      { selectedImageModel: null },
    ]);
  });

  it("reuses a caller event id so a retry appends once", async () => {
    const fixture = await seedChatThread("Product launch still");
    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
    });
    const eventId = randomUUID();

    for (const _attempt of [0, 1]) {
      await accept(
        imageModelClient().update({
          headers: { authorization: `Bearer ${token}` },
          params: { id: fixture.threadId },
          body: { model: "gpt-image-2", eventId },
        }),
        [204],
      );
    }

    await expect(readImageModelEvents(token)).resolves.toHaveLength(1);
  });

  it("rejects a model outside the shared image catalog", async () => {
    const fixture = await seedChatThread("Product launch still");
    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
    });

    const response = await rawImageModelRequest(fixture.threadId, token, {
      model: "birefnet",
    });

    expect(response.status).toBe(400);
    await expect(readImageModelEvents(token)).resolves.toStrictEqual([]);
  });

  it("returns 404 for a thread the caller does not own", async () => {
    const fixture = await seedChatThread("Product launch still");
    const other = await seedChatThread("Someone else's still");
    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
    });

    await accept(
      imageModelClient().update({
        headers: { authorization: `Bearer ${token}` },
        params: { id: other.threadId },
        body: { model: "gpt-image-2" },
      }),
      [404],
    );

    const otherToken = okouToken({
      userId: other.userId,
      orgId: other.orgId,
      capabilities: ["chat-thread:read"],
    });
    await expect(readImageModelEvents(otherToken)).resolves.toStrictEqual([]);
  });

  it("rejects an Okou run token without chat-thread:write", async () => {
    const fixture = await seedChatThread("Product launch still");
    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read"],
    });

    const response = await accept(
      imageModelClient().update({
        headers: { authorization: `Bearer ${token}` },
        params: { id: fixture.threadId },
        body: { model: "gpt-image-2" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        code: "FORBIDDEN",
        message: "Missing required capability: chat-thread:write",
      },
    });
  });
});
