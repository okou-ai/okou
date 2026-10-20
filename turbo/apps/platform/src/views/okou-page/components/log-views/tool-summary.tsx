import type { ReactNode } from "react";
import { highlightText } from "./utils/highlight-text.tsx";
import {
  stringifyUnknownValue,
  type ToolOperation,
} from "../../../../signals/activity-page/log-detail-utils";
import { formatDuration } from "./event-card.tsx";
import { StatusDot } from "./status-dot.tsx";
import { useTranslation } from "react-i18next";
import { formatAppNumber } from "../../../../i18n/format.ts";
import { formatSize } from "../network-badge.tsx";

interface ToolSummaryProps {
  operation: ToolOperation;
  searchTerm?: string;
  currentMatchIndex?: number;
  matchStartIndex?: number;
  timestamp?: string;
}

function checkSearchMatch(
  searchTerm: string | undefined,
  toolName: string,
  keyParam: string,
  resultContent: string | undefined,
): boolean {
  if (!searchTerm || !searchTerm.trim()) {
    return false;
  }
  const lowerSearch = searchTerm.toLowerCase();
  return (
    toolName.toLowerCase().includes(lowerSearch) ||
    keyParam.toLowerCase().includes(lowerSearch) ||
    (resultContent ?? "").toLowerCase().includes(lowerSearch)
  );
}

function ToolSummaryHeader({
  toolName,
  keyParamElement,
  keyParam,
  isError,
  hasResult,
  timestamp,
  errorMessage,
}: {
  toolName: string;
  keyParamElement: ReactNode;
  keyParam: string;
  isError: boolean;
  hasResult: boolean;
  timestamp?: string;
  errorMessage?: string;
}) {
  // Determine status dot variant based on result state
  const getStatusVariant = () => {
    if (isError) {
      return "error";
    }
    if (hasResult) {
      return "success";
    }
    return "pending";
  };

  return (
    <summary className="cursor-pointer list-none w-full text-left">
      <div className="flex items-center gap-2">
        <StatusDot variant={getStatusVariant()} />
        <span className="font-semibold text-sm text-foreground shrink-0">
          {toolName}
        </span>
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {keyParam && (
            <code className="text-xs text-muted-foreground font-mono truncate">
              {keyParamElement}
            </code>
          )}
          {isError && errorMessage && (
            <span className="text-xs text-red-600 truncate">
              {errorMessage.split("\n")[0]}
            </span>
          )}
        </div>
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
    </summary>
  );
}

export function ToolSummary({
  operation,
  searchTerm,
  currentMatchIndex,
  matchStartIndex,
  timestamp,
}: ToolSummaryProps) {
  const { t } = useTranslation();
  const { toolName, keyParam, result, input } = operation;
  const isError = result?.isError ?? false;
  const durationMs = result?.durationMs;

  const hasSearchMatch = checkSearchMatch(
    searchTerm,
    toolName,
    keyParam,
    result?.content,
  );

  const durationText =
    durationMs !== undefined ? formatDuration(durationMs) : null;

  const keyParamElement =
    searchTerm && keyParam
      ? highlightText(keyParam, {
          searchTerm,
          currentMatchIndex,
          matchStartIndex,
        }).element
      : keyParam;

  // Get error message to display in header
  const errorMessage = isError && result?.content ? result.content : undefined;

  return (
    <details className="group" data-testid="tool-summary" open={hasSearchMatch}>
      <ToolSummaryHeader
        toolName={toolName}
        keyParamElement={keyParamElement}
        keyParam={keyParam}
        isError={isError}
        hasResult={Boolean(result)}
        timestamp={timestamp}
        errorMessage={errorMessage}
      />

      <div className="mt-1 flex items-start gap-1.5 ml-[18px] overflow-hidden">
        <span className="text-muted-foreground text-xs shrink-0">└</span>
        <div className="flex-1 min-w-0 space-y-1">
          {durationText && (
            <div className="text-xs text-muted-foreground">
              {t(
                ($) => {
                  return $.activity.events.duration;
                },
                { duration: durationText },
              )}
            </div>
          )}

          {input && Object.keys(input).length > 0 && (
            <ToolInputDetails input={input} toolName={toolName} />
          )}

          {result && (
            <ToolResultDetails
              result={result}
              searchTerm={searchTerm}
              currentMatchIndex={currentMatchIndex}
              matchStartIndex={matchStartIndex}
            />
          )}
        </div>
      </div>
    </details>
  );
}

function shouldFilterKey(lowerName: string, key: string): boolean {
  if (lowerName === "bash" && key === "command") {
    return true;
  }
  if (lowerName === "skill" && ["skill", "args"].includes(key)) {
    return true;
  }
  if (lowerName === "write" && ["file_path", "content"].includes(key)) {
    return true;
  }
  if (
    lowerName === "edit" &&
    ["file_path", "old_string", "new_string"].includes(key)
  ) {
    return true;
  }
  if (["read", "glob", "grep"].includes(lowerName)) {
    if (["file_path", "path", "pattern"].includes(key)) {
      return true;
    }
  }
  if (
    (lowerName === "webfetch" || lowerName === "websearch") &&
    key === "url"
  ) {
    return true;
  }
  return false;
}

