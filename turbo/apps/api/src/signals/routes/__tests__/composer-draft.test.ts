import { randomUUID } from "node:crypto";

import {
  CLIENT_TYPE_ANDROID,
  CLIENT_TYPE_IOS,
  CLIENT_TYPE_HEADER,
  CLIENT_VERSION_HEADER,
} from "@okouai/api-contracts/contracts/client-headers";
import { composerDraftContract } from "@okouai/api-contracts/contracts/composer-draft";
import type { infer as zInfer } from "zod";
import type { userMessageInputDocumentSchema } from "@okouai/api-contracts/validators/chat-threads";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createRouteMocks } from "./helpers/route-test";
import { composerDraftRoutes } from "../composer-draft";

type UserMessageInputDocument = zInfer<typeof userMessageInputDocumentSchema>;

const context = testContext();
const mocks = createRouteMocks(context);
const CLIENT_VERSION = "0.734.0";

function authHeaders(version = CLIENT_VERSION) {
  return {
    authorization: "Bearer clerk-session",
    [CLIENT_VERSION_HEADER]: version,
  };
}

function draftsClient() {
  return setupApp({ context, routes: composerDraftRoutes })(
    composerDraftContract,
  );
}

describe("GET/PATCH /api/chat-drafts/composer", () => {
  it("returns an empty draft when none is saved", async () => {
    const fixture = {
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    };
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      draftsClient().get({
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      draftUserMessage: null,
      draftAttachments: null,
    });
  });

  it("stores and clears the current user's composer draft", async () => {
    const fixture = {
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    };
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const attachment = {
      id: randomUUID(),
      url: "https://cdn.example.com/draft-file.txt",
      filename: "draft-file.txt",
      contentType: "text/plain",
      size: 123,
    };
    const recordingId = randomUUID();
    const draftUserMessage: UserMessageInputDocument = {
      version: 1,
      parts: [
        {
          type: "file",
          fileId: attachment.id,
          filenameSnapshot: attachment.filename,
          contentType: attachment.contentType,
        },
        { type: "voice", clips: [{ fileId: recordingId }] },
        { type: "text", text: "draft text" },
        {
          type: "feedback",
          quote: "draft text",
          note: [{ type: "text", text: "Tighten this draft." }],
          eventId: "draft-feedback-event",
          range: { start: 0, end: 10 },
        },
        {
          type: "feedback",
          quote: "Artifact passage",
          note: [],
          source: {
            type: "artifact",
            fileId: randomUUID(),
            filenameSnapshot: "brief.md",
            artifactId: randomUUID(),
          },
        },
        {
          type: "feedback",
          quote: "Email passage",
          note: [],
          source: {
            type: "mail",
            id: randomUUID(),
            status: "sent",
            sentId: `gmail-${randomUUID()}`,
          },
        },
      ],
    };

    await accept(
      draftsClient().patch({
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
        headers: authHeaders(),
      }),
      [200],
    );
    expect(saved.body).toStrictEqual({
      draftUserMessage,
      draftAttachments: [attachment],
    });

    for (const client of [CLIENT_TYPE_IOS, CLIENT_TYPE_ANDROID]) {
      const native = await accept(
        draftsClient().get({
          headers: authHeaders("0.69.0"),
          extraHeaders: { [CLIENT_TYPE_HEADER]: client },
        }),
        [200],
      );
      expect(native.body.draftUserMessage).toStrictEqual(draftUserMessage);
    }

    const updatedDraftUserMessage: UserMessageInputDocument = {
      version: 1,
      parts: [{ type: "text", text: "updated draft text" }],
    };
    await accept(
      draftsClient().patch({
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
    const fixture = {
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    };
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const draftUserMessage: UserMessageInputDocument = {
      version: 1,
      parts: [{ type: "text", text: "saved draft" }],
    };
    await accept(
      draftsClient().patch({
        headers: authHeaders(),
        body: { draftUserMessage, draftAttachments: null },
      }),
      [204],
    );

    const invalid = await accept(
      draftsClient().patch({
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
    const fixture = {
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    };
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
            headers: authHeaders(),
            body: { draftUserMessage, draftAttachments: null },
          }),
          [204],
        );
      }),
    );

    const saved = await accept(
      draftsClient().get({
        headers: authHeaders(),
      }),
      [200],
    );
    expect(concurrentDrafts).toContainEqual(saved.body.draftUserMessage);
    expect(saved.body.draftAttachments).toBeNull();
  });

  it("does not expose another user's draft on the same workspace", async () => {
    const fixture = {
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    };
    mocks.clerk.session(fixture.userId, fixture.orgId);

    await accept(
      draftsClient().patch({
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
