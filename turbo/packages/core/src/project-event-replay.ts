import type {
  Project,
  ProjectEvent,
} from "@okouai/api-contracts/contracts/projects";

import { compareProjectSortOrder } from "./project-sort-order";

export function replayProjectEvents(
  snapshot: readonly Project[],
  events: readonly ProjectEvent[],
): Project[] {
  const projects = new Map(
    snapshot.map((project) => {
      return [project.id, project];
    }),
  );
  for (const event of events) {
    if (event.kind === "deleted") {
      projects.delete(event.projectId);
      continue;
    }
    if (event.kind === "sort_updated") {
      const existing = projects.get(event.projectId);
      if (!existing || event.sortOrder == null) {
        throw new Error("Project sort event has no baseline or rank");
      }
      projects.set(event.projectId, {
        ...existing,
        sortOrder: event.sortOrder,
        updatedAt: event.createdAt,
      });
      continue;
    }
    if (event.name === null) {
      throw new Error("Project lifecycle event is missing its name");
    }
    const existing = projects.get(event.projectId);
    if (event.kind === "renamed" && !existing) {
      throw new Error("Project rename has no creation or snapshot");
    }
    projects.set(event.projectId, {
      id: event.projectId,
      name: event.name,
      createdAt: existing?.createdAt ?? event.createdAt,
      updatedAt: event.createdAt,
      ...(event.sortOrder != null
        ? { sortOrder: event.sortOrder }
        : existing?.sortOrder !== undefined
          ? { sortOrder: existing.sortOrder }
          : {}),
    });
  }
  return [...projects.values()].sort(compareProjectSortOrder);
}
