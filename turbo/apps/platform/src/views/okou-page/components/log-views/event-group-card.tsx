import { Check, CircleDashed, Loader } from "lucide-react";
import { Markdown } from "../../../components/markdown.tsx";
import {
  eventGroupKey,
  isTaskEventData,
  type EventGroup,
  type ToolOperation,
} from "../../../../signals/activity-page/log-detail-utils";
import { ToolSummary } from "./tool-summary.tsx";
import {
  SystemInitContent,
  ResultEventContent,
  formatEventTime,
} from "./event-card.tsx";
import { StatusDot } from "./status-dot.tsx";
import { useTranslation } from "react-i18next";
import { i18n } from "../../../../i18n/index.ts";
import { formatAppNumber } from "../../../../i18n/format.ts";

interface EventGroupCardProps {
  group: EventGroup;
  searchTerm?: string;
  currentMatchIndex?: number;
  matchStartIndex?: number;
  showConnector?: boolean;
  startedAt?: string | null;
}

// Layout constants
const GROUP_SPACING = "py-2";

function MarkdownContent({ text }: { text: string }) {
  return <Markdown source={text} />;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFailedTaskStatus(status: string | undefined): boolean {
  switch (status?.toLowerCase()) {
    case "aborted":
    case "cancelled":
    case "canceled":
    case "declined":
    case "error":
    case "failed":
    case "interrupted":
    case "timed_out":
    case "timeout": {
      return true;
    }
    default: {
      return false;
    }
  }
}

function nextOccurrenceKey(counts: Map<string, number>, base: string): string {
  const occurrence = counts.get(base) ?? 0;
  counts.set(base, occurrence + 1);
  return occurrence === 0 ? base : `${base}:${occurrence}`;
}

function CollapsibleText({ text }: { text: string }) {
  // Check if text is long (more than ~100 characters or contains newlines)
  const isLong = text.length > 100 || text.includes("\n");

  if (!isLong) {
    return <MarkdownContent text={text} />;
  }

  return (
    <details className="group cursor-pointer">
      <summary className="list-none">
        <div className="line-clamp-1 group-open:line-clamp-none">
          <MarkdownContent text={text} />
        </div>
      </summary>
    </details>
  );
}

function ThinkingSummary({
  text,
  searchTerm,
  timestamp,
  showConnector,
  isDashed,
}: {
  text: string;
  searchTerm?: string;
  timestamp: string;
  showConnector: boolean;
  isDashed: boolean;
}) {
  const { t } = useTranslation();
  const hasSearchMatch = Boolean(
    searchTerm &&
    searchTerm.trim() &&
    text.toLowerCase().includes(searchTerm.toLowerCase()),
  );

  return (
    <div className={`${GROUP_SPACING} relative`}>
      {showConnector && <Connector isDashed={isDashed} />}
      <details className="group" open={hasSearchMatch}>
        <summary className="cursor-pointer list-none w-full text-left">
          <div className="flex items-center gap-2">
            <StatusDot variant="success" />
            <span className="font-semibold text-sm text-foreground shrink-0">
              {t(($) => {
                return $.activity.events.thinking;
              })}
            </span>
            <span className="flex-1" />
            <span className="text-xs text-muted-foreground shrink-0 ml-4 whitespace-nowrap hidden sm:inline">
              {timestamp}
            </span>
          </div>
          <div className="text-xs text-muted-foreground pl-5 mt-1 sm:hidden">
            {timestamp}
          </div>
        </summary>

        <div className="mt-1 flex items-start gap-1.5 ml-[18px] overflow-hidden">
          <span className="text-muted-foreground text-xs shrink-0">└</span>
          <div className="flex-1 min-w-0 text-sm text-foreground">
            <MarkdownContent text={text} />
          </div>
        </div>
      </details>
    </div>
  );
}

function AssistantSection({
  children,
  timestamp,
  showConnector,
  isDashed,
}: {
  children: React.ReactNode;
  timestamp?: string;
  showConnector: boolean;
  isDashed: boolean;
}) {
  return (
    <div className={`${GROUP_SPACING} relative`}>
      {showConnector && <Connector isDashed={isDashed} />}
      <div className="flex gap-2 items-start relative">
        <StatusDot variant="neutral" className="mt-1.5" />
        <div className="flex-1 min-w-0">{children}</div>
        {timestamp && (
          <span className="text-xs text-muted-foreground shrink-0 ml-4 whitespace-nowrap hidden sm:inline">
            {timestamp}
          </span>
        )}
      </div>
      {timestamp && (
        <div className="text-xs text-muted-foreground pl-5 mt-1 sm:hidden">
          {timestamp}
        </div>
      )}
    </div>
  );
}

export function EventGroupCard({
  group,
  searchTerm,
  currentMatchIndex,
  matchStartIndex = 0,
  showConnector = false,
  startedAt,
}: EventGroupCardProps) {
  // System event
  if (group.type === "system") {
    return (
      <SystemEventGroupCard
        group={group}
        searchTerm={searchTerm}
        showConnector={showConnector}
        startedAt={startedAt}
      />
    );
  }

  // Result event
  if (group.type === "result") {
    return (
      <ResultEventGroupCard
        group={group}
        showConnector={showConnector}
        startedAt={startedAt}
      />
    );
  }

  // Todo card (standalone)
  if (group.type === "todo") {
    return (
      <TodoCard
        group={group}
        searchTerm={searchTerm}
        showConnector={showConnector}
        startedAt={startedAt}
      />
    );
  }

  // Assistant group
  return (
    <AssistantEventGroupCard
      group={group}
      searchTerm={searchTerm}
      currentMatchIndex={currentMatchIndex}
      matchStartIndex={matchStartIndex}
      showConnector={showConnector}
      startedAt={startedAt}
    />
  );
}

function TaskEventGroupCard({
  group,
  searchTerm,
  showConnector = false,
  startedAt,
}: {
  group: EventGroup;
  searchTerm?: string;
  showConnector?: boolean;
  startedAt?: string | null;
}) {
  const { t } = useTranslation();
  const taskData = isTaskEventData(group.eventData) ? group.eventData : null;
  const description =
    stringValue(taskData?.description) ??
    stringValue(taskData?.task_summary) ??
    "";
  const taskStatus = stringValue(taskData?.task_status);
  const isFailed = isFailedTaskStatus(taskStatus);
  const isRunning = !taskStatus;
  const timestamp = formatEventTime(group.createdAt, startedAt);
  const children = group.childGroups ?? [];
  const hasChildren = children.length > 0;

  // Count tool operations across child groups
  const toolCount = children.reduce((sum, child) => {
    return sum + (child.toolOperations?.length ?? 0);
  }, 0);

  if (!hasChildren) {
    return (
      <div className={`${GROUP_SPACING} relative`}>
        {showConnector && (
          <div
            className="absolute left-[3px] top-6 bottom-[-8px] w-[1px] bg-divider/70"
            aria-hidden="true"
          />
        )}
        <div className="flex gap-2 items-center relative">
          {isRunning ? (
            <Loader className="h-3 w-3 text-yellow-600 animate-spin shrink-0" />
          ) : (
            <StatusDot variant={isFailed ? "error" : "success"} />
          )}
          <span className="font-semibold text-sm text-foreground shrink-0">
            {t(($) => {
              return $.activity.events.task;
            })}
          </span>
          {description && (
            <span className="text-sm text-muted-foreground truncate">
              {description}
            </span>
          )}
          <span className="flex-1" />
          <span className="text-xs text-muted-foreground shrink-0 ml-4 whitespace-nowrap hidden sm:inline">
            {timestamp}
          </span>
        </div>
        <div className="text-xs text-muted-foreground pl-5 mt-1 sm:hidden">
          {timestamp}
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      {showConnector && (
        <div
          className="absolute left-[3px] top-6 bottom-[-8px] w-[1px] bg-divider/70"
          aria-hidden="true"
        />
      )}
      <details className="group relative">
        <summary className="cursor-pointer list-none relative py-2">
          <div className="flex gap-2 items-center">
            {isRunning ? (
              <Loader className="h-3 w-3 text-yellow-600 animate-spin shrink-0" />
            ) : (
              <StatusDot variant={isFailed ? "error" : "success"} />
            )}
            <span className="font-semibold text-sm text-foreground shrink-0">
              {t(($) => {
                return $.activity.events.task;
              })}
            </span>
            {description && (
              <span className="text-sm text-muted-foreground truncate min-w-0">
                {description}
              </span>
            )}
            {toolCount > 0 && (
              <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground shrink-0">
                {t(
                  ($) => {
                    return $.activity.events.steps;
                  },
                  {
                    count: toolCount,
                    formattedCount: formatAppNumber(toolCount),
                  },
                )}
              </span>
            )}
            <span className="flex-1" />
            <span className="text-xs text-muted-foreground shrink-0 ml-4 whitespace-nowrap hidden sm:inline">
              {timestamp}
            </span>
          </div>
          <div className="text-xs text-muted-foreground pl-5 mt-1 sm:hidden">
            {timestamp}
          </div>
        </summary>
        <div className="mt-1">
          {children.map((child, i) => {
            return (
              <EventGroupCard
                key={eventGroupKey(child)}
                group={child}
                searchTerm={searchTerm}
                showConnector={i < children.length - 1}
                startedAt={startedAt}
              />
            );
          })}
        </div>
      </details>
    </div>
  );
}

type CodexSubAgentActivityKind =
  "started" | "interacted" | "interrupted" | "completed";

function isCodexSubAgentActivityKind(
  value: string | undefined,
): value is CodexSubAgentActivityKind {
  return (
    value === "started" ||
    value === "interacted" ||
    value === "interrupted" ||
    value === "completed"
  );
}

function CodexSystemEventGroupCard({
  eventData,
  subtype,
  subAgentKind,
  showConnector,
  timestamp,
}: {
  eventData: Record<string, unknown>;
  showConnector: boolean;
  timestamp: string;
} & (
  | {
      subtype: "codex_sub_agent_activity";
      subAgentKind: CodexSubAgentActivityKind;
    }
  | {
      subtype: "codex_context_compaction";
      subAgentKind?: never;
    }
)) {
  const { t } = useTranslation();
  const subAgentIdentity =
    stringValue(eventData.agent_path) ??
    stringValue(eventData.agent_thread_id) ??
    "";
  const codexActivityLabel =
    subtype === "codex_context_compaction"
      ? t(($) => {
          return $.activity.codex.contextCompaction;
        })
      : (() => {
          switch (subAgentKind) {
            case "started": {
              return t(($) => {
                return $.activity.codex.subAgentActivity.started;
              });
            }
            case "interacted": {
              return t(($) => {
                return $.activity.codex.subAgentActivity.interacted;
              });
            }
            case "interrupted": {
              return t(($) => {
                return $.activity.codex.subAgentActivity.interrupted;
              });
            }
            case "completed": {
              return t(($) => {
                return $.activity.codex.subAgentActivity.completed;
              });
            }
          }
        })();
  const statusVariant = subAgentKind === "completed" ? "success" : "neutral";

  return (
    <div className={`${GROUP_SPACING} relative`}>
      {showConnector && (
        <div
          className="absolute left-[3px] top-6 bottom-[-8px] w-[1px] bg-divider/70"
          aria-hidden="true"
        />
      )}
      <div className="flex gap-2 items-center relative">
        <StatusDot variant={statusVariant} />
        <span className="font-semibold text-sm text-foreground shrink-0">
          {codexActivityLabel}
        </span>
        {subAgentIdentity && (
          <code
            className="text-xs text-muted-foreground font-mono truncate"
            title={subAgentIdentity}
          >
            {subAgentIdentity}
          </code>
        )}
        <span className="flex-1" />
        <span className="text-xs text-muted-foreground shrink-0 ml-4 whitespace-nowrap hidden sm:inline">
          {timestamp}
        </span>
      </div>
      <div className="text-xs text-muted-foreground pl-5 mt-1 sm:hidden">
        {timestamp}
      </div>
    </div>
  );
}

function SystemEventGroupCard({
  group,
  searchTerm,
  showConnector = false,
  startedAt,
}: {
  group: EventGroup;
  searchTerm?: string;
  showConnector?: boolean;
  startedAt?: string | null;
}) {
  const { t } = useTranslation();
  const eventData = isRecord(group.eventData) ? group.eventData : {};
  const subtype =
    typeof eventData.subtype === "string" ? eventData.subtype : undefined;

  // Task events are rendered by TaskEventGroupCard
  if (subtype === "task_started" || subtype === "task_notification") {
    return (
      <TaskEventGroupCard
        group={group}
        searchTerm={searchTerm}
        showConnector={showConnector}
        startedAt={startedAt}
      />
    );
  }

  const timestamp = formatEventTime(group.createdAt, startedAt);
  const subAgentKind = stringValue(eventData.activity_kind);
  if (subtype === "codex_context_compaction") {
    return (
      <CodexSystemEventGroupCard
        eventData={eventData}
        subtype={subtype}
        showConnector={showConnector}
        timestamp={timestamp}
      />
    );
  }
  if (
    subtype === "codex_sub_agent_activity" &&
    isCodexSubAgentActivityKind(subAgentKind)
  ) {
    return (
      <CodexSystemEventGroupCard
        eventData={eventData}
        subtype={subtype}
        subAgentKind={subAgentKind}
        showConnector={showConnector}
        timestamp={timestamp}
      />
    );
  }

  return (
    <div className={`${GROUP_SPACING} relative`}>
      {showConnector && (
        <div
          className="absolute left-[3px] top-6 bottom-[-8px] w-[1px] bg-divider/70"
          aria-hidden="true"
        />
      )}
      <div className="flex gap-2 items-center relative">
        <StatusDot variant="neutral" />
        <span className="font-semibold text-sm text-foreground">
          {subtype === "init"
            ? t(($) => {
                return $.activity.events.initialize;
              })
            : subtype}
        </span>
        <span className="flex-1">
          {subtype === "init" && <SystemInitContent eventData={eventData} />}
        </span>
        <span className="text-xs text-muted-foreground shrink-0 ml-4 whitespace-nowrap hidden sm:inline">
          {timestamp}
        </span>
      </div>
      <div className="text-xs text-muted-foreground pl-5 mt-1 sm:hidden">
        {timestamp}
      </div>
    </div>
  );
}

function ResultEventGroupCard({
  group,
  showConnector = false,
  startedAt,
}: {
  group: EventGroup;
  showConnector?: boolean;
  startedAt?: string | null;
}) {
  const { t } = useTranslation();
  const eventData = isRecord(group.eventData) ? group.eventData : {};
  const timestamp = formatEventTime(group.createdAt, startedAt);
  const isError = eventData.is_error === true || eventData.success === false;
  return (
    <div className="relative">
      {showConnector && (
        <div
          className="absolute left-[3px] top-6 bottom-[-8px] w-[1px] bg-divider/70"
          aria-hidden="true"
        />
      )}
      <details className="group relative" open>
        <summary className="cursor-pointer list-none relative py-2">
          <div className="flex gap-2 items-center">
            <StatusDot variant={isError ? "error" : "primary"} />
            <span className="font-semibold text-sm text-foreground">
              {t(($) => {
                return $.activity.events.summary;
              })}
            </span>
            <span className="flex-1" />
            <span className="text-xs text-muted-foreground shrink-0 ml-4 whitespace-nowrap hidden sm:inline">
              {timestamp}
            </span>
          </div>
          <div className="text-xs text-muted-foreground pl-5 mt-1 sm:hidden">
            {timestamp}
          </div>
        </summary>
        {/* Vertical line from dot to content */}
        <div className="absolute left-[2px] top-[2.25rem] bottom-0 w-[1px] bg-divider/70 group-open:block hidden" />
        <div className="ml-[18px] mt-2 relative">
          <ResultEventContent eventData={eventData} />
        </div>
      </details>
    </div>
  );
}

function getTodoStatusIcon(status: string) {
  switch (status) {
    case "completed": {
      return <Check className="h-4 w-4 text-green-600" />;
    }
    case "in_progress": {
      return <Loader className="h-4 w-4 text-yellow-500" />;
    }
    default: {
      return <CircleDashed className="h-4 w-4" />;
    }
  }
}

/**
 * Standalone todo card that shows current task status as a single line.
 * Displays in-progress task with expandable full list.
 */
/**
 * Check if a todo item is a subtask (indented or prefixed with bullet).
 * Subtasks typically start with whitespace or bullet markers after whitespace.
 */
function isSubtask(content: string): boolean {
  // Matches items that start with whitespace, or start with bullet/dash after optional whitespace
  return /^\s{2,}|^\s*[-*]\s/.test(content);
}

function getTodoOperationErrors(group: EventGroup): {
  content: string;
  key: string;
}[] {
  const keyCounts = new Map<string, number>();
  return (group.toolOperations ?? []).flatMap((operation) => {
    if (!operation.result?.isError) {
      return [];
    }

    const content =
      operation.result.content.trim() ||
      i18n.t(
        ($) => {
          return $.activity.events.toolFailed;
        },
        { toolName: operation.toolName },
      );
    return [
      {
        content,
        key: nextOccurrenceKey(keyCounts, `todo-error-${operation.toolUseId}`),
      },
    ];
  });
}

function TodoCard({
  group,
  searchTerm,
  showConnector = false,
  startedAt,
}: {
  group: EventGroup;
  searchTerm?: string;
  showConnector?: boolean;
  startedAt?: string | null;
}) {
  const { t } = useTranslation();
  const todoItems = group.todoState ?? [];
  const operationErrors = getTodoOperationErrors(group);
  // Filter out subtasks for count - only count top-level tasks
  const topLevelTodos = todoItems.filter((t) => {
    return !isSubtask(t.content);
  });
  const inProgressTask = topLevelTodos.find((t) => {
    return t.status === "in_progress";
  });
  const completedCount = topLevelTodos.filter((t) => {
    return t.status === "completed";
  }).length;
  const totalCount = topLevelTodos.length;
  const normalizedSearchTerm = searchTerm?.trim().toLowerCase();

  // Check if any todo item matches search
  const hasSearchMatch = Boolean(
    normalizedSearchTerm &&
    (todoItems.some((t) => {
      return t.content.toLowerCase().includes(normalizedSearchTerm);
    }) ||
      operationErrors.some((error) => {
        return error.content.toLowerCase().includes(normalizedSearchTerm);
      })),
  );

  const timestamp = formatEventTime(group.createdAt, startedAt);
  const todoKeyCounts = new Map<string, number>();
  return (
    <div className={`${GROUP_SPACING} relative`}>
      {showConnector && (
        <div
          className="absolute left-[3px] top-6 bottom-[-8px] w-[1px] bg-divider/70"
          aria-hidden="true"
        />
      )}
      <details className="group" open={hasSearchMatch}>
        <summary className="cursor-pointer list-none relative">
          <div className="flex gap-2 items-center">
            <StatusDot variant="todo" />
            <span className="font-semibold text-sm text-foreground shrink-0">
              {t(($) => {
                return $.activity.events.todo;
              })}
            </span>
            {inProgressTask ? (
              <span
                className="text-sm text-foreground truncate"
                title={inProgressTask.content}
              >
                {inProgressTask.content}
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">
                {t(($) => {
                  return $.activity.events.allTasksCompleted;
                })}
              </span>
            )}
            <span className="text-sm text-muted-foreground shrink-0">
              [{formatAppNumber(completedCount)}/{formatAppNumber(totalCount)}]
            </span>
            <span className="flex-1" />
            <span className="text-xs text-muted-foreground shrink-0 ml-4 whitespace-nowrap hidden sm:inline">
              {timestamp}
            </span>
          </div>
          <div className="text-xs text-muted-foreground pl-5 mt-1 sm:hidden">
            {timestamp}
          </div>
        </summary>
        <div className="mt-2 space-y-1.5 ml-[18px]">
          {todoItems.map((item) => {
            const keyPrefix = `${item.status}:${item.content}`;
            const occurrence = todoKeyCounts.get(keyPrefix) ?? 0;
            todoKeyCounts.set(keyPrefix, occurrence + 1);
            return (
              <div
                key={`${keyPrefix}:${occurrence}`}
                className="flex items-center gap-2 text-sm"
              >
                <span className="shrink-0">
                  {getTodoStatusIcon(item.status)}
                </span>
                <span
                  className={
                    item.status === "completed"
                      ? "text-muted-foreground line-through"
                      : "text-foreground"
                  }
                >
                  {item.content}
                </span>
              </div>
            );
          })}
        </div>
        {operationErrors.length > 0 && (
          <div className="mt-2 space-y-1.5 ml-[18px]">
            {operationErrors.map((error) => {
              return (
                <div
                  key={error.key}
                  className="rounded-md border border-destructive/20 bg-destructive/10 px-2 py-1 text-xs text-destructive whitespace-pre-wrap break-words"
                >
                  {error.content}
                </div>
              );
            })}
          </div>
        )}
      </details>
    </div>
  );
}

/**
 * Determine if a connector should be shown for an element within an assistant group.
 * Returns an object with showConnector and isDashed properties.
 */
function shouldShowAssistantConnector(params: {
  isLastElementInGroup: boolean;
  showConnectorToNextGroup: boolean;
}): { showConnector: boolean; isDashed: boolean } {
  const { isLastElementInGroup, showConnectorToNextGroup } = params;
  const showConnector = !isLastElementInGroup || showConnectorToNextGroup;
  // Default to solid lines - dashed lines only for same tool types
  const isDashed = false;
  return { showConnector, isDashed };
}

/**
 * Render a connector line between elements.
 */
function Connector({ isDashed }: { isDashed: boolean }) {
  return (
    <div
      className={`absolute left-[3px] top-6 bottom-[-8px] w-[1px] ${
        isDashed
          ? "border-l border-dashed border-border/70 bg-transparent"
          : "bg-divider/70"
      }`}
      aria-hidden="true"
    />
  );
}

function countMatches(text: string | undefined, searchTerm?: string): number {
  if (!searchTerm || !text) {
    return 0;
  }

  const normalizedText = text.toLowerCase();
  const normalizedSearch = searchTerm.toLowerCase();
  let count = 0;
  let index = normalizedText.indexOf(normalizedSearch);

  while (index !== -1) {
    count++;
    index = normalizedText.indexOf(
      normalizedSearch,
      index + normalizedSearch.length,
    );
  }

  return count;
}

interface ToolGroup {
  toolName: string;
  operations: ToolOperation[];
}

/**
 * Group consecutive tool operations by tool name.
 * Non-consecutive operations of the same type stay in separate groups.
 */
function groupConsecutiveTools(operations: ToolOperation[]): ToolGroup[] {
  const groups: ToolGroup[] = [];
  for (const op of operations) {
    const last = groups[groups.length - 1];
    if (last && last.toolName === op.toolName) {
      last.operations.push(op);
    } else {
      groups.push({ toolName: op.toolName, operations: [op] });
    }
  }
  return groups;
}

function CollapsedToolGroup({
  group,
  searchTerm,
  currentMatchIndex,
  matchStartIndex,
  timestamp,
  showConnector,
  isDashed,
}: {
  group: ToolGroup;
  searchTerm?: string;
  currentMatchIndex?: number;
  matchStartIndex?: number;
  timestamp: string;
  showConnector: boolean;
  isDashed: boolean;
}) {
  const { t } = useTranslation();
  const count = group.operations.length;
  const label =
    group.toolName === "Read"
      ? t(
          ($) => {
            return $.activity.events.files;
          },
          {
            count,
            formattedCount: formatAppNumber(count),
          },
        )
      : group.toolName === "Grep"
        ? t(
            ($) => {
              return $.activity.events.searches;
            },
            {
              count,
              formattedCount: formatAppNumber(count),
            },
          )
        : t(
            ($) => {
              return $.activity.events.calls;
            },
            {
              count,
              formattedCount: formatAppNumber(count),
            },
          );
  const operationKeyCounts = new Map<string, number>();

  return (
    <div className={`${GROUP_SPACING} relative`}>
      {showConnector && <Connector isDashed={isDashed} />}
      <div className="relative">
        <details className="group">
          <summary className="cursor-pointer list-none w-full text-left">
            <div className="flex items-center gap-2">
              <StatusDot variant="success" />
              <span className="font-semibold text-sm text-foreground truncate min-w-0">
                {group.toolName}
              </span>
              <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground shrink-0">
                {label}
              </span>
              {timestamp && (
                <span className="text-xs text-muted-foreground shrink-0 ml-auto whitespace-nowrap hidden sm:inline">
                  {timestamp}
                </span>
              )}
            </div>
          </summary>
          <div className="mt-1 ml-5 space-y-1">
            {group.operations.map((op) => {
              return (
                <ToolSummary
                  key={nextOccurrenceKey(
                    operationKeyCounts,
                    `tool-${op.toolUseId}`,
                  )}
                  operation={op}
                  searchTerm={searchTerm}
                  currentMatchIndex={currentMatchIndex}
                  matchStartIndex={matchStartIndex}
                />
              );
            })}
          </div>
        </details>
      </div>
    </div>
  );
}

function renderToolElements(params: {
  toolOperations: ToolOperation[];
  textAfter?: string;
  toolMatchStart: number;
  currentMatchIndex?: number;
  searchTerm?: string;
  showConnector: boolean;
  timestamp: string;
}): React.ReactNode[] {
  const {
    toolOperations,
    textAfter,
    toolMatchStart,
    currentMatchIndex,
    searchTerm,
    showConnector,
    timestamp,
  } = params;
  const elements: React.ReactNode[] = [];
  const toolGroups = groupConsecutiveTools(toolOperations);
  const elementKeyCounts = new Map<string, number>();

  for (let gi = 0; gi < toolGroups.length; gi++) {
    const group = toolGroups[gi]!;
    const isLastGroup = gi === toolGroups.length - 1;
    const isLastElement = isLastGroup && !textAfter;
    const { showConnector: showConnectorHere } = shouldShowAssistantConnector({
      isLastElementInGroup: isLastElement,
      showConnectorToNextGroup: showConnector,
    });
    const nextGroup = toolGroups[gi + 1];
    const isDashed = nextGroup ? nextGroup.toolName === group.toolName : false;

    if (group.operations.length === 1) {
      const op = group.operations[0]!;
      elements.push(
        <div
          key={nextOccurrenceKey(elementKeyCounts, `tool-${op.toolUseId}`)}
          className={`${GROUP_SPACING} relative`}
        >
          {showConnectorHere && <Connector isDashed={isDashed} />}
          <div className="relative">
            <ToolSummary
              operation={op}
              searchTerm={searchTerm}
              currentMatchIndex={currentMatchIndex}
              matchStartIndex={toolMatchStart}
              timestamp={timestamp}
            />
          </div>
        </div>,
      );
    } else {
      elements.push(
        <CollapsedToolGroup
          key={nextOccurrenceKey(
            elementKeyCounts,
            `group-${group.operations[0]!.toolUseId}`,
          )}
          group={group}
          searchTerm={searchTerm}
          currentMatchIndex={currentMatchIndex}
          matchStartIndex={toolMatchStart}
          timestamp={timestamp}
          showConnector={showConnectorHere}
          isDashed={isDashed}
        />,
      );
    }
  }

  return elements;
}

function AssistantEventGroupCard({
  group,
  searchTerm,
  currentMatchIndex,
  matchStartIndex,
  showConnector = false,
  startedAt,
}: {
  group: EventGroup;
  searchTerm?: string;
  currentMatchIndex?: number;
  matchStartIndex?: number;
  showConnector?: boolean;
  startedAt?: string | null;
}) {
  const { thinkingBlocks, textBefore, textAfter, toolOperations } = group;
  const thinkingText = thinkingBlocks?.join("\n\n");
  const hasTools = toolOperations && toolOperations.length > 0;
  const currentOffset = matchStartIndex ?? 0;
  const textBeforeMatches = countMatches(textBefore, searchTerm);
  const thinkingMatches = countMatches(thinkingText, searchTerm);
  const elements: React.ReactNode[] = [];
  const timestamp = formatEventTime(group.createdAt, startedAt);

  if (thinkingText) {
    const isLastElement = !textBefore && !hasTools && !textAfter;
    const { showConnector: showConnectorHere, isDashed } =
      shouldShowAssistantConnector({
        isLastElementInGroup: isLastElement,
        showConnectorToNextGroup: showConnector,
      });

    elements.push(
      <ThinkingSummary
        key="thinking"
        text={thinkingText}
        searchTerm={searchTerm}
        timestamp={timestamp}
        showConnector={showConnectorHere}
        isDashed={isDashed}
      />,
    );
  }

  if (textBefore) {
    const isLastElement = !hasTools && !textAfter;
    const { showConnector: showConnectorHere, isDashed } =
      shouldShowAssistantConnector({
        isLastElementInGroup: isLastElement,
        showConnectorToNextGroup: showConnector,
      });

    elements.push(
      <AssistantSection
        key="text-before"
        timestamp={timestamp}
        showConnector={showConnectorHere}
        isDashed={isDashed}
      >
        <CollapsibleText text={textBefore} />
      </AssistantSection>,
    );
  }

  if (hasTools) {
    const toolMatchStart = currentOffset + thinkingMatches + textBeforeMatches;
    elements.push(
      ...renderToolElements({
        toolOperations,
        textAfter,
        toolMatchStart,
        currentMatchIndex,
        searchTerm,
        showConnector,
        timestamp,
      }),
    );
  }

  if (textAfter) {
    const isLastElement = true;
    const { showConnector: showConnectorHere, isDashed } =
      shouldShowAssistantConnector({
        isLastElementInGroup: isLastElement,
        showConnectorToNextGroup: showConnector,
      });

    elements.push(
      <AssistantSection
        key="text-after"
        showConnector={showConnectorHere}
        isDashed={isDashed}
      >
        <CollapsibleText text={textAfter} />
      </AssistantSection>,
    );
  }

  return <>{elements}</>;
}
