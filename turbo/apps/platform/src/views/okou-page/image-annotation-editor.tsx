import type { PointerEvent as ReactPointerEvent } from "react";
import { useLastResolved, useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  ArrowUpRight,
  Minus,
  Pencil,
  Plus,
  Redo2,
  Square,
  Trash2,
  Type,
  Undo2,
  X,
} from "lucide-react";
import { Button } from "@okouai/ui/components/ui/button";
import { Dialog, DialogContent } from "@okouai/ui/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui/components/ui/tooltip";
import { cn, Kbd, KbdGroup } from "@okouai/ui";
import type { ImageAnnotationMark } from "@okouai/api-contracts/contracts/chat-threads";
import {
  ANNOTATION_INKS,
  ANNOTATION_RESIZE_EDGES,
  annotationTextBox,
  LABEL_BASE_PX,
  markBounds,
  MAX_TEXT_SCALE,
  MIN_TEXT_SCALE,
  markOrdinal,
  nextMarkOrdinal,
  NOTE_GROUND,
  SELECTION_STROKE,
  STROKE_HALO_INNER,
  textScale,
  type AnnotationArrowEnd,
  type AnnotationDrag,
  type AnnotationInk,
  type AnnotationPoint,
  type AnnotationResizeEdge,
  type AnnotationStroke,
  type AnnotationTarget,
  type AnnotationTool,
  type ImageAnnotationSignals,
} from "../../signals/okou-page/image-annotation.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { MarkNoteLabel, MarkShape } from "./image-annotation-marks.tsx";

const TOOLS: readonly { tool: AnnotationTool; icon: typeof Square }[] = [
  { tool: "box", icon: Square },
  { tool: "arrow", icon: ArrowUpRight },
  { tool: "pen", icon: Pencil },
  { tool: "text", icon: Type },
];

/**
 * A drag shorter than this is a click, not a shape. Without the floor, every
 * stray click while a drawing tool is active would leave a zero-sized mark that
 * is impossible to see and impossible to select in order to delete.
 */
const MIN_DRAG = 0.005;

/** One letter per tool, matching the first letter of each label. */
const TOOL_SHORTCUTS: Readonly<Record<string, AnnotationTool | undefined>> = {
  b: "box",
  a: "arrow",
  d: "pen",
  t: "text",
};

/** The letter shown on each tool's tooltip, so the binding is discoverable. */
const TOOL_KEYS: Readonly<Record<AnnotationTool, string>> = {
  box: "B",
  arrow: "A",
  pen: "D",
  text: "T",
};

/** Zoom direction per key, with `0` meaning "back to fit". */
const ZOOM_SHORTCUTS: Readonly<Record<string, 1 | -1 | 0 | undefined>> = {
  "=": 1,
  "+": 1,
  "-": -1,
  _: -1,
  0: 0,
};

/** One arrow key, one direction. */
const NUDGE_KEYS: Readonly<
  Record<string, { x: number; y: number } | undefined>
> = {
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
};

/**
 * Nudge distance in normalized units — roughly 4px and 20px on a 1000px-wide
 * image. The marks are stored against the image rather than the screen, so a
 * step in pixels would move a mark further on a small image than a large one.
 */
const NUDGE_STEP = 0.004;
const NUDGE_STEP_COARSE = 0.02;

/** A shortcut taken with Cmd/Ctrl held, which a note being typed cannot claim. */
type ChordAction =
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "commit" }
  | { kind: "zoom"; direction: 1 | -1 }
  | { kind: "zoomReset" };

/** A shortcut taken on its own, which only applies when nothing has the caret. */
type BareAction =
  | { kind: "remove" }
  | { kind: "nudge"; x: number; y: number }
  | { kind: "ink"; ink: AnnotationInk }
  | { kind: "tool"; tool: AnnotationTool };

function resolveChord(event: KeyboardEvent): ChordAction | null {
  if (!event.metaKey && !event.ctrlKey) {
    return null;
  }
  if (event.key.toLowerCase() === "z") {
    return event.shiftKey ? { kind: "redo" } : { kind: "undo" };
  }
  if (event.key === "Enter") {
    return { kind: "commit" };
  }
  // The zoom buttons had no keys at all. These are the bindings every viewer
  // already trains people to try, and the modifier keeps them clear of a note.
  const zoom = ZOOM_SHORTCUTS[event.key];
  if (zoom === undefined) {
    return null;
  }
  return zoom === 0 ? { kind: "zoomReset" } : { kind: "zoom", direction: zoom };
}

function resolveBareKey(event: KeyboardEvent): BareAction | null {
  if (event.key === "Delete" || event.key === "Backspace") {
    return { kind: "remove" };
  }
  // Placing a mark by dragging is accurate to whatever the hand did; the arrow
  // keys are how it gets from close to right. Shift covers distance, the bare
  // key covers the last few pixels.
  const nudge = NUDGE_KEYS[event.key];
  if (nudge) {
    const step = event.shiftKey ? NUDGE_STEP_COARSE : NUDGE_STEP;
    return { kind: "nudge", x: nudge.x * step, y: nudge.y * step };
  }
  // The ink swatches are five buttons in a fixed order, so the digits are
  // already their names. With a mark open this recolours it, which is exactly
  // what pressing the swatch does.
  const ink = ANNOTATION_INKS[Number.parseInt(event.key, 10) - 1];
  if (ink !== undefined) {
    return { kind: "ink", ink };
  }
  const tool = TOOL_SHORTCUTS[event.key.toLowerCase()];
  return tool ? { kind: "tool", tool } : null;
}

/** A shortcut must never steal a keystroke aimed at a note being written. */
function isTyping(): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement ||
    (active instanceof HTMLElement && active.isContentEditable)
  );
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function rectFrom(a: AnnotationPoint, b: AnnotationPoint) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

function percent(value: number): string {
  return `${value * 100}%`;
}

function buildMark(
  stroke: AnnotationStroke,
  ink: AnnotationInk,
  previewId?: string,
): ImageAnnotationMark | null {
  const id = previewId ?? crypto.randomUUID();
  const rect = rectFrom(stroke.from, stroke.to);
  const dragged = rect.width > MIN_DRAG || rect.height > MIN_DRAG;

  switch (stroke.tool) {
    case "box": {
      return dragged ? { id, shape: "box", rect, ink } : null;
    }
    case "arrow": {
      return dragged
        ? { id, shape: "arrow", from: stroke.from, to: stroke.to, ink }
        : null;
    }
    case "pen": {
      return stroke.points.length > 1
        ? { id, shape: "pen", points: [...stroke.points], ink }
        : null;
    }
    case "text": {
      return { id, shape: "text", at: stroke.from, text: "", ink };
    }
  }
}

function noteOf(mark: ImageAnnotationMark): string {
  if (mark.shape === "text") {
    return mark.text;
  }
  if (mark.shape === "highlight" || mark.shape === "redact") {
    return "";
  }
  return mark.note ?? "";
}

