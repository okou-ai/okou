import { randomUUID } from "node:crypto";

import { CLIENT_VERSION_HEADER } from "@okouai/api-contracts/contracts/client-headers";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import type { UserMessageInputDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createBddApi } from "./helpers/api-bdd";
import { createRouteMocks } from "./helpers/route-test";
import { agentDraftRoutes } from "../agent-draft";

const context = testContext();
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);

interface AgentDraftFixture {
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
}

/** Creates an agent through the product routes. */
async function seedAgent(): Promise<AgentDraftFixture> {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  const agent = await bdd.createAgent(actor, {
    displayName: "Agent draft agent",
  });
  if (!actor.orgId) {
    throw new Error("Expected the seeded actor to belong to an org");
  }
  return { userId: actor.userId, orgId: actor.orgId, agentId: agent.agentId };
}

const CLIENT_VERSION = "0.734.0";

function authHeaders() {
  return {
    authorization: "Bearer clerk-session",
    [CLIENT_VERSION_HEADER]: CLIENT_VERSION,
  };
}

function draftsClient() {
  return setupApp({ context, routes: agentDraftRoutes })(agentDraftContract);
}

describe("GET/PATCH /api/agents/:id/draft", () => {
  it("returns an empty draft when none is saved", async () => {
    const fixture = await seedAgent();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      draftsClient().get({
        params: { id: fixture.agentId },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      draftUserMessage: null,
      draftAttachments: null,
    });
  });

  it("stores and clears the current user's agent draft", async () => {
    const fixture = await seedAgent();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const attachment = {
      id: randomUUID(),
      url: "https://cdn.example.com/draft-file.txt",
      filename: "draft-file.txt",
      contentType: "text/plain",
      size: 123,
    };
    const draftUserMessage: UserMessageInputDocument = {
      version: 1,
      parts: [
        {
          type: "file",
          fileId: attachment.id,
          filenameSnapshot: attachment.filename,
          contentType: attachment.contentType,
        },
        { type: "text", text: "draft text" },
        {
          type: "feedback",
          quote: "draft text",
          note: [{ type: "text", text: "Tighten this draft." }],
          eventId: "draft-feedback-event",
          range: { start: 0, end: 10 },
        },
      ],
    };

    await accept(
      draftsClient().patch({
        params: { id: fixture.agentId },
        headers: authHeaders(),
        body: {
          draftUserMessage,
          draftAttachments: [attachment],
        },
      }),
      [204],
    );

    const saved = await accept(
      draftsClient().get({
        params: { id: fixture.agentId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(saved.body).toStrictEqual({
      draftUserMessage,
      draftAttachments: [attachment],
    });

    const updatedDraftUserMessage: UserMessageInputDocument = {
      version: 1,
      parts: [{ type: "text", text: "updated draft text" }],
    };
    await accept(
      draftsClient().patch({
        params: { id: fixture.agentId },
        headers: authHeaders(),
        body: {
          draftUserMessage: updatedDraftUserMessage,
          draftAttachments: null,
        },
      }),
      [204],
    );

    const updated = await accept(
      draftsClient().get({
        params: { id: fixture.agentId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(updated.body).toStrictEqual({
      draftUserMessage: updatedDraftUserMessage,
      draftAttachments: null,
    });

    await accept(
      draftsClient().patch({
        params: { id: fixture.agentId },
        headers: authHeaders(),
        body: {
          draftUserMessage: null,
          draftAttachments: null,
        },
      }),
      [204],
    );

    const cleared = await accept(
      draftsClient().get({
        params: { id: fixture.agentId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(cleared.body).toStrictEqual({
      draftUserMessage: null,
      draftAttachments: null,
    });
  });

  it("rejects attachments without a message and preserves the saved draft", async () => {
    const fixture = await seedAgent();
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const draftUserMessage: UserMessageInputDocument = {
      version: 1,
      parts: [{ type: "text", text: "saved draft" }],
    };
    await accept(
      draftsClient().patch({
        params: { id: fixture.agentId },
        headers: authHeaders(),
        body: { draftUserMessage, draftAttachments: null },
      }),
      [204],
    );

    const invalid = await accept(
      draftsClient().patch({
        params: { id: fixture.agentId },
        headers: authHeaders(),
        body: {
          draftUserMessage: null,
          draftAttachments: [
            {
              id: randomUUID(),
              url: "https://cdn.example.com/draft-file.txt",
              filename: "draft-file.txt",
              contentType: "text/plain",
              size: 123,
            },
          ],
        },
      }),
      [400],
    );
    expect(invalid.status).toBe(400);
    const saved = await accept(
      draftsClient().get({
        params: { id: fixture.agentId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(saved.body).toStrictEqual({
      draftUserMessage,
      draftAttachments: null,
    });
  });

  it("converges concurrent first writes without exposing a conflict", async () => {
    const fixture = await seedAgent();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const concurrentDrafts: UserMessageInputDocument[] = [
      {
        version: 1,
        parts: [{ type: "text", text: "concurrent draft A" }],
      },
      {
        version: 1,
        parts: [{ type: "text", text: "concurrent draft B" }],
      },
    ];

    await Promise.all(
      concurrentDrafts.map(async (draftUserMessage) => {
        await accept(
          draftsClient().patch({
            params: { id: fixture.agentId },
            headers: authHeaders(),
            body: { draftUserMessage, draftAttachments: null },
          }),
          [204],
        );
      }),
    );

    const saved = await accept(
      draftsClient().get({
        params: { id: fixture.agentId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(concurrentDrafts).toContainEqual(saved.body.draftUserMessage);
    expect(saved.body.draftAttachments).toBeNull();
  });

  it("does not expose another user's draft on the same public agent", async () => {
    const fixture = await seedAgent();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    await accept(
      draftsClient().patch({
        params: { id: fixture.agentId },
        headers: authHeaders(),
        body: {
          draftUserMessage: {
            version: 1,
            parts: [{ type: "text", text: "owner draft" }],
          },
          draftAttachments: null,
        },
      }),
      [204],
    );

    const peerUserId = `user_${randomUUID()}`;
    mocks.clerk.session(peerUserId, fixture.orgId, "org:member");

    const peerDraft = await accept(
      draftsClient().get({
        params: { id: fixture.agentId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(peerDraft.body).toStrictEqual({
      draftUserMessage: null,
      draftAttachments: null,
    });

    const peerDraftUserMessage: UserMessageInputDocument = {
      version: 1,
      parts: [{ type: "text", text: "peer draft" }],
    };
    await accept(
      draftsClient().patch({
        params: { id: fixture.agentId },
        headers: authHeaders(),
        body: {
          draftUserMessage: peerDraftUserMessage,
          draftAttachments: null,
        },
      }),
      [204],
    );

    const savedPeerDraft = await accept(
      draftsClient().get({
        params: { id: fixture.agentId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(savedPeerDraft.body).toStrictEqual({
      draftUserMessage: peerDraftUserMessage,
      draftAttachments: null,
    });

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const ownerDraft = await accept(
      draftsClient().get({
        params: { id: fixture.agentId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(ownerDraft.body).toStrictEqual({
      draftUserMessage: {
        version: 1,
        parts: [{ type: "text", text: "owner draft" }],
      },
      draftAttachments: null,
    });
  });
});
