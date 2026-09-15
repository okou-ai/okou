import { randomUUID } from "node:crypto";
import {
  chatThreadMetadataContract,
  chatThreadRenameContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import { DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL } from "@okouai/api-contracts/contracts/model-providers";
import { DEFAULT_IMAGE_MODEL } from "@okouai/core/image-model-catalog";
import { DEFAULT_VIDEO_MODEL } from "@okouai/core/video-model-catalog";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { chatThreadGetRoutes } from "../chat-threads-get";
import { chatThreadRenameRoutes } from "../chat-threads-rename";

const context = testContext();
const store = createStore();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);

interface ChatThreadFixture {
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly threadId: string;
}

/** Creates an agent and chat thread through the product routes. */
async function seedChatThread(title: string): Promise<ChatThreadFixture> {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  const agent = await bdd.createAgent(actor, {
    displayName: "Chat thread rename agent",
    visibility: "private",
  });
  const thread = await chat.createThread(actor, {
    agentId: agent.agentId,
    title,
  });
  if (!actor.orgId) {
    throw new Error("Expected the seeded actor to belong to an org");
  }
  await store.set(
    seedOrgMembership$,
    { orgId: actor.orgId, userId: actor.userId },
    context.signal,
  );
  return {
    userId: actor.userId,
    orgId: actor.orgId,
    agentId: agent.agentId,
    threadId: thread.id,
  };
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function okouToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly capabilities: readonly Capability[];
}): string {
  const seconds = currentSecond();
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

function renameClient() {
  return setupApp({ context, routes: chatThreadRenameRoutes })(
    chatThreadRenameContract,
  );
}

function metadataClient() {
  return setupApp({ context, routes: chatThreadGetRoutes })(
    chatThreadMetadataContract,
  );
}

describe("POST /api/chat-threads/:id/rename", () => {
  it("renames a thread with an Okou run token carrying chat-thread:write", async () => {
    const fixture = await seedChatThread("Original title");
    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:write"],
    });

    const response = await accept(
      renameClient().rename({
        headers: { authorization: `Bearer ${token}` },
        params: { id: fixture.threadId },
        body: { title: "CLI renamed title" },
      }),
      [204],
    );
    expect(response.status).toBe(204);

    const metadataResponse = await accept(
      metadataClient().get({
        headers: {
          authorization: `Bearer ${okouToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
            capabilities: ["chat-thread:read"],
          })}`,
        },
        params: { id: fixture.threadId },
      }),
      [200],
    );
    expect(metadataResponse.body).toStrictEqual({
      id: fixture.threadId,
      agentId: fixture.agentId,
      title: "CLI renamed title",
      pinnedAt: null,
      selectedModel: DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
      modelSettings: {},
      serviceTier: null,
      computerUseHostId: null,
      cloudBrowserEnabled: false,
      selectedVideoModel: DEFAULT_VIDEO_MODEL,
      selectedImageModel: DEFAULT_IMAGE_MODEL,
    });
  });

  it("rejects an Okou run token without chat-thread:write", async () => {
    const fixture = await seedChatThread("Original title");
    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-event:read"],
    });

    const response = await accept(
      renameClient().rename({
        headers: { authorization: `Bearer ${token}` },
        params: { id: fixture.threadId },
        body: { title: "Unauthorized title" },
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

  it("does not rename a same-user thread from another org", async () => {
    const fixture = await seedChatThread("Original title");
    const otherOrgId = `org_${randomUUID()}`;
    await store.set(
      seedOrgMembership$,
      { orgId: otherOrgId, userId: fixture.userId },
      context.signal,
    );

    const response = await accept(
      renameClient().rename({
        headers: {
          authorization: `Bearer ${okouToken({
            userId: fixture.userId,
            orgId: otherOrgId,
            capabilities: ["chat-thread:write"],
          })}`,
        },
        params: { id: fixture.threadId },
        body: { title: "Wrong org title" },
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { code: "NOT_FOUND", message: "Chat thread not found" },
    });

    const metadataResponse = await accept(
      metadataClient().get({
        headers: {
          authorization: `Bearer ${okouToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
            capabilities: ["chat-thread:read"],
          })}`,
        },
        params: { id: fixture.threadId },
      }),
      [200],
    );
    expect(metadataResponse.body.title).toBe("Original title");
  });
});
