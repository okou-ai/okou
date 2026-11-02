import type {
  Project,
  ProjectEvent,
} from "@okouai/api-contracts/contracts/projects";

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
    });
  }
  return [...projects.values()].sort((a, b) => {
    return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  });
}
