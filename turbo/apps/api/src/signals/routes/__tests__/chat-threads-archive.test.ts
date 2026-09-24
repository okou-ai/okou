import { randomUUID } from "node:crypto";
import {
  chatThreadArchiveContract,
  chatThreadMetadataContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { chatThreadArchiveRoutes } from "../chat-threads-archive";
import { chatThreadGetRoutes } from "../chat-threads-get";

const context = testContext();
const store = createStore();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);

async function seedChatThread(title: string, archivingEnabled = true) {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  const agent = await bdd.createAgent(actor, {
    displayName: "Chat thread archive agent",
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
  if (archivingEnabled) {
    await updateFeatureSwitchesForUser(
      context,
      { userId: actor.userId, orgId: actor.orgId, orgRole: actor.orgRole },
      { [FeatureSwitchKey.ChatThreadArchiving]: true },
    );
  }
  return { actor, orgId: actor.orgId, threadId: thread.id };
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

function archiveClient() {
  return setupApp({ context, routes: chatThreadArchiveRoutes })(
    chatThreadArchiveContract,
  );
}

async function readMetadata(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly threadId: string;
}) {
  const client = setupApp({ context, routes: chatThreadGetRoutes })(
    chatThreadMetadataContract,
  );
  const response = await accept(
    client.get({
      headers: {
        authorization: `Bearer ${okouToken({
          userId: args.userId,
          orgId: args.orgId,
          capabilities: ["chat-thread:read"],
        })}`,
      },
      params: { id: args.threadId },
    }),
    [200],
  );
  return response.body;
}

describe("POST /api/chat-threads/:id/archive and /unarchive", () => {
  it("toggles the archived flag and thread events without touching the title", async () => {
    const fixture = await seedChatThread("✅ Launch plan");
    const owner = {
      userId: fixture.actor.userId,
      orgId: fixture.orgId,
      threadId: fixture.threadId,
    };
    await expect(readMetadata(owner)).resolves.toMatchObject({
      title: "✅ Launch plan",
      archived: false,
    });

    const headers = {
      authorization: `Bearer ${okouToken({
        userId: owner.userId,
        orgId: owner.orgId,
        capabilities: ["chat-thread:write"],
      })}`,
    };
    const archiveEventId = randomUUID();
    await accept(
      archiveClient().archive({
        headers,
        params: { id: fixture.threadId },
        query: { eventId: archiveEventId },
      }),
      [204],
    );
    // Archiving an archived thread stays a successful no-op for the flag.
    await accept(
      archiveClient().archive({ headers, params: { id: fixture.threadId } }),
      [204],
    );
    await expect(readMetadata(owner)).resolves.toMatchObject({
      title: "✅ Launch plan",
      archived: true,
    });

    const unarchiveEventId = randomUUID();
    await accept(
      archiveClient().unarchive({
        headers,
        params: { id: fixture.threadId },
        query: { eventId: unarchiveEventId },
      }),
      [204],
    );
    await expect(readMetadata(owner)).resolves.toMatchObject({
      title: "✅ Launch plan",
      archived: false,
    });

    const events = await chat.requestThreadEvents(fixture.actor, {}, [200]);
    if (events.status !== 200) {
      throw new Error("Expected thread events");
    }
    expect(
      events.body.events
        .filter((event) => {
          return event.chatThreadId === fixture.threadId;
        })
        .map((event) => {
          return { id: event.id, kind: event.kind };
        }),
    ).toStrictEqual(
      expect.arrayContaining([
        { id: archiveEventId, kind: "archived" },
        { id: unarchiveEventId, kind: "unarchived" },
      ]),
    );
  });

  it("is unavailable while chat thread archiving is switched off", async () => {
    const fixture = await seedChatThread("Launch plan", false);
    const headers = {
      authorization: `Bearer ${okouToken({
        userId: fixture.actor.userId,
        orgId: fixture.orgId,
        capabilities: ["chat-thread:write"],
      })}`,
    };
    for (const request of [
      archiveClient().archive({ headers, params: { id: fixture.threadId } }),
      archiveClient().unarchive({ headers, params: { id: fixture.threadId } }),
    ]) {
      const response = await accept(request, [404]);
      expect(response.body).toStrictEqual({
        error: {
          code: "NOT_FOUND",
          message: "Chat thread archiving is not available",
        },
      });
    }
    await expect(
      readMetadata({
        userId: fixture.actor.userId,
        orgId: fixture.orgId,
        threadId: fixture.threadId,
      }),
    ).resolves.toMatchObject({ archived: false });
  });

  it("rejects an Okou run token without chat-thread:write", async () => {
    const fixture = await seedChatThread("Launch plan");
    const response = await accept(
      archiveClient().archive({
        headers: {
          authorization: `Bearer ${okouToken({
            userId: fixture.actor.userId,
            orgId: fixture.orgId,
            capabilities: ["chat-thread:read"],
          })}`,
        },
        params: { id: fixture.threadId },
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

  it("does not archive a same-user thread from another org", async () => {
    const fixture = await seedChatThread("Launch plan");
    const otherOrgId = `org_${randomUUID()}`;
    await store.set(
      seedOrgMembership$,
      { orgId: otherOrgId, userId: fixture.actor.userId },
      context.signal,
    );

    const response = await accept(
      archiveClient().archive({
        headers: {
          authorization: `Bearer ${okouToken({
            userId: fixture.actor.userId,
            orgId: otherOrgId,
            capabilities: ["chat-thread:write"],
          })}`,
        },
        params: { id: fixture.threadId },
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { code: "NOT_FOUND", message: "Chat thread not found" },
    });
    await expect(
      readMetadata({
        userId: fixture.actor.userId,
        orgId: fixture.orgId,
        threadId: fixture.threadId,
      }),
    ).resolves.toMatchObject({ archived: false });
  });
});
