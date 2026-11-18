import { describe, expect, it } from "vitest";
import { replayProjectEvents } from "../project-event-replay";
import {
  compareProjectSortOrder,
  lastProjectSortOrder,
  moveProjectSortOrder,
} from "../project-sort-order";

const createdAt = "2026-11-01T00:00:00Z";
function project(id: string, sortOrder?: string) {
  return {
    id,
    name: id,
    createdAt,
    updatedAt: createdAt,
    ...(sortOrder ? { sortOrder } : {}),
  };
}

function move(
  projects: ReturnType<typeof project>[],
  id: string,
  target: string,
  side: "before" | "after",
) {
  const updates = new Map(
    moveProjectSortOrder(projects, id, target, side).map((entry) => {
      return [entry.projectId, entry.sortOrder];
    }),
  );
  return projects
    .map((entry) => {
      return updates.has(entry.id)
        ? { ...entry, sortOrder: updates.get(entry.id) }
        : entry;
    })
    .sort(compareProjectSortOrder);
}

describe("Project group ordering", () => {
  it("moves Projects above and below their neighbours without changing their creation times", () => {
    const projects = [
      project("a", "a0"),
      project("b", "a1"),
      project("c", "a2"),
    ];
    expect(
      move(projects, "c", "a", "before").map((entry) => {
        return entry.id;
      }),
    ).toEqual(["c", "a", "b"]);
    const moved = move(projects, "a", "c", "after");
    expect(
      moved.map((entry) => {
        return entry.id;
      }),
    ).toEqual(["b", "c", "a"]);
    expect(
      moved.map((entry) => {
        return entry.createdAt;
      }),
    ).toEqual([createdAt, createdAt, createdAt]);
  });

  it("inserts between equal ranks and gives a new Project a trailing rank", () => {
    const projects = [
      project("a", "a0"),
      project("b", "a0"),
      project("c", "a1"),
    ];
    const moved = move(projects, "c", "b", "before");
    expect(
      moved.map((entry) => {
        return entry.id;
      }),
    ).toEqual(["a", "c", "b"]);
    const next = project("d", lastProjectSortOrder(moved));
    expect(
      [...moved, next].sort(compareProjectSortOrder).map((entry) => {
        return entry.id;
      }),
    ).toEqual(["a", "c", "b", "d"]);
  });

  it("replays a migrated rank over an old snapshot and preserves it through an old rename event", () => {
    const first = project("a");
    const second = { ...project("b"), createdAt: "2026-11-02T00:00:00Z" };
    expect(
      replayProjectEvents([second, first], []).map((entry) => {
        return entry.id;
      }),
    ).toEqual(["a", "b"]);
    const events = [
      {
        id: "sort",
        projectId: second.id,
        kind: "sort_updated" as const,
        name: null,
        sortOrder: "a0",
        seqId: 1,
        createdAt,
      },
      {
        id: "rename",
        projectId: second.id,
        kind: "renamed" as const,
        name: "Renamed",
        sortOrder: null,
        seqId: 2,
        createdAt,
      },
    ];
    const replayed = replayProjectEvents([first, second], events);
    expect(
      replayed.map((entry) => {
        return entry.id;
      }),
    ).toEqual(["b", "a"]);
    expect(replayed[0]).toMatchObject({
      name: "Renamed",
      sortOrder: "a0",
      createdAt: second.createdAt,
    });
    expect(replayProjectEvents(replayed, [])).toEqual(replayed);
  });
});
