import { Button, CopyButton, cn } from "@okouai/ui";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import type { TextPreviewContent } from "../../signals/text-preview.ts";
import type {
  JsonPreviewSignals,
  JsonPreviewRow,
  JsonPreviewNodeSignals,
  JsonPreviewPageSignals,
} from "../../signals/json-preview.ts";
import { formatAppNumber } from "../../i18n/format.ts";

const INDENTS = Object.freeze([
  "pl-0",
  "pl-4",
  "pl-8",
  "pl-12",
  "pl-16",
  "pl-20",
  "pl-24",
  "pl-28",
  "pl-32",
]);

function JsonPageRow({
  row,
  signals,
}: {
  readonly row: Extract<JsonPreviewRow, { kind: "more" }>;
  readonly signals: JsonPreviewSignals;
}) {
  const { t } = useTranslation();
  const more = useSet(signals.showMore$);
  const indent = INDENTS[Math.min(row.depth, INDENTS.length - 1)];
  return (
    <div className={cn("py-1", indent)}>
      <Button
        variant="quiet"
        size="sm"
        focusableWhenDisabled
        disabled={row.remaining === 0}
        onClick={() => {
          return more(row.node.offset);
        }}
      >
        {row.remaining === 0
          ? t(($) => {
              return $.artifacts.jsonPreview.allShown;
            })
          : t(($) => {
              return $.artifacts.jsonPreview.more;
            })}
      </Button>
    </div>
  );
}

function JsonRow({
  row,
  signals,
}: {
  readonly row: Extract<JsonPreviewRow, { kind: "node" }>;
  readonly signals: JsonPreviewSignals;
}) {
  const { t } = useTranslation();
  const toggle = useSet(signals.toggleNode$);
  const node = row.node;
  const indent = INDENTS[Math.min(row.depth, INDENTS.length - 1)];
  const container = node.type === "object" || node.type === "array";
  const label = row.expanded
    ? t(
        ($) => {
          return $.artifacts.jsonPreview.collapse;
        },
        { label: node.label },
      )
    : t(
        ($) => {
          return $.artifacts.jsonPreview.expand;
        },
        { label: node.label },
      );
  const literal = signals.source.text.slice(
    node.offset,
    node.offset + node.length,
  );
  return (
    <div
      className={cn(
        "group flex min-w-0 items-start gap-1 rounded-md py-0.5 hover:bg-state-hover",
        indent,
      )}
    >
      {container && node.children.length > 0 ? (
        <Button
          variant="quiet"
          size="icon-sm"
          className="shrink-0"
          aria-label={label}
          aria-expanded={row.expanded}
          onClick={() => {
            return toggle(node.offset, row.expanded);
          }}
        >
          {row.expanded ? (
            <ChevronDown size={16} />
          ) : (
            <ChevronRight size={16} />
          )}
        </Button>
      ) : (
        <span className="w-8 shrink-0" />
      )}
      <div className="min-w-0 flex-1 break-all py-1.5 font-mono text-sm whitespace-pre-wrap">
        <span className="text-foreground">{node.label}</span>
        {": "}
        {container ? (
          <span className="text-muted-foreground">
            <span>
              {node.type === "object"
                ? node.children.length === 0
                  ? "{}"
                  : "{…}"
                : node.children.length === 0
                  ? "[]"
                  : "[…]"}
            </span>{" "}
            {node.type === "object"
              ? t(
                  ($) => {
                    return $.artifacts.jsonPreview.objectCount;
                  },
                  {
                    formattedCount: formatAppNumber(node.children.length),
                  },
                )
              : t(
                  ($) => {
                    return $.artifacts.jsonPreview.arrayCount;
                  },
                  {
                    formattedCount: formatAppNumber(node.children.length),
                  },
                )}
          </span>
        ) : (
          <span
            className={cn(
              node.type === "string"
                ? "text-primary"
                : node.type === "number"
                  ? "text-selected-foreground"
                  : "text-muted-foreground",
            )}
          >
            {literal}
          </span>
        )}
      </div>
      <CopyButton
        text={literal}
        showTooltip={false}
        aria-label={t(
          ($) => {
            return $.artifacts.jsonPreview.copyNode;
          },
          {
            label: node.label,
          },
        )}
        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      />
    </div>
  );
}

interface JsonNodePageProps {
  readonly page: JsonPreviewPageSignals;
  readonly pages: readonly JsonPreviewPageSignals[];
  readonly index: number;
  readonly depth: number;
  readonly signals: JsonPreviewSignals;
}

function JsonNodePage(props: JsonNodePageProps) {
  const visible = useGet(props.page.visible$);
  return visible ? <JsonPageNodes {...props} /> : null;
}

