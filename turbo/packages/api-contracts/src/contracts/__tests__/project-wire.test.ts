import { describe, expect, it } from "vitest";
import {
  chatThreadEventSchema,
  userMessageDocumentSchema,
} from "../chat-threads";
import {
  projectSchema,
  projectEventSchema,
  projectSnapshotArchiveSchema,
} from "../projects";

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

describe("Project wire contracts", () => {
  it("reads archive state while accepting snapshots cached before Project archiving", () => {
    const project = {
      id: projectId,
      name: "Launch",
      createdAt: event.createdAt,
      updatedAt: event.createdAt,
    };
    const snapshot = {
      projects: [project],
      latestEventId: event.id,
      latestSeqId: event.seqId,
    };
    expect(projectSnapshotArchiveSchema.parse(snapshot)).toEqual(snapshot);
    expect(projectSchema.parse({ ...project, archivedAt: null })).toEqual({
      ...project,
      archivedAt: null,
    });
    expect(
      projectSchema.parse({ ...project, archivedAt: event.createdAt }),
    ).toEqual({ ...project, archivedAt: event.createdAt });
    for (const kind of ["archived", "restored"]) {
      expect(
        projectEventSchema.parse({
          id: event.id,
          projectId,
          seqId: 5,
          kind,
          name: "Launch",
          createdAt: event.createdAt,
        }),
      ).toMatchObject({ kind, name: "Launch", projectId });
    }
  });

  it("reads canonical assignment and unassignment events", () => {
    expect(chatThreadEventSchema.parse(event)).toMatchObject({
      kind: "project_updated",
      projectId,
    });
    expect(
      chatThreadEventSchema.parse({ ...event, projectId: null }),
    ).toMatchObject({ projectId: null });
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
    const parsed = userMessageDocumentSchema.parse(document);
    expect(parsed).toEqual(document);
    expect(document).toEqual(before);
  });

  it("rejects malformed clipboard references through safeParse without throwing", () => {
    expect(
      userMessageDocumentSchema.safeParse({
        version: 1,
        parts: [
          { type: "project", projectId: "not-an-id", nameSnapshot: "Launch" },
        ],
      }).success,
    ).toBe(false);
  });
});
