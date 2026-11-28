import { randomUUID } from "node:crypto";
import type { input } from "zod";
import { composerDraftContract } from "@okouai/api-contracts/contracts/composer-draft";
import type { UserMessageInputDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { composerDraftRoutes } from "../composer-draft";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

interface Member {
  readonly userId: string;
  readonly orgId: string;
}

function newMember(orgId = `org_${randomUUID()}`): Member {
  return { userId: `user_${randomUUID()}`, orgId };
}

function drafts(member: Member) {
  createRouteMocks(context).clerk.session(member.userId, member.orgId);
  return setupApp({ context, routes: composerDraftRoutes })(
    composerDraftContract,
  );
}

function readDraft(member: Member) {
  return accept(drafts(member).get({ headers }), [200]);
}

function saveDraft(
  member: Member,
  body: input<typeof composerDraftContract.patch.body>,
) {
  return drafts(member).patch({ headers, body });
}

function textDocument(text: string): UserMessageInputDocument {
  return { version: 1, parts: [{ type: "text", text }] };
}

test("composer-draft-002 stores, replaces and clears the member's composer draft", async () => {
  const member = newMember();
  const fileId = randomUUID();
  const clipId = randomUUID();
  const attachment = {
    id: fileId,
    url: "https://cdn.example.test/artifacts/plan.pdf",
    filename: "plan.pdf",
    contentType: "application/pdf",
    size: 4096,
  };
  const filePart = {
    type: "file" as const,
    fileId,
    filenameSnapshot: "plan.pdf",
    contentType: "application/pdf",
  };
  const feedbackParts = [
    {
      type: "feedback" as const,
      quote: "the earlier answer",
      note: [{ type: "text" as const, text: "Shorter please" }],
      eventId: randomUUID(),
      range: { start: 0, end: 10 },
    },
    {
      type: "feedback" as const,
      quote: "slide two",
      note: [{ type: "text" as const, text: "Use a chart" }],
      source: {
        type: "artifact" as const,
        fileId: randomUUID(),
        filenameSnapshot: "deck.pptx",
        artifactId: randomUUID(),
      },
    },
    {
      type: "feedback" as const,
      quote: "Dear team",
      note: [{ type: "text" as const, text: "Warmer greeting" }],
      source: {
        type: "mail" as const,
        id: randomUUID(),
        status: "sent" as const,
        sentId: randomUUID(),
      },
    },
  ];
  const document: UserMessageInputDocument = {
    version: 1,
    parts: [
      filePart,
      { type: "voice", clips: [{ fileId: clipId }] },
      { type: "text", text: "Review the plan" },
      ...feedbackParts,
    ],
  };

  await accept(
    saveDraft(member, {
      draftUserMessage: document,
      draftAttachments: [attachment],
    }),
    [204],
  );

  const ordinary = await readDraft(member);
  expect(ordinary.body).toStrictEqual({
    draftUserMessage: document,
    draftAttachments: [attachment],
  });

  await accept(
    saveDraft(member, { draftUserMessage: textDocument("Just text now") }),
    [204],
  );
  const replaced = await readDraft(member);
  expect(replaced.body).toStrictEqual({
    draftUserMessage: textDocument("Just text now"),
    draftAttachments: null,
  });

  await accept(saveDraft(member, { draftUserMessage: null }), [204]);
  const cleared = await readDraft(member);
  expect(cleared.body).toStrictEqual({
    draftUserMessage: null,
    draftAttachments: null,
  });
});

test("composer-draft-003 rejects attachments without a message and keeps the saved draft", async () => {
  const member = newMember();
  await accept(
    saveDraft(member, { draftUserMessage: textDocument("Keep me") }),
    [204],
  );

  await accept(
    saveDraft(member, {
      draftUserMessage: null,
      draftAttachments: [
        {
          id: randomUUID(),
          url: "https://cdn.example.test/artifacts/photo.png",
          filename: "photo.png",
          contentType: "image/png",
          size: 512,
        },
      ],
    }),
    [400],
  );

  const readback = await readDraft(member);
  expect(readback.body).toStrictEqual({
    draftUserMessage: textDocument("Keep me"),
    draftAttachments: null,
  });
});

test("composer-draft-005 keeps each member's draft private within one workspace", async () => {
  const first = newMember();
  const second = newMember(first.orgId);
  await accept(
    saveDraft(first, { draftUserMessage: textDocument("First member draft") }),
    [204],
  );

  const initial = await readDraft(second);
  expect(initial.body).toStrictEqual({
    draftUserMessage: null,
    draftAttachments: null,
  });

  await accept(
    saveDraft(second, {
      draftUserMessage: textDocument("Second member draft"),
    }),
    [204],
  );

  const firstRead = await readDraft(first);
  const secondRead = await readDraft(second);
  expect(firstRead.body).toStrictEqual({
    draftUserMessage: textDocument("First member draft"),
    draftAttachments: null,
  });
  expect(secondRead.body).toStrictEqual({
    draftUserMessage: textDocument("Second member draft"),
    draftAttachments: null,
  });
});
