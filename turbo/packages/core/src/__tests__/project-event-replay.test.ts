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
      { ...project, name: "Renamed", updatedAt: renamedAt, archivedAt: null },
    ]);
    expect(
      replayProjectEvents(
        [project],
        [renamed, { ...renamed, kind: "deleted", seqId: 3 }],
      ),
    ).toEqual([]);
  });
  it("normalizes legacy snapshots as active and replays archive, rename and restore without replacing identity", () => {
    const id = "30000000-0000-4000-8000-000000000071";
    const createdAt = "2026-11-01T00:00:00Z";
    const archivedAt = "2026-11-02T00:00:00Z";
    const renamedAt = "2026-11-03T00:00:00Z";
    const project = { id, name: "Launch", createdAt, updatedAt: createdAt };
    const archived = {
      id,
      projectId: id,
      kind: "archived" as const,
      name: project.name,
      createdAt: archivedAt,
      seqId: 2,
    };
    expect(replayProjectEvents([project], [])).toEqual([
      { ...project, archivedAt: null },
    ]);
    const renamed = replayProjectEvents(
      [project],
      [
        archived,
        {
          ...archived,
          kind: "renamed",
          seqId: 3,
          name: "Campaign",
          createdAt: renamedAt,
        },
      ],
    );
    expect(renamed).toEqual([
      { ...project, name: "Campaign", archivedAt, updatedAt: renamedAt },
    ]);
    expect(
      replayProjectEvents(renamed, [
        {
          ...archived,
          kind: "restored",
          seqId: 4,
          name: "Campaign",
          createdAt: "2026-11-04T00:00:00Z",
        },
      ]),
    ).toEqual([
      { ...project, name: "Campaign", archivedAt: null, updatedAt: renamedAt },
    ]);
  });

  it("preserves archived snapshot state through an empty event tail and a rename", () => {
    const id = "30000000-0000-4000-8000-000000000071";
    const project = {
      id,
      name: "Archived launch",
      createdAt: "2026-11-01T00:00:00Z",
      updatedAt: "2026-11-01T00:00:00Z",
      archivedAt: "2026-11-02T00:00:00Z",
    };
    expect(replayProjectEvents([project], [])).toEqual([project]);
    expect(
      replayProjectEvents(
        [project],
        [
          {
            id,
            projectId: id,
            kind: "renamed",
            seqId: 3,
            name: "Renamed archive",
            createdAt: "2026-11-03T00:00:00Z",
          },
        ],
      ),
    ).toEqual([
      {
        ...project,
        name: "Renamed archive",
        updatedAt: "2026-11-03T00:00:00Z",
      },
    ]);
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