/**
 * Each label is reached through a literal accessor rather than an index on the
 * tool name: the i18n extractor reads these statically, and a dynamic lookup
 * would silently leave the keys out of every locale file.
 */
function useToolLabel(): (tool: AnnotationTool) => string {
  const { t } = useTranslation();
  return (tool: AnnotationTool): string => {
    switch (tool) {
      case "box": {
        return t(($) => {
          return $.artifacts.annotation.tools.box;
        });
      }
      case "arrow": {
        return t(($) => {
          return $.artifacts.annotation.tools.arrow;
        });
      }
      case "pen": {
        return t(($) => {
          return $.artifacts.annotation.tools.pen;
        });
      }
      case "text": {
        return t(($) => {
          return $.artifacts.annotation.tools.text;
        });
      }
    }
  };
}

function InkSwatches({
  signals,
}: {
  readonly signals: ImageAnnotationSignals;
}) {
  const { t } = useTranslation();
  const ink = useGet(signals.annotationInk$);
  const setInk = useSet(signals.setAnnotationInk$);

  return (
    <div className="flex items-center gap-0.5 px-1">
      {ANNOTATION_INKS.map((candidate) => {
        const active = candidate === ink;
        return (
          <Tooltip key={candidate}>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="quiet"
                  size="icon-xs"
                  aria-pressed={active}
                  aria-label={t(
                    ($) => {
                      return $.artifacts.annotation.inkLabel;
                    },
                    { color: candidate },
                  )}
                  onClick={() => {
                    setInk(candidate);
                  }}
                  className={cn(active && "bg-state-selected")}
                >
                  <span
                    style={{
                      background: candidate,
                      // The ring is the ink itself, held off the swatch by the
                      // toolbar colour, so the selected colour is announced by
                      // the colour rather than by two pixels of extra diameter.
                      boxShadow: active
                        ? `0 0 0 2px hsl(var(--background)), 0 0 0 4px ${candidate}`
                        : "none",
                    }}
                    className={cn(
                      "rounded-full transition-all",
                      active ? "h-3.5 w-3.5" : "h-4 w-4",
                    )}
                  />
                </Button>
              }
            />
            <TooltipContent>{candidate}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

function ZoomControls({
  signals,
}: {
  readonly signals: ImageAnnotationSignals;
}) {
  const { t } = useTranslation();
  const zoom = useGet(signals.annotationZoom$);
  const zoomBy = useSet(signals.zoomAnnotation$);
  const resetZoom = useSet(signals.resetAnnotationZoom$);

  return (
    <div className="absolute right-4 top-4 z-20 flex items-center gap-1 rounded-lg border border-border bg-background px-1.5 py-1 shadow-sm">
      <Button
        showTooltip
        type="button"
        variant="quiet"
        size="icon-xs"
        onClick={() => {
          zoomBy(-1);
        }}
        aria-label={t(($) => {
          return $.artifacts.actions.zoomOut;
        })}
      >
        <Minus size={14} />
      </Button>
      <button
        type="button"
        onClick={resetZoom}
        className="min-w-10 rounded-md px-1 text-center text-xs font-medium tabular-nums text-foreground transition-colors hover:bg-state-hover"
      >
        {Math.round(zoom * 100)}%
      </button>
      <Button
        showTooltip
        type="button"
        variant="quiet"
        size="icon-xs"
        onClick={() => {
          zoomBy(1);
        }}
        aria-label={t(($) => {
          return $.artifacts.actions.zoomIn;
        })}
      >
        <Plus size={14} />
      </Button>
    </div>
  );
}

/**
 * Undo, redo, and delete the open mark.
 *
 * They sit in the pill rather than up in the header because that is where the
 * hand already is — Tong asked for the three of them together next to the
 * tools. Delete is the only way back for a mark whose words are worth keeping;
 * emptying the field and pressing backspace is the other.
 */
function PillActions({
  signals,
}: {
  readonly signals: ImageAnnotationSignals;
}) {
  const { t } = useTranslation();
  const canUndo = useGet(signals.annotationCanUndo$);
  const canRedo = useGet(signals.annotationCanRedo$);
  const openMarkId = useGet(signals.annotationOpenMarkId$);
  const undo = useSet(signals.undoAnnotation$);
  const redo = useSet(signals.redoAnnotation$);
  const removeSelected = useSet(signals.removeSelectedAnnotationMark$);

  const actions = [
    {
      key: "undo",
      icon: Undo2,
      disabled: !canUndo,
      run: undo,
      label: t(($) => {
        return $.artifacts.annotation.undo;
      }),
    },
    {
      key: "redo",
      icon: Redo2,
      disabled: !canRedo,
      run: redo,
      label: t(($) => {
        return $.artifacts.annotation.redo;
      }),
    },
    {
      key: "remove",
      icon: Trash2,
      disabled: openMarkId === null,
      run: removeSelected,
      label: t(($) => {
        return $.artifacts.annotation.removeMark;
      }),
    },
  ];

  return (
    <>
      {actions.map(({ key, icon: Icon, disabled, run, label }) => {
        return (
          <Button
            key={key}
            showTooltip
            type="button"
            variant="quiet"
            size="icon-sm"
            disabled={disabled}
            onClick={run}
            aria-label={label}
          >
            <Icon size={16} />
          </Button>
        );
      })}
    </>
  );
}

function ToolPill({ signals }: { readonly signals: ImageAnnotationSignals }) {
  const tool = useGet(signals.annotationTool$);
  const setTool = useSet(signals.setAnnotationTool$);
  const toolLabel = useToolLabel();

  return (
    <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-border bg-background p-1.5 shadow-lg">
      {TOOLS.map(({ tool: candidate, icon: Icon }) => {
        return (
          <Tooltip key={candidate}>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="quiet"
                  size="icon-sm"
                  aria-pressed={tool === candidate}
                  aria-label={toolLabel(candidate)}
                  onClick={() => {
                    setTool(candidate);
                  }}
                  className={cn(
                    tool === candidate &&
                      "bg-state-selected text-foreground hover:bg-state-selected-hover",
                  )}
                >
                  <Icon size={16} />
                </Button>
              }
            />
            <TooltipContent>
              <KbdGroup>
                {toolLabel(candidate)}
                <Kbd>{TOOL_KEYS[candidate]}</Kbd>
              </KbdGroup>
            </TooltipContent>
          </Tooltip>
        );
      })}
      <span className="mx-1 h-[18px] w-px bg-divider" />
      <InkSwatches signals={signals} />
      <span className="mx-1 h-[18px] w-px bg-border" />
      <PillActions signals={signals} />
    </div>
  );
}

/**
 * The padding on the field and on the invisible copy that sizes it. One
 * constant because the two have to agree to the pixel: the copy is what decides
 * where the text wraps, and a field that wraps one character earlier than its
 * sizer scrolls instead of growing.
 */
// The vertical value is written out because a browser gives a textarea padding
// of its own, and the copy that sizes it would not have it.
const LABEL_PAD = "px-0.5 py-0";
const NOTE_PAD = "px-1.5 py-1";

/** The four corners of a label, in the order a reader would name them. */
const LABEL_CORNERS = ["tl", "tr", "bl", "br"] as const;

type LabelCorner = (typeof LABEL_CORNERS)[number];

/**
 * The grips that resize a label.
 *
 * A label has no rectangle in the model — its box is whatever the words fill —
 * so the handles hang off the field's own corners rather than off stored
 * geometry, and the drag reads the rendered box when the grip is taken. Only
 * labels get these: a note explains a shape that already has its own size, and
 * Tong asked for them on text alone.
 */
function LabelScaleHandles({
  onGrab,
}: {
  readonly onGrab: (
    corner: LabelCorner,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
}) {
  return (
    <>
      {LABEL_CORNERS.map((corner) => {
        const vertical = corner.startsWith("t") ? "-top-1.5" : "-bottom-1.5";
        const horizontal = corner.endsWith("l") ? "-left-1.5" : "-right-1.5";
        return (
          <span
            key={corner}
            role="presentation"
            onPointerDown={(event) => {
              onGrab(corner, event);
            }}
            className={cn(
              "absolute h-2.5 w-2.5 rounded-full border border-border bg-background shadow-sm",
              corner === "tl" || corner === "br"
                ? "cursor-nwse-resize"
                : "cursor-nesw-resize",
              vertical,
              horizontal,
            )}
            data-testid={`annotation-label-handle-${corner}`}
          />
        );
      })}
    </>
  );
}

/**
 * The one field both kinds of mark are written in, drawn on the image itself.
 *
 * A box's note used to be typed into a floating card while the sentence
 * appeared on the picture, and the card was a fixed 288px, so a note longer
 * than the field scrolled out of sight while it was being written — Tong:
 * *"用户如果输入更多text，展示不全内容。要不我们就把图形mark增加文字的时候也像
 * text mark一样，直接在图片上输入"*. The field is now the label: same position,
 * same ground, same metrics, wrapping at the same ceiling the flattened copy
 * uses, so nothing is hidden and nothing is shown twice.
 */
function InlineMarkEditor({
  mark,
  onGrabCorner,
  signals,
}: {
  readonly mark: ImageAnnotationMark;
  readonly onGrabCorner: (
    corner: LabelCorner,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
  readonly signals: ImageAnnotationSignals;
}) {
  const { t } = useTranslation();
  const setNote = useSet(signals.setAnnotationMarkNote$);
  const bindNoteField = useSet(signals.bindAnnotationNoteField$);
  const removeMark = useSet(signals.removeAnnotationMark$);
  const deselect = useSet(signals.selectAnnotationMark$);
  const focusPanel = useSet(signals.focusAnnotationPanel$);

  // Neither shape carries words, so neither has anything to open here.
  if (mark.shape === "highlight" || mark.shape === "redact") {
    return null;
  }

  const isLabel = mark.shape === "text";
  const value = noteOf(mark);
  const box = annotationTextBox(mark);
  // A name for the field, not a prompt printed on the picture. Tong: *"text 不
  // 要展示提示文字，只需要一个鼠标丨 闪烁就成，让用户直接输入文字"* — so this
  // reaches assistive technology and the tests, and nothing else.
  const fieldLabel = isLabel
    ? t(($) => {
        return $.artifacts.annotation.textPlaceholder;
      })
    : t(($) => {
        return $.artifacts.annotation.notePlaceholder;
      });
  // Dismissing the field hands the keyboard back to the editor. Letting focus
  // fall to the document body instead left the panel out of the tab order for
  // the rest of the session.
  const dismiss = () => {
    deselect(null);
    focusPanel();
  };

  return (
    <span
      style={{
        left: percent(box.x),
        top: percent(box.y),
        maxWidth: percent(box.maxWidth),
        // The size the corners set, on the field and on the copy that measures
        // it alike, so resizing and typing agree about where the words wrap.
        // The outline is what says the label is the thing selected: a dashed
        // frame held off the words far enough to sit inside the corner grips,
        // in the one fixed selection colour rather than the mark's own ink.
        // `outline` rather than a border, because a border would take width
        // from the text and move where it wraps.
        ...(isLabel
          ? {
              fontSize: `${LABEL_BASE_PX * textScale(mark)}px`,
              outline: `1px dashed ${SELECTION_STROKE}`,
              outlineOffset: "3px",
            }
          : { background: NOTE_GROUND }),
      }}
      // The field lives inside the drawing surface so it can sit on the mark,
      // which means a press on it would otherwise start a stroke underneath.
      // Only the press is stopped: a release has to reach the surface, or a
      // drag that ends over this field never ends at all.
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
      className={cn(
        // `select-text` and the caret cursor are the surface's own
        // `select-none cursor-crosshair` being undone: a field that cannot be
        // selected in, under a crosshair, does not read as somewhere to type.
        // The empty field is a caret and nothing else, so it needs a little
        // width of its own to be seen and to be clicked back into.
        "absolute z-30 grid min-w-4 select-text",
        // `leading-tight` rather than the line height inside `text-sm`: the
        // size is set inline by the corner handles, and a fixed 20px line box
        // would keep the rows of a scaled-up label on top of each other.
        isLabel
          ? "font-bold leading-tight"
          : "rounded-md text-[11px] font-semibold leading-snug",
      )}
      data-testid="annotation-inline-editor"
    >
      {/* An invisible copy of the contents in the same grid cell is what gives
          the field its size, so the box grows with the words instead of
          scrolling them. The zero-width space keeps a trailing newline from
          collapsing the last, empty line. */}
      <span
        aria-hidden
        className={cn(
          "invisible col-start-1 row-start-1 whitespace-pre-wrap break-words",
          isLabel ? LABEL_PAD : NOTE_PAD,
        )}
      >
        {value}
        {"\u200b"}
      </span>
      <textarea
        // Not the shared `Input`: this one is ink on a screenshot, so the
        // border, ground and ring that make a field legible in a form are
        // exactly what must not appear over the user's image.
        // `bindAnnotationNoteField$` owns the caret: focus belongs in `onRef`
        // (docs/effect.md), and a mount-time attribute cannot fire again when
        // the field is reused for the next mark.
        ref={bindNoteField}
        rows={1}
        value={value}
        aria-label={fieldLabel}
        style={{
          color: mark.ink,
          caretColor: mark.ink,
          ...(isLabel
            ? {
                textShadow: `0 0 3px ${STROKE_HALO_INNER}, 0 0 3px ${STROKE_HALO_INNER}`,
              }
            : {}),
        }}
        onChange={(event) => {
          setNote(mark.id, event.target.value);
        }}
        onKeyDown={(event) => {
          // Enter finishes the sentence; Shift+Enter breaks the line, which is
          // the only reason this is a textarea rather than one long line. The
          // text is already saved on every keystroke, so finishing only puts
          // the caret away. Cmd/Ctrl+Enter is left alone: the global handler
          // reads it as "attach the whole annotation".
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.metaKey &&
            !event.ctrlKey
          ) {
            event.preventDefault();
            dismiss();
            return;
          }
          // Backspace edits the text, and once the field is empty the next
          // press takes the mark with it. That is the whole delete path now —
          // Tong: *"所有text 都不需要加delete button，让用户直接退回删除或者全选
          // text删除就成"* — so a mark can always be undone by emptying it,
          // and Cmd+Z is there for a press too many.
          if (
            (event.key === "Backspace" || event.key === "Delete") &&
            value.length === 0
          ) {
            event.preventDefault();
            removeMark(mark.id);
            focusPanel();
          }
        }}
        className={cn(
          "col-start-1 row-start-1 w-full cursor-text resize-none overflow-hidden bg-transparent outline-none",
          isLabel ? LABEL_PAD : NOTE_PAD,
        )}
      />
      {isLabel && <LabelScaleHandles onGrab={onGrabCorner} />}
    </span>
  );
}

function EditorHeader({
  filename,
  signals,
}: {
  readonly filename: string;
  readonly signals: ImageAnnotationSignals;
}) {
  const { t } = useTranslation();
  const annotation = useGet(signals.annotationDraft$);
  const close = useSet(signals.closeAnnotationEditor$);

  return (
    <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border/70 pl-4 pr-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{filename}</div>
        <div className="truncate text-xs text-muted-foreground">
          {t(
            ($) => {
              return $.artifacts.annotation.subtitle;
            },
            { count: annotation.marks.length },
          )}
        </div>
      </div>
      <Button
        showTooltip
        type="button"
        variant="quiet"
        size="icon-sm"
        onClick={close}
        aria-label={t(($) => {
          return $.artifacts.actions.close;
        })}
      >
        <X size={18} />
      </Button>
    </div>
  );
}

function EditorFooter({
  signals,
}: {
  readonly signals: ImageAnnotationSignals;
}) {
  const { t } = useTranslation();
  const close = useSet(signals.closeAnnotationEditor$);
  const commit = useSet(signals.commitAnnotation$);
  const pageSignal = useGet(pageSignal$);
  // Nothing drawn, nothing to attach — an enabled button here promises an edit
  // the session does not have.
  const dirty = useGet(signals.annotationDirty$);

  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-t border-border bg-card px-4">
      <span className="text-xs text-muted-foreground">
        {t(($) => {
          return $.artifacts.annotation.draftOnly;
        })}
      </span>
      <div className="flex-1" />
      <Button type="button" variant="quiet" size="sm" onClick={close}>
        {t(($) => {
          return $.chat.actions.cancel;
        })}
      </Button>
      <Button
        type="button"
        size="sm"
        disabled={!dirty}
        onClick={() => {
          detach(commit(pageSignal), Reason.DomCallback);
        }}
      >
        {t(($) => {
          return $.artifacts.annotation.attach;
        })}
      </Button>
    </div>
  );
}

/**
 * The editor's keyboard surface. Every binding steps aside while a field has
 * focus, so typing a note never triggers a shortcut.
 */
function KeyboardShortcuts({
  signals,
}: {
  readonly signals: ImageAnnotationSignals;
}) {
  const removeSelected = useSet(signals.removeSelectedAnnotationMark$);
  const selectMark = useSet(signals.selectAnnotationMark$);
  const setTool = useSet(signals.setAnnotationTool$);
  const setInk = useSet(signals.setAnnotationInk$);
  const nudgeMark = useSet(signals.nudgeAnnotationMark$);
  const zoomBy = useSet(signals.zoomAnnotation$);
  const resetZoom = useSet(signals.resetAnnotationZoom$);
  const undo = useSet(signals.undoAnnotation$);
  const redo = useSet(signals.redoAnnotation$);
  const close = useSet(signals.closeAnnotationEditor$);
  const commit = useSet(signals.commitAnnotation$);
  // The mark the editor has OPEN, not the one selected for reshaping. Escape
  // backs out one layer, and with a note open `annotationSelectedMarkId$` is
  // null — so Escape took the `else` and closed the whole session, discarding
  // every mark drawn so far. Clicking a note to edit it and pressing Escape to
  // dismiss the caret is now the primary path, which made that the likely one.
  const selectedId = useGet(signals.annotationOpenMarkId$);
  const focusPanel = useSet(signals.focusAnnotationPanel$);
  const pageSignal = useGet(pageSignal$);
  let cleanup: (() => void) | null = null;

  const runChord = (action: ChordAction) => {
    switch (action.kind) {
      case "undo": {
        undo();
        return;
      }
      case "redo": {
        redo();
        return;
      }
      case "commit": {
        detach(commit(pageSignal), Reason.DomCallback);
        return;
      }
      case "zoom": {
        zoomBy(action.direction);
        return;
      }
      case "zoomReset": {
        resetZoom();
      }
    }
  };

  const runBareKey = (action: BareAction) => {
    switch (action.kind) {
      case "remove": {
        removeSelected();
        return;
      }
      case "nudge": {
        nudgeMark(action.x, action.y);
        return;
      }
      case "ink": {
        setInk(action.ink);
        return;
      }
      case "tool": {
        setTool(action.tool);
      }
    }
  };

  return (
    <span
      ref={(node) => {
        cleanup?.();
        cleanup = null;
        if (!node) {
          return;
        }
        const onKeyDown = (event: KeyboardEvent) => {
          // A keystroke an input method is still composing belongs to the word
          // being written, not to a shortcut: picking a candidate for a Chinese
          // or Japanese note would otherwise switch tools underneath it.
          if (event.isComposing || event.keyCode === 229) {
            return;
          }
          const chord = resolveChord(event);
          if (chord) {
            event.preventDefault();
            runChord(chord);
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            // Escape backs out one layer at a time: the selection first, the
            // editor only once nothing is selected. Leaving a note also hands
            // the keyboard back to the panel, so the next tool letter is read
            // as a tool letter rather than typed into the field just left.
            if (selectedId) {
              selectMark(null);
              focusPanel();
            } else {
              close();
            }
            return;
          }
          if (isTyping()) {
            return;
          }
          const bare = resolveBareKey(event);
          if (!bare) {
            return;
          }
          // Switching tools throws the open mark away, so a tool letter only
          // counts while nothing is open — Tong: *"我在输入文字的时候，如果按到
          // 了快捷按钮，也不应该直接切换mark啊，只有为未选中任何mark的情况，按快
          // 捷按钮才会切换功能项"*. The caret can also be a frame late, and a
          // keystroke that lands in that gap must not cost the mark. The rest of
          // the bare keys act *on* the open mark, so they stay.
          if (bare.kind === "tool" && selectedId !== null) {
            return;
          }
          event.preventDefault();
          runBareKey(bare);
        };
        document.addEventListener("keydown", onKeyDown, true);
        cleanup = () => {
          document.removeEventListener("keydown", onKeyDown, true);
        };
      }}
      hidden
    />
  );
}

interface StrokeHandlers {
  beginDrag: (drag: AnnotationDrag) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (
    event: ReactPointerEvent<HTMLDivElement>,
    applyDrag: (
      drag: AnnotationDrag,
      rect: { x: number; y: number; width: number; height: number },
      point: AnnotationPoint,
    ) => void,
  ) => void;
  onPointerUp: () => void;
}

function draggedRect(drag: AnnotationDrag, point: AnnotationPoint) {
  const dx = point.x - drag.origin.x;
  const dy = point.y - drag.origin.y;
  const start = drag.startRect;

  if (drag.mode === "move") {
    return {
      x: clamp01(start.x + dx),
      y: clamp01(start.y + dy),
      width: start.width,
      height: start.height,
    };
  }

  // An edge grip moves one side; a corner grip moves two. Anything the grip
  // does not touch keeps its start value, so dragging the top edge cannot
  // shift the box sideways.
  const corner = drag.corner ?? "br";
  const movesLeft = corner === "tl" || corner === "bl" || corner === "l";
  const movesRight = corner === "tr" || corner === "br" || corner === "r";
  const movesTop = corner === "tl" || corner === "tr" || corner === "t";
  const movesBottom = corner === "bl" || corner === "br" || corner === "b";

  const x1 = movesLeft ? start.x + dx : start.x;
  const y1 = movesTop ? start.y + dy : start.y;
  const x2 = movesRight ? start.x + start.width + dx : start.x + start.width;
  const y2 = movesBottom ? start.y + start.height + dy : start.y + start.height;
  return {
    x: clamp01(Math.min(x1, x2)),
    y: clamp01(Math.min(y1, y2)),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

function useStrokeHandlers(signals: ImageAnnotationSignals): StrokeHandlers {
  const tool = useGet(signals.annotationTool$);
  const ink = useGet(signals.annotationInk$);
  const stroke = useGet(signals.annotationStroke$);
  const drag = useGet(signals.annotationDrag$);
  const surface = useGet(signals.annotationSurface$);
  const setStroke = useSet(signals.setAnnotationStroke$);
  const setDrag = useSet(signals.setAnnotationDrag$);
  const addMark = useSet(signals.addAnnotationMark$);
  const selectMark = useSet(signals.selectAnnotationMark$);

  const pointAt = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = surface?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) {
      return null;
    }
    return {
      x: clamp01((event.clientX - rect.left) / rect.width),
      y: clamp01((event.clientY - rect.top) / rect.height),
    };
  };

  return {
    beginDrag: setDrag,
    onPointerDown: (event) => {
      const point = pointAt(event);
      if (!point) {
        return;
      }
      // Starting a stroke on bare canvas also clears the selection, so the
      // handles and note of the previous mark do not linger over a new one.
      // One call is enough: a null selection has no kind, and clearing it
      // through both commands only read as if it did.
      selectMark(null);
      event.currentTarget.setPointerCapture(event.pointerId);
      setStroke({ tool, from: point, to: point, points: [point] });
    },
    onPointerMove: (event, applyDrag) => {
      const point = pointAt(event);
      if (!point) {
        return;
      }
      if (drag) {
        applyDrag(drag, draggedRect(drag, point), point);
        return;
      }
      if (!stroke) {
        return;
      }
      setStroke({
        ...stroke,
        to: point,
        points:
          stroke.tool === "pen" ? [...stroke.points, point] : stroke.points,
      });
    },
    onPointerUp: () => {
      if (drag) {
        setDrag(null);
        return;
      }
      if (!stroke) {
        return;
      }
      const mark = buildMark(stroke, ink);
      if (mark) {
        // Adding selects the mark, so its note opens straight away — a shape
        // and the sentence explaining it are one gesture. The tool stays put,
        // so several boxes in a row do not need it re-picked.
        addMark(mark);
      }
      setStroke(null);
    },
  };
}

type ResizeCorner = AnnotationResizeEdge;

/**
 * The box a drag works against.
 *
 * An arrow and a freehand stroke get their bounding box rather than `null`:
 * they cannot be resized, but a move is expressed as "put this box there", and
 * returning nothing here is what used to make `grabMark` bail out before the
 * drag even started — so a stroke could be clicked and then not moved.
 */
function rectOf(mark: ImageAnnotationMark) {
  if (mark.shape === "box") {
    return mark.rect;
  }
  if (mark.shape === "text") {
    return { x: mark.at.x, y: mark.at.y, width: 0, height: 0 };
  }
  return markBounds(mark);
}

function cornerCursor(corner: ResizeCorner): string {
  switch (corner) {
    case "tl":
    case "br": {
      return "cursor-nwse-resize";
    }
    case "tr":
    case "bl": {
      return "cursor-nesw-resize";
    }
    case "t":
    case "b": {
      return "cursor-ns-resize";
    }
    case "l":
    case "r": {
      return "cursor-ew-resize";
    }
  }
}

/**
 * Edges first so the corner dots paint over their ends — otherwise the strip
 * covering the top edge would swallow the grab on both top corners.
 */
const ORDERED_HANDLES = [...ANNOTATION_RESIZE_EDGES].sort((a, b) => {
  return a.length - b.length;
});

/** Where a grip sits on the mark, as a fraction of its own box. */
function handleAnchor(corner: ResizeCorner): { fx: number; fy: number } {
  const fx = corner.includes("l") ? 0 : corner.includes("r") ? 1 : 0.5;
  const fy = corner.includes("t") ? 0 : corner.includes("b") ? 1 : 0.5;
  return { fx, fy };
}

/** The dot every grip is drawn as, so all three kinds read as one control. */
const GRIP_CLASS =
  "absolute -ml-[5px] -mt-[5px] h-2.5 w-2.5 rounded-full border border-border bg-background shadow-sm";

/**
 * The two ends of a selected arrow.
 *
 * An arrow is not resized by a box — it is aimed — so its grips sit on the tail
 * and the tip and each one carries that end to the pointer. Dragging the tip is
 * what changes the direction; dragging the shaft between them moves the whole
 * arrow without changing where it points.
 */
function ArrowEndpointHandles({
  mark,
  onGrab,
}: {
  mark: ImageAnnotationMark;
  onGrab: (
    endpoint: AnnotationArrowEnd,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
}) {
  if (mark.shape !== "arrow") {
    return null;
  }

  return (
    <>
      {(["from", "to"] as const).map((endpoint) => {
        const point = mark[endpoint];
        return (
          <span
            key={endpoint}
            role="presentation"
            onPointerDown={(event) => {
              onGrab(endpoint, event);
            }}
            style={{ left: percent(point.x), top: percent(point.y) }}
            className={cn(GRIP_CLASS, "cursor-grab")}
            data-testid={`annotation-handle-${endpoint}`}
          />
        );
      })}
    </>
  );
}

/**
 * Handles only appear for marks that have a rectangle. A freehand stroke or an
 * arrow can still be selected and deleted; resizing them would mean editing
 * every point, which is not what a handle promises.
 *
 * Only the corners are drawn. The edges are grabbable too — dragging one
 * changes width or height alone — but four dots and four bars around a small
 * box is more furniture than the shape underneath, so the edges are invisible
 * strips that only announce themselves through the cursor.
 */
function ResizeHandles({
  mark,
  onGrab,
}: {
  mark: ImageAnnotationMark;
  onGrab: (corner: ResizeCorner, event: ReactPointerEvent<HTMLElement>) => void;
}) {
  const rect = rectOf(mark);
  if (!rect || rect.width === 0) {
    return null;
  }

  return (
    <>
      {ORDERED_HANDLES.map((corner) => {
        const { fx, fy } = handleAnchor(corner);
        const horizontal = corner === "t" || corner === "b";
        const vertical = corner === "l" || corner === "r";
        return (
          <span
            key={corner}
            role="presentation"
            onPointerDown={(event) => {
              onGrab(corner, event);
            }}
            style={{
              left: percent(rect.x + rect.width * fx),
              top: percent(rect.y + rect.height * fy),
              ...(horizontal ? { width: percent(rect.width) } : {}),
              ...(vertical ? { height: percent(rect.height) } : {}),
            }}
            className={cn(
              "absolute",
              cornerCursor(corner),
              horizontal && "-mt-[5px] h-2.5 -translate-x-1/2",
              vertical && "-ml-[5px] w-2.5 -translate-y-1/2",
              !horizontal && !vertical && GRIP_CLASS,
            )}
            data-testid={`annotation-handle-${corner}`}
          />
        );
      })}
    </>
  );
}

/**
 * Every note printed on the image.
 *
 * A note is NOT a free object. It is placed by `defaultNoteBox` under the mark
 * it explains, and clicking it opens that mark's sentence for editing — Tong:
 * *"mark 标注的文字还是不要让用户随便拖动了。另外标注文字点击也可以进行文本编辑，
 * 现在是拖动"*. It used to carry its own move drag and a width grip, which meant
 * the one gesture a label invites — click the words, change the words — was the
 * one thing it did not do.
 */
function NoteLayer({
  marks,
  openMarkId,
  signals,
}: {
  readonly marks: readonly ImageAnnotationMark[];
  readonly openMarkId: string | null;
  readonly signals: ImageAnnotationSignals;
}) {
  const openNote = useSet(signals.selectAnnotationNote$);

  return (
    <>
      {marks.map((mark) => {
        // The note being written is drawn by its own field, in the same place
        // and the same metrics — printing it here as well would show one
        // sentence twice, a pixel apart.
        if (mark.id === openMarkId) {
          return null;
        }
        return (
          <MarkNoteLabel
            key={`${mark.id}-note`}
            mark={mark}
            onSelect={() => {
              openNote(mark.id);
            }}
          />
        );
      })}
    </>
  );
}

/**
 * What the selected mark shows, which depends on what it can be reshaped into.
 *
 * A box has eight grips and an arrow has its two ends. A stroke has neither, so
 * it draws nothing: the only geometry available to mark it out is its bounding
 * box, and a rectangle that is not part of the drawing reads as an accidental
 * mark on the user's screenshot.
 */
function SelectionLayer({
  mark,
  onGrabEndpoint,
  onGrabHandle,
}: {
  readonly mark: ImageAnnotationMark | undefined;
  readonly onGrabEndpoint: (
    endpoint: AnnotationArrowEnd,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
  readonly onGrabHandle: (
    corner: ResizeCorner,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
}) {
  if (!mark) {
    return null;
  }
  if (mark.shape === "arrow") {
    return <ArrowEndpointHandles mark={mark} onGrab={onGrabEndpoint} />;
  }
  // A freehand stroke shows nothing extra. It briefly carried a dashed box
  // around its extent, which read as a stray rectangle drawn on the screenshot
  // rather than as a state — Tong: *"不需要有这个虚线，去掉虚线"*. Picking one
  // already opens its note popover, so the selection is not silent.
  if (mark.shape === "pen") {
    return null;
  }
  return <ResizeHandles mark={mark} onGrab={onGrabHandle} />;
}

/**
 * Hands the rest of the gesture to the drawing surface.
 *
 * A drag that starts on a mark never touches the surface's own `pointerdown`
 * — the mark stops it, or a new stroke would start under the mark being moved
 * — so the surface never captured the pointer either, and the release was
 * delivered to whatever happened to be under the cursor. Releasing over the
 * field a text mark is typed in therefore lost the `pointerup` to that field's
 * own handler, the drag was never cleared, and the mark went on following the
 * mouse with no button held — Tong: *"只是松开鼠标，text还是跟着鼠标走"*.
 * Capturing on the surface makes every later event of this gesture arrive
 * there, whatever it passes over.
 */
function captureOnSurface(
  surface: HTMLElement | null,
  event: ReactPointerEvent<Element>,
): void {
  surface?.setPointerCapture(event.pointerId);
}

/** Starts a resize from whichever grip was grabbed on the selected mark. */
function useGrabHandle(
  signals: ImageAnnotationSignals,
  selectedMark: ImageAnnotationMark | undefined,
): (corner: ResizeCorner, event: ReactPointerEvent<HTMLElement>) => void {
  const surface = useGet(signals.annotationSurface$);
  const beginDrag = useSet(signals.setAnnotationDrag$);

  return (corner, event) => {
    // The handle sits on the drawing surface, so without this the grab also
    // starts a new stroke underneath the mark being resized.
    event.stopPropagation();
    if (!selectedMark) {
      return;
    }
    const rect = rectOf(selectedMark);
    const bounds = surface?.getBoundingClientRect();
    if (!rect || !bounds || bounds.width === 0) {
      return;
    }
    captureOnSurface(surface, event);
    beginDrag({
      markId: selectedMark.id,
      mode: "resize",
      corner,
      origin: {
        x: (event.clientX - bounds.left) / bounds.width,
        y: (event.clientY - bounds.top) / bounds.height,
      },
      startRect: rect,
    });
  };
}

/** Starts an arrow re-aim from the tail or the tip. */
function useGrabEndpoint(
  signals: ImageAnnotationSignals,
  selectedMark: ImageAnnotationMark | undefined,
): (
  endpoint: AnnotationArrowEnd,
  event: ReactPointerEvent<HTMLElement>,
) => void {
  const surface = useGet(signals.annotationSurface$);
  const beginDrag = useSet(signals.setAnnotationDrag$);

  return (endpoint, event) => {
    event.stopPropagation();
    const bounds = surface?.getBoundingClientRect();
    if (!selectedMark || !bounds || bounds.width === 0) {
      return;
    }
    captureOnSurface(surface, event);
    beginDrag({
      markId: selectedMark.id,
      mode: "endpoint",
      endpoint,
      origin: {
        x: (event.clientX - bounds.left) / bounds.width,
        y: (event.clientY - bounds.top) / bounds.height,
      },
      // An endpoint drag reads the pointer directly, so it has no start box to
      // measure against. The field is on the record for move and resize.
      startRect: { x: 0, y: 0, width: 0, height: 0 },
    });
  };
}

/**
 * Every mark on the image, except the one currently being typed: that one is
 * drawn by its own field, or the same words would be painted twice.
 */
function MarkLayer({
  aspect,
  marks,
  openMarkId,
  onGrab,
  onSelect,
}: {
  readonly aspect: number;
  readonly marks: readonly ImageAnnotationMark[];
  readonly openMarkId: string | null;
  readonly onGrab: (
    mark: ImageAnnotationMark,
    event: ReactPointerEvent<Element>,
  ) => void;
  readonly onSelect: (id: string) => void;
}) {
  return (
    <>
      {marks.map((mark, index) => {
        if (mark.shape === "text" && mark.id === openMarkId) {
          return null;
        }
        return (
          <MarkShape
            key={mark.id}
            mark={mark}
            ordinal={markOrdinal(mark, index)}
            aspect={aspect}
            onSelect={() => {
              onSelect(mark.id);
            }}
            onGrab={(event) => {
              onGrab(mark, event);
            }}
          />
        );
      })}
    </>
  );
}

/**
 * Makes the scrolling stage a size query container, so the image can be bounded
 * by the box it is actually in.
 *
 * The fit used to be written as fractions of the *viewport* — `min(880px, 88vw)`
 * by `min(520px, 62vh)` — which is a guess at the stage that stops being true
 * the moment anything around it changes size. `100cqw`/`100cqh` are that box.
 */
const STAGE_QUERY_CONTAINER = { containerType: "size" } as const;

/**
 * Where a label's corner drag is measured from, and what it lands on.
 *
 * The corner opposite the one in hand is pinned, so the label grows away from
 * the pointer rather than from wherever the words start. Size comes from the
 * ratio of the two distances to that pinned corner, in on-screen pixels —
 * normalized units would stretch the gesture on a non-square image.
 */
function scaledLabel(
  drag: AnnotationDrag,
  point: AnnotationPoint,
  aspect: number,
): { scale: number; at: AnnotationPoint } | null {
  const corner = drag.corner;
  const startScale = drag.startScale;
  if (!corner || startScale === undefined) {
    return null;
  }
  const start = drag.startRect;
  const pinned = {
    x: corner.endsWith("l") ? start.x + start.width : start.x,
    y: corner.startsWith("t") ? start.y + start.height : start.y,
  };
  const reach = (from: AnnotationPoint) => {
    return Math.hypot((from.x - pinned.x) * aspect, from.y - pinned.y);
  };
  const before = reach(drag.origin);
  if (before === 0) {
    return null;
  }
  const scale = Math.min(
    MAX_TEXT_SCALE,
    Math.max(MIN_TEXT_SCALE, (startScale * reach(point)) / before),
  );
  const grown = scale / startScale;
  const width = start.width * grown;
  const height = start.height * grown;
  return {
    scale,
    at: {
      x: clamp01(corner.endsWith("l") ? pinned.x - width : pinned.x),
      y: clamp01(corner.startsWith("t") ? pinned.y - height : pinned.y),
    },
  };
}

/** Starts a label resize from whichever corner was taken. */
function useGrabLabelCorner(
  signals: ImageAnnotationSignals,
  mark: ImageAnnotationMark | undefined,
): (corner: LabelCorner, event: ReactPointerEvent<HTMLElement>) => void {
  const surface = useGet(signals.annotationSurface$);
  const beginDrag = useSet(signals.setAnnotationDrag$);

  return (corner, event) => {
    // The grip sits on the field, which sits on the surface: without this the
    // grab would put the caret in the words it is trying to resize.
    event.stopPropagation();
    event.preventDefault();
    const field = event.currentTarget.parentElement;
    const bounds = surface?.getBoundingClientRect();
    if (
      !mark ||
      mark.shape !== "text" ||
      !field ||
      !bounds ||
      bounds.width === 0
    ) {
      return;
    }
    const box = field.getBoundingClientRect();
    captureOnSurface(surface, event);
    beginDrag({
      markId: mark.id,
      mode: "scale",
      corner,
      origin: {
        x: (event.clientX - bounds.left) / bounds.width,
        y: (event.clientY - bounds.top) / bounds.height,
      },
      // The rendered box, not a stored one: a label is as big as its words.
      startRect: {
        x: (box.left - bounds.left) / bounds.width,
        y: (box.top - bounds.top) / bounds.height,
        width: box.width / bounds.width,
        height: box.height / bounds.height,
      },
      startScale: textScale(mark),
    });
  };
}

/**
 * What a drag in flight does to the mark it holds.
 *
 * A note is never dragged — it follows the mark it belongs to (see
 * `NoteLayer`) — so every mode here edits a mark: its rectangle, an arrow's
 * end, or a label's type size.
 */
function useApplyDrag(
  signals: ImageAnnotationSignals,
  aspect: number,
): (
  drag: AnnotationDrag,
  rect: { x: number; y: number; width: number; height: number },
  point: AnnotationPoint,
) => void {
  const moveRect = useSet(signals.moveAnnotationMarkRect$);
  const moveArrowEnd = useSet(signals.moveAnnotationArrowEnd$);
  const scaleLabel = useSet(signals.scaleAnnotationTextMark$);

  return (drag, rect, point) => {
    if (drag.mode === "endpoint" && drag.endpoint) {
      moveArrowEnd(drag.markId, drag.endpoint, point);
      return;
    }
    if (drag.mode === "scale") {
      const scaled = scaledLabel(drag, point, aspect);
      if (scaled) {
        scaleLabel(drag.markId, scaled.scale, scaled.at);
      }
      return;
    }
    moveRect(drag.markId, rect);
  };
}

function EditorStage({
  filename,
  signals,
  url,
}: {
  readonly filename: string;
  readonly signals: ImageAnnotationSignals;
  readonly url: string;
}) {
  const annotation = useGet(signals.annotationDraft$);
  const ink = useGet(signals.annotationInk$);
  const stroke = useGet(signals.annotationStroke$);
  const zoom = useGet(signals.annotationZoom$);
  const surface = useGet(signals.annotationSurface$);
  const selectedId = useGet(signals.annotationSelectedMarkId$);
  const openMarkId = useGet(signals.annotationOpenMarkId$);
  const selectMark = useSet(signals.selectAnnotationMark$);
  const bindSurface = useSet(signals.bindAnnotationSurface$);
  const handlers = useStrokeHandlers(signals);

  const box = surface?.getBoundingClientRect();
  const aspect = box && box.height > 0 ? box.width / box.height : 1;
  // Previewing through the same renderer is what makes a drag show the arrow or
  // the freehand line it is about to become, rather than a dashed rectangle
  // standing in for every tool.
  const preview = stroke ? buildMark(stroke, ink, "annotation-preview") : null;
  const selectedMark = annotation.marks.find((mark) => {
    return mark.id === selectedId;
  });
  // Clicking a printed note opens the same popover the mark opens, with the
  // caret already in the field. Only the grips stay off: the note was clicked
  // to be rewritten, not to reshape the region it describes.
  const openMark = annotation.marks.find((mark) => {
    return mark.id === openMarkId;
  });
  const grabHandle = useGrabHandle(signals, selectedMark);
  const grabLabelCorner = useGrabLabelCorner(signals, openMark);
  const applyDrag = useApplyDrag(signals, aspect);
  const grabEndpoint = useGrabEndpoint(signals, selectedMark);

  const grabMark = (
    mark: ImageAnnotationMark,
    event: ReactPointerEvent<Element>,
  ) => {
    event.stopPropagation();
    selectMark(mark.id);
    const rect = rectOf(mark);
    const bounds = surface?.getBoundingClientRect();
    if (!rect || !bounds || bounds.width === 0) {
      return;
    }
    captureOnSurface(surface, event);
    handlers.beginDrag({
      markId: mark.id,
      mode: "move",
      origin: {
        x: (event.clientX - bounds.left) / bounds.width,
        y: (event.clientY - bounds.top) / bounds.height,
      },
      startRect: rect,
    });
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/30">
      <div
        className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-5"
        style={STAGE_QUERY_CONTAINER}
      >
        <div
          ref={bindSurface}
          onPointerDown={handlers.onPointerDown}
          onPointerMove={(event) => {
            handlers.onPointerMove(event, applyDrag);
          }}
          onPointerUp={handlers.onPointerUp}
          style={{ touchAction: "none" }}
          className="relative shrink-0 cursor-crosshair select-none"
          data-testid="image-annotation-surface"
        >
          <img
            src={url}
            alt={filename}
            draggable={false}
            // The fit bounds are the stage's own box, so 100% zoom shows the
            // whole image and zooming grows the layout box the stage scrolls.
            style={{
              maxWidth: `calc(100cqw * ${zoom})`,
              maxHeight: `calc(100cqh * ${zoom})`,
            }}
            className="block rounded-lg object-contain"
          />
          <MarkLayer
            aspect={aspect}
            marks={annotation.marks}
            openMarkId={openMarkId}
            onGrab={grabMark}
            onSelect={selectMark}
          />
          <NoteLayer
            marks={annotation.marks}
            openMarkId={openMarkId}
            signals={signals}
          />
          <SelectionLayer
            mark={selectedMark}
            onGrabEndpoint={grabEndpoint}
            onGrabHandle={grabHandle}
          />
          {openMark && (
            <InlineMarkEditor
              mark={openMark}
              onGrabCorner={grabLabelCorner}
              signals={signals}
            />
          )}
          {preview && (
            <MarkShape
              mark={preview}
              ordinal={nextMarkOrdinal(annotation.marks)}
              aspect={aspect}
            />
          )}
        </div>
      </div>
      <ZoomControls signals={signals} />
      <ToolPill signals={signals} />
    </div>
  );
}

/** The editor belongs to one composer and can only edit that draft's files. */
export function ImageAnnotationEditor({
  signals,
}: {
  readonly signals: ImageAnnotationSignals;
}) {
  const target = useGet(signals.annotationSessionTarget$);
  if (!target) {
    return null;
  }
  return <AnnotationSurface signals={signals} target={target} />;
}

/**
 * The editor is the same window as the preview it replaces.
 *
 * It used to be a hand-rolled `fixed z-50` overlay, which lost twice. Its size
 * was a second set of numbers that had to be kept level with the preview's by
 * hand, and it drifted — `min(980px, 94vw)` against the preview's 1440, so the
 * picture shrank the moment the pencil was pressed. And `z-50` only orders it
 * inside the app's own stacking context, so anything portalled to `body` after
 * it — the composer's slash-command menu, left open behind the preview — kept
 * painting on top of the editor and stayed clickable. Both are the dialog
 * primitive's job, and the preview next door was already using it.
 */
function AnnotationSurface({
  signals,
  target,
}: {
  readonly signals: ImageAnnotationSignals;
  readonly target: AnnotationTarget;
}) {
  const { t } = useTranslation();
  const close = useSet(signals.closeAnnotationEditor$);
  const bindPanel = useSet(signals.bindAnnotationPanel$);
  const panelElement = useSet(signals.annotationPanelElement$);
  const resolvedUrl = useLastResolved(signals.annotationResourceUrl$);

  if (!resolvedUrl) {
    return null;
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Dialog
        open
        // A press outside must not throw the session away: the marks live
        // nowhere else until "Attach marks", so a stray click on the backdrop
        // would discard every one of them with no undo.
        disablePointerDismissal
        onOpenChange={(next, details) => {
          // Escape belongs to `KeyboardShortcuts`, which backs out one layer at
          // a time — the open note, then the selection, then the session.
          // Closing here as well would collapse all three into the first press.
          if (!next && details.reason !== "escape-key") {
            close();
          }
        }}
      >
        <DialogContent
          showCloseButton={false}
          maxWidth={1440}
          height={1000}
          surface="canvas"
          // The panel takes the opening focus rather than the first control in
          // the header, so the tool letters and ink digits reach the editor
          // instead of the composer it opened over — and so no button looks
          // pressed before anything has been drawn.
          initialFocus={panelElement}
          overlayClassName="bg-gray-900/45 dark:bg-gray-900/45"
          contentClassName="okou-app flex flex-col gap-0 overflow-hidden bg-background p-0"
          aria-label={t(($) => {
            return $.artifacts.annotation.open;
          })}
          data-testid="image-annotation-editor"
        >
          <KeyboardShortcuts signals={signals} />
          <div
            ref={bindPanel}
            tabIndex={-1}
            className="relative flex min-h-0 flex-1 flex-col overflow-hidden text-foreground outline-none"
            data-testid="image-annotation-panel"
          >
            <EditorHeader filename={target.filename} signals={signals} />
            <EditorStage
              filename={target.filename}
              signals={signals}
              url={resolvedUrl}
            />
            <EditorFooter signals={signals} />
          </div>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}
