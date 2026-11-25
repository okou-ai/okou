import { describe, it, expect } from "vitest";
import { replayProjectEvents } from "../project-event-replay";
import {
  createProjectOperationId,
  isFreshProjectOperation,
} from "../project-operation-id";

describe("Project identity and lifecycle", () => {
  it("replays a rename without changing identity or creation time, then deletes it", () => {
    const id = "30000000-0000-4000-8000-000000000071";
    const createdAt = "2026-11-01T00:00:00Z";
    const renamedAt = "2026-11-02T00:00:00Z";
    const project = { id, name: "Original", createdAt, updatedAt: createdAt };
    const renamed = {
      id,
      projectId: id,
      kind: "renamed" as const,
      name: "Renamed",
      createdAt: renamedAt,
      seqId: 2,
    };
    expect(replayProjectEvents([project], [renamed])).toEqual([
      { ...project, name: "Renamed", updatedAt: renamedAt },
    ]);
    expect(
      replayProjectEvents(
        [project],
        [renamed, { ...renamed, kind: "deleted", seqId: 3 }],
      ),
    ).toEqual([]);
  });
  it("replays Project archive and restore in the original order", () => {
    const id = "30000000-0000-4000-8000-000000000071";
    const createdAt = "2026-11-01T00:00:00Z";
    const lastArchivedAt = "2026-11-02T00:00:00Z";
    const project = {
      id,
      name: "Launch",
      createdAt,
      updatedAt: createdAt,
      sortOrder: "a0",
    };
    const archive = {
      id: "30000000-0000-4000-8000-000000000072",
      projectId: id,
      kind: "renamed" as const,
      name: project.name,
      createdAt: lastArchivedAt,
      archived: true,
      lastArchivedAt,
      seqId: 2,
    };
    const archived = replayProjectEvents([project], [archive]);
    expect(archived).toMatchObject([
      { id, archived: true, lastArchivedAt, sortOrder: "a0" },
    ]);
    expect(
      replayProjectEvents(archived, [
        {
          ...archive,
          id: "30000000-0000-4000-8000-000000000073",
          archived: false,
          seqId: 3,
        },
      ]),
    ).toMatchObject([{ id, archived: false, lastArchivedAt, sortOrder: "a0" }]);
  });

  it("rejects expired and future operation identities without changing their retry timestamp", () => {
    const now = Date.parse("2026-11-02T00:00:00Z");
    const random = "30000000-0000-4000-8000-000000000071";
    const id = createProjectOperationId(now, random);
    expect(isFreshProjectOperation(id, now)).toBe(true);
    expect(isFreshProjectOperation(id, now + 7 * 86400000)).toBe(false);
    expect(
      isFreshProjectOperation(
        createProjectOperationId(now + 6 * 60000, random),
        now,
      ),
    ).toBe(false);
    expect(isFreshProjectOperation(random, now)).toBe(false);
    const ahead = createProjectOperationId(now + 4 * 60000, random);
    expect(isFreshProjectOperation(ahead, now)).toBe(true);
    expect(isFreshProjectOperation(ahead, now + 7 * 86400000)).toBe(false);
  });
});