function JsonPageNodes({
  page,
  pages,
  index,
  depth,
  signals,
}: JsonNodePageProps) {
  const nodes = useGet(page.nodes$);
  const next = pages[index + 1];
  return (
    <>
      {nodes.map((node) => {
        return (
          <JsonTreeNode
            key={node.node.offset}
            node={node}
            depth={depth}
            signals={signals}
          />
        );
      })}
      {next && (
        <JsonNodePage
          page={next}
          pages={pages}
          index={index + 1}
          depth={depth}
          signals={signals}
        />
      )}
    </>
  );
}

interface JsonTreeNodeProps {
  readonly node: JsonPreviewNodeSignals;
  readonly depth: number;
  readonly signals: JsonPreviewSignals;
}

function JsonRemainingRow({ node, depth, signals }: JsonTreeNodeProps) {
  const remaining = useGet(node.remaining$);
  return remaining === undefined ? null : (
    <JsonPageRow
      row={{ kind: "more", node: node.node, depth, remaining }}
      signals={signals}
    />
  );
}

function JsonNodeChildren({ node, depth, signals }: JsonTreeNodeProps) {
  const pages = useGet(node.pages$);
  const first = pages[0];
  // Keep More outside the page frontier so keyboard focus survives paging.
  return (
    <>
      {first && (
        <JsonNodePage
          page={first}
          pages={pages}
          index={0}
          depth={depth}
          signals={signals}
        />
      )}
      <JsonRemainingRow node={node} depth={depth} signals={signals} />
    </>
  );
}

function JsonTreeNode({ node, depth, signals }: JsonTreeNodeProps) {
  const expanded = useGet(node.expanded$);
  if (expanded === undefined) {
    return null;
  }
  return (
    <>
      <JsonRow
        row={{ kind: "node", node: node.node, depth, expanded }}
        signals={signals}
      />
      {expanded && node.node.children.length > 0 && (
        <JsonNodeChildren node={node} depth={depth + 1} signals={signals} />
      )}
    </>
  );
}

function JsonTreeRows({ signals }: { readonly signals: JsonPreviewSignals }) {
  const root = useGet(signals.rootNode$);
  return root ? <JsonTreeNode node={root} depth={0} signals={signals} /> : null;
}

function JsonLimitedStatus({
  signals,
}: {
  readonly signals: JsonPreviewSignals;
}) {
  const limited = useGet(signals.limited$);
  const { t } = useTranslation();
  return limited ? (
    <p role="status" className="text-sm text-muted-foreground">
      {t(($) => {
        return $.artifacts.jsonPreview.limited;
      })}
    </p>
  ) : null;
}

export function JsonPreview({
  preview,
}: {
  readonly preview: TextPreviewContent;
}) {
  const signals = preview.json;
  const { t } = useTranslation();
  const model = useGet(signals.model$);
  const sourceMode = useGet(signals.sourceMode$);
  const selectView = useSet(signals.selectView$);
  const collapseAll = useSet(signals.collapseAll$);
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="json-preview">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border p-3">
        <Button
          variant={sourceMode ? "quiet" : "neutral"}
          size="sm"
          aria-pressed={!sourceMode}
          disabled={model.status !== "ready"}
          onClick={() => {
            return selectView("tree");
          }}
        >
          {t(($) => {
            return $.artifacts.jsonPreview.tree;
          })}
        </Button>
        <Button
          variant={sourceMode ? "neutral" : "quiet"}
          size="sm"
          aria-pressed={sourceMode}
          onClick={() => {
            return selectView("source");
          }}
        >
          {t(($) => {
            return $.artifacts.jsonPreview.source;
          })}
        </Button>
        {!sourceMode && (
          <Button
            variant="quiet"
            size="sm"
            onClick={() => {
              return collapseAll();
            }}
          >
            {t(($) => {
              return $.artifacts.jsonPreview.collapseAll;
            })}
          </Button>
        )}
        <CopyButton
          text={signals.source.text}
          showTooltip={false}
          aria-label={t(($) => {
            return $.artifacts.jsonPreview.copySource;
          })}
          className="ml-auto"
        />
      </div>
      {model.status === "source" && (
        <p
          role="status"
          className="m-0 shrink-0 border-b border-border px-4 py-3 text-sm text-muted-foreground"
        >
          {model.reason === "incomplete"
            ? t(($) => {
                return $.artifacts.jsonPreview.incomplete;
              })
            : model.reason === "invalid"
              ? t(($) => {
                  return $.artifacts.jsonPreview.invalid;
                })
              : t(($) => {
                  return $.artifacts.jsonPreview.complexity;
                })}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {sourceMode ? (
          <pre className="m-0 whitespace-pre-wrap break-words text-sm text-foreground">
            {signals.source.text}
          </pre>
        ) : (
          <>
            <JsonTreeRows signals={signals} />
            <JsonLimitedStatus signals={signals} />
          </>
        )}
      </div>
    </div>
  );
}
