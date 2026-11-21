import { expect, it } from "vitest";
import { legacyThreadDraftTransforms } from "../member-chat-drafts";

it.each(legacyThreadDraftTransforms)(
  "renders an unbound Run reference as readable text for $client",
  ({ transform }) => {
    const id = "f1000000-0000-4000-8000-000000000001";
    const source = {
      type: "source",
      kind: "agent",
      threadId: id,
      runId: id,
      titleSnapshot: "Review",
      href: `/chats/${id}`,
    };
    const draft = {
      draftAttachments: null,
      draftUserMessage: { version: 1, parts: [source] },
    };
    expect(transform(draft)).toEqual({
      ...draft,
      draftUserMessage: {
        version: 1,
        parts: [{ type: "text", text: `Review (/chats/${id})` }],
      },
    });
  },
);
