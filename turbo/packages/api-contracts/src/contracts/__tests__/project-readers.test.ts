import { describe, expect, it } from "vitest";
import {
  chatThreadEventSchema,
  userMessageDocumentSchema,
} from "../chat-threads";
import {
  projectAwareChatThreadEventSchema,
  projectAwareUserMessageDocumentSchema,
} from "../project-readers";

const projectId = "00000000-0000-4000-8000-000000000071";
const event = {
  id: "00000000-0000-4000-8000-000000000001",
  seqId: 4,
  chatThreadId: "00000000-0000-4000-8000-000000000002",
  agentId: "00000000-0000-4000-8000-000000000003",
  kind: "project_updated",
  projectId,
  title: null,
  createdAt: "2026-11-02T00:00:00.000Z",
};

describe("prepared Project readers", () => {
  it("reads explicit assignment and unassignment while the published server enum remains legacy", () => {
    expect(projectAwareChatThreadEventSchema.parse(event)).toMatchObject({
      kind: "project_updated",
      projectId,
    });
    expect(
      projectAwareChatThreadEventSchema.parse({ ...event, projectId: null }),
    ).toMatchObject({ projectId: null });
    // Release 1 must remain compatible with the installed iOS response reader.
    expect(chatThreadEventSchema.safeParse(event).success).toBe(false);
    expect(
      chatThreadEventSchema.parse({ ...event, kind: "renamed" }),
    ).toMatchObject({ kind: "renamed" });
  });

  it("keeps reference identity and saved names visible without rewriting raw history", () => {
    const reference = {
      type: "project",
      projectId,
      nameSnapshot: "Original launch",
    };
    const document = {
      version: 1,
      parts: [
        { type: "text", text: "Review " },
        reference,
        { type: "feedback", quote: "Check this", note: [reference] },
      ],
    };
    const before = structuredClone(document);
    const parsed = projectAwareUserMessageDocumentSchema.parse(document);
    expect(parsed.parts).toEqual([
      { type: "text", text: "Review " },
      { type: "text", text: `[Original launch](/projects/${projectId})` },
      {
        type: "feedback",
        quote: "Check this",
        note: [
          { type: "text", text: `[Original launch](/projects/${projectId})` },
        ],
      },
    ]);
    expect(document).toEqual(before);
    expect(userMessageDocumentSchema.parse(parsed)).toEqual(parsed);
  });

  it("rejects malformed clipboard references through safeParse without throwing", () => {
    expect(
      projectAwareUserMessageDocumentSchema.safeParse({
        version: 1,
        parts: [
          { type: "project", projectId: "not-an-id", nameSnapshot: "Launch" },
        ],
      }).success,
    ).toBe(false);
  });
});
