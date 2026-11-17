import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

export interface ProjectSortOrder {
  readonly id: string;
  readonly createdAt: string;
  readonly sortOrder?: string | null;
}

/** Keep old snapshots and Projects created by a draining API readable. */
export function projectSortOrder(project: ProjectSortOrder): string {
  if (project.sortOrder != null) {
    return project.sortOrder;
  }
  const timestamp = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(project.createdAt)
    ? project.createdAt
    : `${project.createdAt}Z`;
  return `a0${Date.parse(timestamp).toString().padStart(17, "0")}1`;
}

export function compareProjectSortOrder(
  left: ProjectSortOrder,
  right: ProjectSortOrder,
): number {
  const a = projectSortOrder(left);
  const b = projectSortOrder(right);
  // Fractional keys use byte ordering, never locale-dependent collation.
  if (a !== b) {
    return a < b ? -1 : 1;
  }
  return left.id === right.id ? 0 : left.id < right.id ? -1 : 1;
}

/** Allocate a new Project after every existing Project in its owner scope. */
export function lastProjectSortOrder(
  projects: readonly ProjectSortOrder[],
): string {
  const last = [...projects].sort(compareProjectSortOrder).at(-1);
  return generateKeyBetween(last ? projectSortOrder(last) : null, null);
}

/** Move a whole Project group without touching any of its chat ranks. */
export function moveProjectSortOrder(
  projects: readonly ProjectSortOrder[],
  projectId: string,
  targetId: string,
  side: "before" | "after",
): { projectId: string; sortOrder: string }[] {
  const ordered = [...projects].sort(compareProjectSortOrder);
  const moved = ordered.find((project) => {
    return project.id === projectId;
  });
  if (!moved || projectId === targetId) {
    return [];
  }
  const remaining = ordered.filter((project) => {
    return project.id !== projectId;
  });
  const target = remaining.findIndex((project) => {
    return project.id === targetId;
  });
  if (target < 0) {
    return [];
  }
  const index = target + (side === "after" ? 1 : 0);
  if (ordered[index]?.id === projectId) {
    return [];
  }
  const left = index > 0 ? projectSortOrder(remaining[index - 1]!) : null;
  const right =
    index < remaining.length ? projectSortOrder(remaining[index]!) : null;
  if (left === null || left !== right) {
    return [{ projectId, sortOrder: generateKeyBetween(left, right) }];
  }
  // Concurrent historical ranks may tie. Re-rank only the tied insertion suffix.
  let end = index;
  while (end < remaining.length && projectSortOrder(remaining[end]!) === left) {
    end++;
  }
  const upper =
    end < remaining.length ? projectSortOrder(remaining[end]!) : null;
  const affected = [moved, ...remaining.slice(index, end)];
  const ranks = generateNKeysBetween(left, upper, affected.length);
  return affected.map((project, i) => {
    return {
      projectId: project.id,
      sortOrder: ranks[i]!,
    };
  });
}