function getStringField(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function ToolInputDetails({
  input,
  toolName,
}: {
  input: Record<string, unknown>;
  toolName: string;
}) {
  const { t } = useTranslation();
  const lowerName = toolName.toLowerCase();

  // Bash - show full command
  if (lowerName === "bash") {
    const command = getStringField(input, "command");
    if (command) {
      return (
        <pre className="font-mono text-xs text-foreground whitespace-pre-wrap break-all overflow-hidden leading-5">
          {command}
        </pre>
      );
    }
  }

  // Skill - show skill name and args with labels
  if (lowerName === "skill") {
    const skill = getStringField(input, "skill");
    const args = getStringField(input, "args");
    if (skill) {
      return (
        <div className="font-mono text-xs">
          <span className="text-muted-foreground">
            {t(($) => {
              return $.activity.events.nameLabel;
            })}{" "}
          </span>
          <span className="text-foreground">{skill}</span>
          {args && (
            <>
              <span className="text-muted-foreground ml-3">
                {t(($) => {
                  return $.activity.events.argsLabel;
                })}{" "}
              </span>
              <span className="text-foreground">{args}</span>
            </>
          )}
        </div>
      );
    }
  }

  // Write - show full content in a code block
  if (lowerName === "write") {
    const content = getStringField(input, "content");
    if (content) {
      return (
        <pre className="font-mono text-xs text-muted-foreground whitespace-pre-wrap break-all">
          {content}
        </pre>
      );
    }
  }

  // Edit - show old_string and new_string
  if (lowerName === "edit") {
    const oldString = getStringField(input, "old_string");
    const newString = getStringField(input, "new_string");
    if (oldString || newString) {
      return (
        <div className="space-y-1">
          {oldString && (
            <div className="flex items-start gap-2">
              <span className="text-red-600 shrink-0">-</span>
              <pre className="font-mono text-xs text-red-600/70 whitespace-pre-wrap break-all">
                {oldString}
              </pre>
            </div>
          )}
          {newString && (
            <div className="flex items-start gap-2">
              <span className="text-green-600 shrink-0">+</span>
              <pre className="font-mono text-xs text-green-600/70 whitespace-pre-wrap break-all">
                {newString}
              </pre>
            </div>
          )}
        </div>
      );
    }
  }

  // For other tools, show key-value pairs inline
  const entries = Object.entries(input).filter(([key]) => {
    return !shouldFilterKey(lowerName, key);
  });

  if (entries.length === 0) {
    return null;
  }

  const formatValue = (val: unknown): string => {
    if (typeof val === "string") {
      return val.length > 50 ? `${val.slice(0, 47)}...` : val;
    }
    return stringifyUnknownValue(val);
  };

  const getFullValue = (val: unknown): string => {
    if (typeof val === "string") {
      return val;
    }
    return stringifyUnknownValue(val);
  };

  const fullText = entries
    .map(([key, val]) => {
      return `${key}: ${getFullValue(val)}`;
    })
    .join(", ");

  return (
    <span className="text-xs text-muted-foreground" aria-description={fullText}>
      (
      {entries
        .map(([key, val]) => {
          return `${key}: ${formatValue(val)}`;
        })
        .join(", ")}
      )
    </span>
  );
}

function ToolResultDetails({
  result,
  searchTerm,
  currentMatchIndex,
  matchStartIndex,
}: {
  result: NonNullable<ToolOperation["result"]>;
  searchTerm?: string;
  currentMatchIndex?: number;
  matchStartIndex?: number;
}) {
  const { t } = useTranslation();
  const { content, isError, bytes } = result;
  const formattedBytes = bytes
    ? formatSize(bytes).replace(/(KB|MB|B)$/u, " $1")
    : null;

  if (!content || content.trim() === "") {
    return (
      <span className="text-xs text-muted-foreground italic">
        {t(($) => {
          return $.activity.events.emptyOutput;
        })}
      </span>
    );
  }

  const lines = content.split("\n");
  const lineCount = lines.length;
  const isLong = lineCount > 3 || content.length > 300;

  // Check if search matches this content
  const hasSearchMatch =
    searchTerm &&
    searchTerm.trim() &&
    content.toLowerCase().includes(searchTerm.toLowerCase());

  const contentElement = searchTerm
    ? highlightText(content, {
        searchTerm,
        currentMatchIndex,
        matchStartIndex,
      }).element
    : content;

  if (isError) {
    return (
      <pre className="text-xs text-red-600 whitespace-pre-wrap break-all">
        {contentElement}
      </pre>
    );
  }

  if (isLong && !hasSearchMatch) {
    const previewText = lines.slice(0, 3).join("\n");
    const remainingLines = lineCount - 3;

    return (
      <div>
        <pre className="text-xs text-foreground whitespace-pre-wrap break-all">
          {previewText}
        </pre>
        <details
          className="[&[open]>summary]:hidden"
          data-testid="tool-result-expand"
        >
          <summary className="list-none cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            {t(
              ($) => {
                return $.activity.events.remainingLines;
              },
              {
                count: remainingLines,
                formattedCount: formatAppNumber(remainingLines),
              },
            )}
            {formattedBytes ? ` (${formattedBytes})` : ""}
          </summary>
          <pre className="text-xs text-foreground whitespace-pre-wrap break-all">
            {lines.slice(3).join("\n")}
          </pre>
        </details>
      </div>
    );
  }

  return (
    <pre className="text-xs text-foreground whitespace-pre-wrap break-all">
      {contentElement}
    </pre>
  );
}
