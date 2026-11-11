import type { EventDrivenChatThread } from "@okouai/core/chat-thread-event-replay";
import type { Project } from "@okouai/api-contracts/validators/projects";

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

/**
 * An unfolded Project without listed chats says so, and `project-archived`
 * then offers the archived ones it holds.
 */
interface ProjectStatusChatThreadListRow extends ChatThreadListRowBase {
  readonly kind: "project-empty" | "project-archived";
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
  /**
   * Every Project and chat in list order by row key, including the ones a
   * fold or filter hides, so a hidden current item keeps its position.
   */
  readonly orderedKeys: readonly string[];
  /** Keys of the Projects and chats with a visible row. */
  readonly listedKeys: readonly string[];
}

export function projectRowKey(projectId: string): string {
  return `project:${projectId}`;
}

export function threadRowKey(threadId: string): string {
  return `thread:${threadId}`;
}

export function projectIdOfRowKey(key: string): string | null {
  return key.startsWith("project:") ? key.slice("project:".length) : null;
}

export function threadIdOfRowKey(key: string): string | null {
  return key.startsWith("thread:") ? key.slice("thread:".length) : null;
}

/** Chat rows in list order, which own one item signal each. */
export function listedThreadIds(
  rows: readonly ChatThreadListRow[],
): readonly string[] {
  return rows.flatMap((row) => {
    return row.kind === "thread" ? [row.threadId] : [];
  });
}

/** The ids of the given chats under the Project each belongs to, in order. */
export function groupProjectThreadIds(
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
  hasHiddenArchivedThreads,
}: {
  project: Project;
  expanded: boolean;
  threadIds: readonly string[];
  hasHiddenArchivedThreads: boolean;
}): ChatThreadListRow[] {
  const projectId = project.id;
  const rows: ChatThreadListRow[] = [
    {
      kind: "project",
      key: projectRowKey(projectId),
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
      if (hasHiddenArchivedThreads) {
        rows.push({
          kind: "project-archived",
          key: `project-archived:${projectId}`,
          projectId,
          projectEnd: false,
        });
      }
    }
    for (const threadId of threadIds) {
      rows.push({
        kind: "thread",
        key: threadRowKey(threadId),
        threadId,
        projectId,
        listIndex: null,
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
  projectThreads,
  projectIdsWithHiddenArchivedThreads,
  threadIds,
  hideEmptyProjects,
}: {
  projects: readonly Project[];
  expandedProjectIds: ReadonlySet<string>;
  /** Listed chats inside Projects, already sorted for display. */
  projectThreads: readonly EventDrivenChatThread[];
  /** Projects holding archived chats that the list leaves out. */
  projectIdsWithHiddenArchivedThreads: ReadonlySet<string>;
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
        hasHiddenArchivedThreads: projectIdsWithHiddenArchivedThreads.has(
          project.id,
        ),
      }),
    );
  }
  for (const [listIndex, threadId] of threadIds.entries()) {
    rows.push({
      kind: "thread",
      key: threadRowKey(threadId),
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
  return {
    orderedKeys: [
      ...projects.flatMap((project) => {
        return [
          projectRowKey(project.id),
          ...(projectThreadIds.get(project.id) ?? []).map(threadRowKey),
        ];
      }),
      ...allThreadIds.map(threadRowKey),
    ],
    listedKeys: rows.flatMap((row) => {
      return row.kind === "project" || row.kind === "thread" ? [row.key] : [];
    }),
  };
}
