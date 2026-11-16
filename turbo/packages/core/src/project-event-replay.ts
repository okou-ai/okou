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
      return [
        project.id,
        { ...project, archivedAt: project.archivedAt ?? null },
      ];
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
    if (event.kind === "archived" || event.kind === "restored") {
      if (!existing) {
        throw new Error("Project lifecycle event has no creation or snapshot");
      }
      projects.set(event.projectId, {
        ...existing,
        name: event.name,
        archivedAt: event.kind === "archived" ? event.createdAt : null,
      });
      continue;
    }
    if (event.kind === "renamed" && !existing) {
      throw new Error("Project rename has no creation or snapshot");
    }
    projects.set(event.projectId, {
      id: event.projectId,
      name: event.name,
      createdAt: existing?.createdAt ?? event.createdAt,
      updatedAt: event.createdAt,
      archivedAt: existing?.archivedAt ?? null,
    });
  }
  return [...projects.values()].sort((a, b) => {
    return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  });
}
