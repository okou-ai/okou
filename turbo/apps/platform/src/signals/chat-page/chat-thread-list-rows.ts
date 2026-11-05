import type { EventDrivenChatThread } from "@okouai/core/chat-thread-event-replay";
import type { Project } from "@okouai/api-contracts/validators/projects";
import { DEFAULT_PROJECT_THREAD_LIMIT } from "../projects/project-expansion.ts";

interface ChatThreadListRowBase {
  readonly key: string;
  /** The Project whose group contains the row; null outside Projects. */
  readonly projectId: string | null;
  /** The last row of a Project group closes its drop highlight. */
  readonly projectEnd: boolean;
}

export interface ProjectChatThreadListRow extends ChatThreadListRowBase {
  readonly kind: "project";
  readonly projectId: string;
  readonly project: Project;
  readonly expanded: boolean;
}

export interface ThreadChatThreadListRow extends ChatThreadListRowBase {
  readonly kind: "thread";
  readonly threadId: string;
  /** Position among chats outside Projects, which own number shortcuts. */
  readonly listIndex: number | null;
}

interface ProjectStatusChatThreadListRow extends ChatThreadListRowBase {
  readonly kind: "project-more" | "project-empty";
  readonly projectId: string;
}

/**
 * One fixed-height row of the chat list. Projects, their expanded chats and
 * the chats outside Projects share a single ordering so that rendering,
 * scrolling and keyboard navigation agree on positions.
 */
export type ChatThreadListRow =
  | ProjectChatThreadListRow
  | ThreadChatThreadListRow
  | ProjectStatusChatThreadListRow;

export interface ChatThreadNavigationList {
  /** Every chat in list order, including chats a filter or fold hides. */
  readonly orderedThreadIds: readonly string[];
  /** Chats with a visible row, which navigation can select. */
  readonly listedThreadIds: readonly string[];
  /** The Project of each listed chat inside a Project. */
  readonly threadProjectIds: ReadonlyMap<string, string>;
}

function groupProjectThreadIds(
  threads: readonly EventDrivenChatThread[],
): ReadonlyMap<string, readonly string[]> {
  const groups = new Map<string, string[]>();
  for (const thread of threads) {
    if (thread.projectId === null) {
      continue;
    }
    const group = groups.get(thread.projectId);
    if (group) {
      group.push(thread.id);
    } else {
      groups.set(thread.projectId, [thread.id]);
    }
  }
  return groups;
}

function projectGroupRows({
  project,
  expanded,
  threadIds,
  limit,
}: {
  project: Project;
  expanded: boolean;
  threadIds: readonly string[];
  limit: number;
}): ChatThreadListRow[] {
  const projectId = project.id;
  const rows: ChatThreadListRow[] = [
    {
      kind: "project",
      key: `project:${projectId}`,
      projectId,
      project,
      expanded,
      projectEnd: false,
    },
  ];
  if (expanded) {
    if (threadIds.length === 0) {
      rows.push({
        kind: "project-empty",
        key: `project-empty:${projectId}`,
        projectId,
        projectEnd: false,
      });
    }
    for (const threadId of threadIds.slice(0, limit)) {
      rows.push({
        kind: "thread",
        key: `thread:${threadId}`,
        threadId,
        projectId,
        listIndex: null,
        projectEnd: false,
      });
    }
    if (threadIds.length > limit) {
      rows.push({
        kind: "project-more",
        key: `project-more:${projectId}`,
        projectId,
        projectEnd: false,
      });
    }
  }
  const last = rows.length - 1;
  rows[last] = { ...rows[last]!, projectEnd: true };
  return rows;
}

export function buildChatThreadListRows({
  projects,
  expandedProjectIds,
  projectThreadLimits,
  projectThreads,
  threadIds,
  hideEmptyProjects,
}: {
  projects: readonly Project[];
  expandedProjectIds: ReadonlySet<string>;
  projectThreadLimits: Readonly<Record<string, number>>;
  /** Listed chats inside Projects, already sorted for display. */
  projectThreads: readonly EventDrivenChatThread[];
  /** Listed chats outside Projects, already sorted for display. */
  threadIds: readonly string[];
  /** A filtered list omits Projects without a matching chat. */
  hideEmptyProjects: boolean;
}): readonly ChatThreadListRow[] {
  const projectThreadIds = groupProjectThreadIds(projectThreads);
  const rows: ChatThreadListRow[] = [];
  for (const project of projects) {
    const ids = projectThreadIds.get(project.id) ?? [];
    if (hideEmptyProjects && ids.length === 0) {
      continue;
    }
    rows.push(
      ...projectGroupRows({
        project,
        expanded: expandedProjectIds.has(project.id),
        threadIds: ids,
        limit: projectThreadLimits[project.id] ?? DEFAULT_PROJECT_THREAD_LIMIT,
      }),
    );
  }
  for (const [listIndex, threadId] of threadIds.entries()) {
    rows.push({
      kind: "thread",
      key: `thread:${threadId}`,
      threadId,
      projectId: null,
      listIndex,
      projectEnd: false,
    });
  }
  return rows;
}

export function buildChatThreadNavigationList({
  projects,
  rows,
  allProjectThreads,
  allThreadIds,
}: {
  projects: readonly Project[];
  rows: readonly ChatThreadListRow[];
  allProjectThreads: readonly EventDrivenChatThread[];
  allThreadIds: readonly string[];
}): ChatThreadNavigationList {
  const projectThreadIds = groupProjectThreadIds(allProjectThreads);
  const listedThreadIds: string[] = [];
  const threadProjectIds = new Map<string, string>();
  for (const row of rows) {
    if (row.kind !== "thread") {
      continue;
    }
    listedThreadIds.push(row.threadId);
    if (row.projectId !== null) {
      threadProjectIds.set(row.threadId, row.projectId);
    }
  }
  return {
    orderedThreadIds: [
      ...projects.flatMap((project) => {
        return projectThreadIds.get(project.id) ?? [];
      }),
      ...allThreadIds,
    ],
    listedThreadIds,
    threadProjectIds,
  };
}
