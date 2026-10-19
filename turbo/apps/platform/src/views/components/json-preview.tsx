import { Button, CopyButton, cn } from "@okouai/ui";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import type { TextPreviewContent } from "../../signals/text-preview.ts";
import type {
  JsonPreviewSignals,
  JsonPreviewRow,
} from "../../signals/json-preview.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { formatJsonPreviewText } from "../../lib/json-preview.ts";
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
  readonly row: JsonPreviewRow;
  readonly signals: JsonPreviewSignals;
}) {
  const { t } = useTranslation();
  const toggle = useSet(signals.toggleNode$);
  const node = row.node;
  const indent = INDENTS[Math.min(row.depth, INDENTS.length - 1)];
  if (row.kind === "more") {
    return <JsonPageRow row={row} signals={signals} />;
  }
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

function JsonTreePreview({
  signals,
}: {
  readonly signals: JsonPreviewSignals;
}) {
  const { t } = useTranslation();
  const model = useGet(signals.model$);
  const sourceMode = useGet(signals.sourceMode$);
  const { rows, limited } = useGet(signals.rows$);
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
            {rows.map((row) => {
              return (
                <JsonRow
                  key={`${row.kind}:${String(row.node.offset)}`}
                  row={row}
                  signals={signals}
                />
              );
            })}
            {limited && (
              <p role="status" className="text-sm text-muted-foreground">
                {t(($) => {
                  return $.artifacts.jsonPreview.limited;
                })}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function JsonPreview({
  preview,
  maxCharacters = 65_536,
}: {
  readonly preview: TextPreviewContent;
  readonly maxCharacters?: number;
}) {
  const features = useGet(featureSwitch$);
  if (features[FeatureSwitchKey.JsonTreePreview]) {
    return <JsonTreePreview signals={preview.json} />;
  }
  const formatted = formatJsonPreviewText(preview);
  return (
    <pre className="m-0 h-full overflow-auto whitespace-pre-wrap break-words p-6 text-sm text-foreground">
      {formatted.length > maxCharacters
        ? `${formatted.slice(0, maxCharacters)}\n\n…`
        : formatted}
    </pre>
  );
}
