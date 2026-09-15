import { createAttachmentResourceUrl$ } from "../attachment-resource-url.ts";
import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { onRef } from "../utils.ts";
import type {
  ImageAnnotation,
  ImageAnnotationMark,
} from "@okouai/api-contracts/contracts/chat-threads";

/**
 * Ink drawn onto a *user's* screenshot cannot come from `--primary-*` or
 * `--gray-*`: those ramps are theme-relative and invert in dark mode, so one
 * pen would paint two different colours depending on which theme the app
 * happens to be in — while the screenshot underneath does not follow our theme
 * at all. These are the fixed-hex chart tokens (`--color-usage-kind-*` /
 * `--color-credit-*`), which are declared once with no dark override.
 *
 * The brand orange and the destructive red are deliberately absent: orange
 * collides with the orange buttons that appear inside Okou's own screenshots,
 * and red sits only 20° away from it while already meaning "danger" elsewhere.
 */
export const ANNOTATION_INKS = [
  "#5E6AD2", // usage-kind-model  — contrast 4.70 on white, 3.81 on near-black
  "#358A8E", // usage-kind-video
  "#6B8DE3", // credit-plan-team
  "#EC70A5", // usage-kind-image
  "#EDC43E", // credit-plan-pro
] as const;

export type AnnotationInk = (typeof ANNOTATION_INKS)[number];

/** The only candidate clearing 3:1 against both white and near-black unaided. */
export const DEFAULT_ANNOTATION_INK: AnnotationInk = "#5E6AD2";

/** A highlight is a wash under existing text — the one place yellow belongs. */
export const HIGHLIGHT_FILL = "rgba(237, 196, 62, 0.32)";

/** Redaction is opaque `gray-800`. Never translucent: covered must mean covered. */
export const REDACT_FILL = "#525B68";

/**
 * A mark is drawn in ink alone. An earlier version carried a dark outer halo
 * for contrast on busy imagery, but it read as a grey outline around every
 * shape, which is worse than the problem it solved. The light halo stays: it is
 * invisible on a white screenshot and does the separating work on a dark one.
 */
export const STROKE_HALO_INNER = "rgba(255, 255, 255, 0.90)";

/**
 * The ground a note is printed on. Nearly opaque white rather than a halo: a
 * sentence has to stay readable over a screenshot of anything, including dark
 * UI, and a halo only separates a few pixels of each glyph.
 */
export const NOTE_GROUND = "rgba(255, 255, 255, 0.94)";

/**
 * The frame around a selected label.
 *
 * One fixed colour rather than the mark's own ink: an outline in the ink reads
 * as part of the annotation instead of as "this is the thing you picked up",
 * and the yellow one all but disappears against a light screenshot. Like the
 * inks it cannot come from a theme token — it is drawn on the user's picture,
 * which does not follow our theme. This is the only saturated true blue in
 * play, at 4.55 on white and 3.81 on near-black: the same bar the inks clear.
 */
export const SELECTION_STROKE = "#2F6FED";

/** The type size a label is drawn at on screen before its corners are dragged. */
export const LABEL_BASE_PX = 14;

/** Radius of the disc a box's ordinal is printed in. */
export const PIN_RADIUS_PX = 11;

/**
 * How far the pin's centre sits inside the box's own top-left corner.
 *
 * The pin used to be centred *on* that corner, which is precisely where the
 * selection grip lands — so selecting a box hid its number under the white dot
 * and the note that says "1" had nothing left to point at. Tucking the pin
 * inside clears the grip by a whole radius, and unlike a pin parked outside the
 * box it survives a mark drawn against the top or left edge of the image, which
 * is what matters in the flattened copy the model actually reads.
 */
export const PIN_INSET_PX = PIN_RADIUS_PX + 3;

/**
 * `highlight`, `crop` and `redact` were dropped, and `select` with them: a
 * mark is clicked directly, so a mode for "not drawing" has nothing left to do,
 * and a tool whose job nobody could name off its icon is not worth a slot. The
 * *shapes* stay in the contract — a draft saved before this change can still
 * carry one, and it has to keep rendering.
 */
export type AnnotationTool = "box" | "arrow" | "pen" | "text";

function emptyAnnotation(): ImageAnnotation {
  return { marks: [] };
}

export function annotationMarkCount(
  annotation: ImageAnnotation | null | undefined,
): number {
  return annotation?.marks.length ?? 0;
}

/**
 * True once the annotation would change any pixel or carry any words. An
 * annotation that has been opened and closed without drawing must not make the
 * send path flatten a copy of an image nobody marked.
 */
export function isAnnotationMeaningful(
  annotation: ImageAnnotation | null | undefined,
): boolean {
  if (!annotation) {
    return false;
  }
  return annotation.marks.length > 0 || annotation.crop !== undefined;
}

/**
 * The number drawn on a mark and quoted back to the agent.
 *
 * Stored on the mark rather than read off its position: deleting one mark must
 * not renumber the others, or every note the user already wrote about "3" now
 * points at a different box. Marks saved before the field existed fall back to
 * their position.
 */
export function markOrdinal(mark: ImageAnnotationMark, index: number): number {
  return mark.ordinal ?? index + 1;
}

/**
 * The lowest number not currently on the image.
 *
 * Deleting the fifth of ten marks leaves a hole, and the next mark drawn fills
 * it instead of becoming eleven. The numbering stays as dense as the marks are
 * without disturbing any mark that is already there.
 */
export function nextMarkOrdinal(marks: readonly ImageAnnotationMark[]): number {
  const taken = new Set(
    marks.map((mark, index) => {
      return markOrdinal(mark, index);
    }),
  );
  let candidate = 1;
  while (taken.has(candidate)) {
    candidate += 1;
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// Editor session — one attachment at a time, with its own undo history
// ---------------------------------------------------------------------------

/**
 * What the editor needs in order to edit, kept deliberately narrow so this
 * module never has to know about drafts. `commit` is what makes the model
 * non-destructive: the editor hands back marks, and the caller decides where
 * they live. The original bytes are not part of this interface at all.
 */
export interface AnnotationTarget {
  readonly key: string;
  readonly filename: string;
  readonly url: string;
  readonly annotations: ImageAnnotation | null;
  readonly commit: (
    annotations: ImageAnnotation | null,
    signal: AbortSignal,
  ) => Promise<void>;
}

interface AnnotationSession {
  readonly target: AnnotationTarget;
  /**
   * The annotation the editor opened on. Undo restores the exact object it
   * pushed, so identity against this is enough to tell whether the session has
   * anything to attach — no structural comparison, and undoing back to the
   * start correctly reads as unchanged again.
   */
  readonly baseline: ImageAnnotation;
  readonly past: readonly ImageAnnotation[];
  readonly present: ImageAnnotation;
  readonly future: readonly ImageAnnotation[];
}

/**
 * The stroke being dragged right now, and the element it is being dragged on.
 *
 * Both live here rather than in React state because this app has no React
 * hooks — every piece of state is a ccstate signal, and DOM nodes arrive
 * through `onRef`.
 */
export interface AnnotationStroke {
  readonly tool: Exclude<AnnotationTool, "select">;
  readonly from: AnnotationPoint;
  readonly to: AnnotationPoint;
  readonly points: readonly AnnotationPoint[];
}

export interface AnnotationPoint {
  readonly x: number;
  readonly y: number;
}

/** The eight grips on a selected mark: four corners and four edges. */
export const ANNOTATION_RESIZE_EDGES = [
  "tl",
  "tr",
  "bl",
  "br",
  "t",
  "b",
  "l",
  "r",
] as const;

export type AnnotationResizeEdge = (typeof ANNOTATION_RESIZE_EDGES)[number];

/** Which end of an arrow a drag is holding. */
export type AnnotationArrowEnd = "from" | "to";

/**
 * A mark being moved, resized, or re-aimed. Drawing produces a new mark; this
 * edits one that already exists, so it carries the mark it started from and the
 * pointer offset at grab time — without the offset a drag snaps the mark's
 * corner to the cursor on the first move.
 *
 * `endpoint` is the arrow's own mode: an arrow has no rectangle to resize, so
 * its two ends are dragged directly and the pointer position *is* the new end.
 */
export interface AnnotationDrag {
  readonly markId: string;
  readonly mode: "move" | "resize" | "endpoint" | "scale";
  readonly corner?: AnnotationResizeEdge;
  readonly endpoint?: AnnotationArrowEnd;
  readonly origin: AnnotationPoint;
  readonly startRect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /**
   * The type size a label was at when its corner was grabbed. A label has no
   * rectangle of its own — its box is whatever the words happen to fill — so a
   * scale drag is measured against this rather than against a stored size.
   */
  readonly startScale?: number;
}

/**
 * How far a label can be taken from the base size. Below half it stops being
 * legible on a screenshot, and above four times one word covers the region it
 * is pointing at.
 */
export const MIN_TEXT_SCALE = 0.5;
export const MAX_TEXT_SCALE = 4;

/** The type size of a label, which marks placed before the handles lack. */
export function textScale(mark: ImageAnnotationMark): number {
  return mark.shape === "text" ? (mark.scale ?? 1) : 1;
}

/** A note narrower than this wraps every other word and reads as a column. */
const MIN_NOTE_WIDTH = 0.18;
/**
 * Where a note starts wrapping. Half the image: past that a single sentence
 * spans so much of the screenshot that it stops reading as a label on one
 * region and starts reading as a caption for the whole picture.
 */
const MAX_NOTE_WIDTH = 0.5;
/** Clear of the mark's own outline and its ordinal pin. */
const NOTE_GAP = 0.015;

/**
 * The box a mark occupies, used to place its note under it and — for the shapes
 * that have no rectangle of their own — to give a drag something to translate.
 */
export function markBounds(mark: ImageAnnotationMark): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  if (mark.shape === "arrow") {
    return {
      x: Math.min(mark.from.x, mark.to.x),
      y: Math.min(mark.from.y, mark.to.y),
      width: Math.abs(mark.to.x - mark.from.x),
      height: Math.abs(mark.to.y - mark.from.y),
    };
  }
  if (mark.shape === "pen") {
    const xs = mark.points.map((point) => {
      return point.x;
    });
    const ys = mark.points.map((point) => {
      return point.y;
    });
    const x = Math.min(...xs, 1);
    const y = Math.min(...ys, 1);
    return {
      x,
      y,
      width: Math.max(...xs, 0) - x,
      height: Math.max(...ys, 0) - y,
    };
  }
  if (mark.shape === "text") {
    return { x: mark.at.x, y: mark.at.y, width: 0, height: 0 };
  }
  return mark.rect;
}

/**
 * Slides a whole mark by a normalized delta, held so its bounding box cannot
 * leave the image — a mark dragged off the edge would survive in the draft but
 * disappear from the flattened copy the model actually reads.
 *
 * An arrow and a freehand stroke have no rectangle to assign, so this is the
 * only way either of them moves: every point shifts by the same amount, which
 * keeps the arrow's aim and the stroke's shape while changing where it sits.
 */
function offsetMark(
  mark: ImageAnnotationMark,
  dx: number,
  dy: number,
): ImageAnnotationMark {
  const bounds = markBounds(mark);
  const shiftX = Math.min(
    Math.max(dx, -bounds.x),
    Math.max(0, 1 - bounds.width - bounds.x),
  );
  const shiftY = Math.min(
    Math.max(dy, -bounds.y),
    Math.max(0, 1 - bounds.height - bounds.y),
  );
  const shift = (point: AnnotationPoint): AnnotationPoint => {
    return { x: point.x + shiftX, y: point.y + shiftY };
  };

  switch (mark.shape) {
    case "arrow": {
      return { ...mark, from: shift(mark.from), to: shift(mark.to) };
    }
    case "pen": {
      return { ...mark, points: mark.points.map(shift) };
    }
    case "text": {
      return { ...mark, at: shift(mark.at) };
    }
    default: {
      return {
        ...mark,
        rect: {
          ...mark.rect,
          x: mark.rect.x + shiftX,
          y: mark.rect.y + shiftY,
        },
      };
    }
  }
}

/**
 * Where a note lands: directly under the mark it belongs to, starting at the
 * mark's left edge.
 *
 * `maxWidth` is a ceiling, not a width. The note used to be drawn *as wide as
 * its mark*, so three words under a wide box became a mostly empty strip —
 * bingjie: *"评论是定宽，宽度不好算的话干脆直接不要框可能会更好些？"*. The box
 * now hugs whatever was typed and only wraps once it reaches this ceiling, so
 * there is no width left to compute and nothing to leave empty.
 */
interface AnnotationTextBox {
  readonly x: number;
  readonly y: number;
  readonly maxWidth: number;
}

/**
 * The box a mark's words occupy, whether they have been typed yet or not.
 *
 * The editor writes in this box too, so it cannot come from `noteOnImage`: that
 * one describes a note that already has text, and a field has to be placed
 * before anything is in it. Both callers taking the same geometry is what makes
 * typing continuous with what the flattened copy will show.
 */
export function annotationTextBox(
  mark: ImageAnnotationMark,
): AnnotationTextBox {
  if (mark.shape === "text") {
    // A label is anchored where it was placed. It is not held off the right
    // edge the way a note is: moving it would move the mark itself.
    return {
      x: mark.at.x,
      y: mark.at.y,
      maxWidth: Math.max(
        MIN_NOTE_WIDTH,
        Math.min(MAX_NOTE_WIDTH, 1 - mark.at.x),
      ),
    };
  }
  const bounds = markBounds(mark);
  // Held off the right edge by the narrowest note worth wrapping to: a mark in
  // the far corner would otherwise leave its note a two-character column.
  const x = Math.min(Math.max(0, bounds.x), Math.max(0, 1 - MIN_NOTE_WIDTH));
  const below = bounds.y + bounds.height + NOTE_GAP;
  const y = below > 1 - NOTE_ROOM ? bounds.y - NOTE_GAP - NOTE_ROOM : below;
  return {
    x,
    y: Math.min(Math.max(0, y), Math.max(0, 1 - NOTE_ROOM)),
    maxWidth: Math.min(MAX_NOTE_WIDTH, 1 - x),
  };
}

/** Roughly one line of note plus its padding, in normalized units. */
const NOTE_ROOM = 0.06;

/** The note text of a mark that can carry one drawn on the image. */
export function noteOnImage(mark: ImageAnnotationMark): {
  text: string;
  ink: string;
  box: AnnotationTextBox;
} | null {
  if (
    mark.shape === "text" ||
    mark.shape === "redact" ||
    mark.shape === "highlight"
  ) {
    return null;
  }
  const text = mark.note?.trim();
  if (!text) {
    return null;
  }
  return { text, ink: mark.ink, box: annotationTextBox(mark) };
}

const ZOOM_STEP = 0.25;
const ZOOM_MIN = 1;
const ZOOM_MAX = 4;

/**
 * What the editor currently has open. `note` is not a second draggable object:
 * it means the mark's sentence is open for editing, which is what clicking the
 * printed label does. Notes used to be moved and resized independently and are
 * now placed by `defaultNoteBox` alone — Tong: *"mark 标注的文字还是不要让用户
 * 随便拖动了 … 标注文字点击也可以进行文本编辑，现在是拖动"*.
 */
interface AnnotationSelection {
  readonly kind: "mark" | "note";
  readonly id: string;
}

function createAnnotationViewportSignals() {
  const drag$ = state<AnnotationDrag | null>(null);
  /**
   * Whether the drag in flight has already taken its undo step.
   *
   * A drag reports a new geometry on every pointer move, and each one used to
   * become its own history entry — so undoing one gesture meant pressing Cmd+Z
   * once per frame it lasted. The first move of a drag pushes; the rest amend
   * the present in place, which makes the whole gesture a single undo.
   */
  const dragPushed$ = state(false);
  const zoom$ = state(1);
  const stroke$ = state<AnnotationStroke | null>(null);
  const surface$ = state<HTMLElement | null>(null);
  const annotationStroke$ = computed((get) => {
    return get(stroke$);
  });
  const annotationSurface$ = computed((get) => {
    return get(surface$);
  });
  const annotationDrag$ = computed((get) => {
    return get(drag$);
  });
  const annotationZoom$ = computed((get) => {
    return get(zoom$);
  });
  const setAnnotationDrag$ = command(({ set }, drag: AnnotationDrag | null) => {
    set(drag$, drag);
    set(dragPushed$, false);
  });
  const zoomAnnotation$ = command(({ get, set }, direction: 1 | -1) => {
    const next = get(zoom$) + direction * ZOOM_STEP;
    set(zoom$, Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next)));
  });
  const resetAnnotationZoom$ = command(({ set }) => {
    set(zoom$, ZOOM_MIN);
  });
  const setAnnotationStroke$ = command(
    ({ set }, stroke: AnnotationStroke | null) => {
      set(stroke$, stroke);
    },
  );
  /**
   * The note field, owned by the element that renders it.
   *
   * Focus belongs in `onRef` (docs/effect.md), and it cannot be an `autoFocus`
   * attribute here: the field is already mounted when a printed note is clicked
   * while the popover is open, and a mount-time attribute cannot fire twice.
   * Forcing a remount to re-fire one throws the live input away mid-edit.
   */
  const noteField$ = state<HTMLElement | null>(null);
  const bindAnnotationNoteField$ = onRef<HTMLElement>(
    command(({ set }, element: HTMLElement, signal: AbortSignal) => {
      set(noteField$, element);
      // The field only exists while a mark is open, and the caret belongs in it
      // the whole time. Focusing on mount closes the gap a mount-time attribute
      // leaves, where a keystroke meant for the words reached the editor's
      // shortcuts instead — and it covers the click on a printed note, which
      // asks for the caret before this element exists.
      element.focus();
      signal.addEventListener(
        "abort",
        () => {
          set(noteField$, null);
        },
        { once: true },
      );
    }),
  );
  const focusAnnotationNoteField$ = command(({ get }) => {
    get(noteField$)?.focus();
  });
  const bindAnnotationSurface$ = onRef<HTMLElement>(
    command(({ set }, element: HTMLElement, signal: AbortSignal) => {
      set(surface$, element);
      signal.addEventListener(
        "abort",
        () => {
          set(surface$, null);
        },
        { once: true },
      );
    }),
  );
  /**
   * The editor panel, which holds the caret whenever no field wants it.
   *
   * Every bare shortcut — the tool letters, the ink digits, the arrow keys —
   * steps aside while something is being typed into, and the editor opens over
   * a composer whose message box normally holds focus. So the tooltips
   * advertised keys that silently did nothing and typed into the message
   * underneath instead. The dialog takes its opening focus here through
   * `annotationPanelElement$`, and a dismissed note hands it straight back.
   */
  const panel$ = state<HTMLElement | null>(null);
  const bindAnnotationPanel$ = onRef<HTMLElement>(
    command(({ set }, element: HTMLElement, signal: AbortSignal) => {
      set(panel$, element);
      signal.addEventListener(
        "abort",
        () => {
          set(panel$, null);
        },
        { once: true },
      );
    }),
  );
  /** The dialog's `initialFocus` reads this once the popup has mounted. */
  const annotationPanelElement$ = command(({ get }) => {
    return get(panel$);
  });
  const focusAnnotationPanel$ = command(({ get }) => {
    get(panel$)?.focus({ preventScroll: true });
  });
  return {
    internal: { drag$, dragPushed$, zoom$, stroke$ },
    signals: {
      annotationStroke$,
      annotationSurface$,
      annotationDrag$,
      annotationZoom$,
      bindAnnotationNoteField$,
      focusAnnotationNoteField$,
      bindAnnotationPanel$,
      annotationPanelElement$,
      focusAnnotationPanel$,
      setAnnotationDrag$,
      zoomAnnotation$,
      resetAnnotationZoom$,
      setAnnotationStroke$,
      bindAnnotationSurface$,
    },
  };
}

type AnnotationViewport = ReturnType<typeof createAnnotationViewportSignals>;

/**
 * Drops the open text mark when it never got any words.
 *
 * A text mark exists from the moment the canvas is clicked, so leaving it —
 * Escape, another tool, a click anywhere else — used to leave an invisible
 * empty mark behind: it counted in the header, it kept "Attach marks" enabled,
 * and nothing on the image showed it was there. The step the mark arrived in is
 * unwound rather than a removal recorded, because a label nobody typed is not
 * an edit anyone should have to take back.
 */
function createDiscardEmptyTextMark(
  session$: State<AnnotationSession | null>,
  openMarkId$: Computed<string | null>,
) {
  return command(({ get, set }, nextId: string | null) => {
    const current = get(session$);
    const openId = get(openMarkId$);
    if (!current || openId === null || openId === nextId) {
      return;
    }
    const open = current.present.marks.find((mark) => {
      return mark.id === openId;
    });
    if (!open || open.shape !== "text" || open.text.trim() !== "") {
      return;
    }
    const previous = current.past.at(-1);
    // The creation step is only the last one while nothing has been done to
    // the mark since — recolouring or nudging it pushes an entry of its own,
    // and that entry still carries the mark. Then the removal is all that can
    // be applied, and it becomes an edit like any other.
    if (
      previous &&
      !previous.marks.some((mark) => {
        return mark.id === openId;
      })
    ) {
      set(session$, {
        ...current,
        past: current.past.slice(0, -1),
        present: previous,
      });
      return;
    }
    set(session$, {
      ...current,
      present: {
        ...current.present,
        marks: current.present.marks.filter((mark) => {
          return mark.id !== openId;
        }),
      },
    });
  });
}

function createAnnotationSessionSignals(viewport: AnnotationViewport) {
  const session$ = state<AnnotationSession | null>(null);
  const tool$ = state<AnnotationTool>("box");
  const ink$ = state<AnnotationInk>(DEFAULT_ANNOTATION_INK);
  const selection$ = state<AnnotationSelection | null>(null);
  const annotationSessionTarget$ = computed((get) => {
    return get(session$)?.target ?? null;
  });
  const annotationSessionActive$ = computed((get) => {
    return get(session$) !== null;
  });
  const annotationDraft$ = computed((get) => {
    return get(session$)?.present ?? emptyAnnotation();
  });
  const annotationTool$ = computed((get) => {
    return get(tool$);
  });
  const annotationInk$ = computed((get) => {
    return get(ink$);
  });
  const annotationSelectedMarkId$ = computed((get) => {
    const selection = get(selection$);
    return selection?.kind === "mark" ? selection.id : null;
  });
  /**
   * The mark the editor has open, however it was opened.
   *
   * Ink and delete act on this rather than on `annotationSelectedMarkId$`:
   * clicking a printed note opens the same popover, and a swatch that recolours
   * or does nothing depending on which way the popover was opened is the same
   * control behaving two ways.
   */
  const annotationOpenMarkId$ = computed((get) => {
    return get(selection$)?.id ?? null;
  });
  const annotationDirty$ = computed((get) => {
    const session = get(session$);
    return session !== null && session.present !== session.baseline;
  });
  const annotationCanUndo$ = computed((get) => {
    return (get(session$)?.past.length ?? 0) > 0;
  });
  const annotationCanRedo$ = computed((get) => {
    return (get(session$)?.future.length ?? 0) > 0;
  });
  const discardEmptyOpenTextMark$ = createDiscardEmptyTextMark(
    session$,
    annotationOpenMarkId$,
  );
  const selectAnnotationNote$ = command(({ set }, id: string | null) => {
    set(discardEmptyOpenTextMark$, id);
    set(selection$, id === null ? null : { kind: "note", id });
    if (id !== null) {
      set(viewport.signals.focusAnnotationNoteField$);
    }
  });
  const selectAnnotationMark$ = command(({ set }, id: string | null) => {
    set(discardEmptyOpenTextMark$, id);
    set(selection$, id === null ? null : { kind: "mark", id });
  });
  const setAnnotationTool$ = command(({ set }, tool: AnnotationTool) => {
    set(discardEmptyOpenTextMark$, null);
    set(tool$, tool);
    set(selection$, null);
  });
  const annotationResourceUrl$ = computed(async (get) => {
    const target = get(annotationSessionTarget$);
    return target ? await get(createAttachmentResourceUrl$(target.url)) : null;
  });

  const openAnnotationEditor$ = command(({ set }, target: AnnotationTarget) => {
    const opened = target.annotations ?? emptyAnnotation();
    set(session$, {
      target,
      baseline: opened,
      past: [],
      present: opened,
      future: [],
    });
    set(tool$, "box");
    set(viewport.internal.zoom$, ZOOM_MIN);
    set(ink$, DEFAULT_ANNOTATION_INK);
    set(selection$, null);
  });
  const closeAnnotationEditor$ = command(({ set }) => {
    set(session$, null);
    set(selection$, null);
    set(viewport.internal.stroke$, null);
    set(viewport.internal.drag$, null);
    set(viewport.internal.zoom$, ZOOM_MIN);
  });
  return {
    internal: { session$, ink$, selection$, discardEmptyOpenTextMark$ },
    signals: {
      annotationSessionTarget$,
      annotationResourceUrl$,
      annotationSessionActive$,
      annotationDraft$,
      annotationTool$,
      annotationInk$,
      annotationSelectedMarkId$,
      annotationOpenMarkId$,
      annotationDirty$,
      annotationCanUndo$,
      annotationCanRedo$,
      selectAnnotationNote$,
      selectAnnotationMark$,
      setAnnotationTool$,
      openAnnotationEditor$,
      closeAnnotationEditor$,
    },
  };
}

type AnnotationSessionSignals = ReturnType<
  typeof createAnnotationSessionSignals
>;

function createAnnotationHistorySignals(session: AnnotationSessionSignals) {
  const pushAnnotation$ = command(
    (
      { get, set },
      update: (current: ImageAnnotation) => ImageAnnotation,
    ): void => {
      const current = get(session.internal.session$);
      if (!current) {
        return;
      }
      set(session.internal.session$, {
        target: current.target,
        baseline: current.baseline,
        past: [...current.past, current.present],
        present: update(current.present),
        future: [],
      });
    },
  );
  /**
   * Rewrites the present without recording a step.
   *
   * Only a gesture already represented in `past` may use this: the continuation
   * of a drag belongs to the entry its first move pushed, not to one of its
   * own. Anything that starts an edit must go through `pushAnnotation$`.
   */
  const amendAnnotation$ = command(
    (
      { get, set },
      update: (current: ImageAnnotation) => ImageAnnotation,
    ): void => {
      const current = get(session.internal.session$);
      if (!current) {
        return;
      }
      set(session.internal.session$, {
        ...current,
        present: update(current.present),
      });
    },
  );
  const undoAnnotation$ = command(({ get, set }) => {
    const current = get(session.internal.session$);
    const previous = current?.past.at(-1);
    if (!current || previous === undefined) {
      return;
    }
    set(session.internal.session$, {
      target: current.target,
      baseline: current.baseline,
      past: current.past.slice(0, -1),
      present: previous,
      future: [current.present, ...current.future],
    });
    set(session.internal.selection$, null);
  });
  const redoAnnotation$ = command(({ get, set }) => {
    const current = get(session.internal.session$);
    const next = current?.future[0];
    if (!current || next === undefined) {
      return;
    }
    set(session.internal.session$, {
      target: current.target,
      baseline: current.baseline,
      past: [...current.past, current.present],
      present: next,
      future: current.future.slice(1),
    });
    set(session.internal.selection$, null);
  });
  return {
    pushAnnotation$,
    amendAnnotation$,
    undoAnnotation$,
    redoAnnotation$,
  };
}

type AnnotationHistorySignals = ReturnType<
  typeof createAnnotationHistorySignals
>;

function createAnnotationContentSignals(
  session: AnnotationSessionSignals,
  history: AnnotationHistorySignals,
) {
  const setAnnotationInk$ = command(({ get, set }, ink: AnnotationInk) => {
    set(session.internal.ink$, ink);
    const selectedId = get(session.signals.annotationOpenMarkId$);
    if (selectedId === null) {
      return;
    }
    set(history.pushAnnotation$, (current): ImageAnnotation => {
      return {
        ...current,
        marks: current.marks.map((mark) => {
          if (
            mark.id !== selectedId ||
            mark.shape === "highlight" ||
            mark.shape === "redact"
          ) {
            return mark;
          }
          return { ...mark, ink };
        }),
      };
    });
  });
  const setAnnotationMarkNote$ = command(
    ({ set }, id: string, note: string) => {
      set(history.pushAnnotation$, (current) => {
        return {
          ...current,
          marks: current.marks.map((mark) => {
            if (
              mark.id !== id ||
              mark.shape === "highlight" ||
              mark.shape === "redact"
            ) {
              return mark;
            }
            return mark.shape === "text"
              ? { ...mark, text: note }
              : { ...mark, note };
          }),
        };
      });
    },
  );
  return { setAnnotationInk$, setAnnotationMarkNote$ };
}

/**
 * Resizes a label by dragging one of its corners.
 *
 * Both the size and the anchor arrive together: the corner opposite the one
 * being dragged stays where it is, so the label grows away from the hand rather
 * than from wherever the text happens to start.
 */
function createScaleTextMark(
  applyDragEdit$: Command<
    void,
    [(current: ImageAnnotation) => ImageAnnotation]
  >,
) {
  return command(({ set }, id: string, scale: number, at: AnnotationPoint) => {
    set(applyDragEdit$, (current) => {
      return {
        ...current,
        marks: current.marks.map((mark) => {
          if (mark.id !== id || mark.shape !== "text") {
            return mark;
          }
          return { ...mark, at, scale };
        }),
      };
    });
  });
}

function createAnnotationGeometrySignals(
  session: AnnotationSessionSignals,
  history: AnnotationHistorySignals,
  viewport: AnnotationViewport,
) {
  /** One undo step per gesture: the first move records, the rest amend. */
  const applyDragEdit$ = command(
    ({ get, set }, update: (current: ImageAnnotation) => ImageAnnotation) => {
      if (get(viewport.internal.dragPushed$)) {
        set(history.amendAnnotation$, update);
        return;
      }
      set(viewport.internal.dragPushed$, true);
      set(history.pushAnnotation$, update);
    },
  );
  const scaleAnnotationTextMark$ = createScaleTextMark(applyDragEdit$);
  const addAnnotationMark$ = command(({ set }, mark: ImageAnnotationMark) => {
    // Placing a second text mark leaves the first one, and an untyped one has
    // to go before its creation step stops being the last thing in history.
    set(session.internal.discardEmptyOpenTextMark$, mark.id);
    set(history.pushAnnotation$, (current) => {
      return {
        ...current,
        marks: [
          ...current.marks,
          { ...mark, ordinal: nextMarkOrdinal(current.marks) },
        ],
      };
    });
    set(session.internal.selection$, { kind: "mark", id: mark.id });
  });
  const removeAnnotationMark$ = command(({ get, set }, id: string) => {
    set(history.pushAnnotation$, (current) => {
      return {
        ...current,
        marks: current.marks.filter((mark) => {
          return mark.id !== id;
        }),
      };
    });
    if (get(session.internal.selection$)?.id === id) {
      set(session.internal.selection$, null);
    }
  });
  const removeSelectedAnnotationMark$ = command(({ get, set }) => {
    const id = get(session.signals.annotationOpenMarkId$);
    if (id !== null) {
      set(removeAnnotationMark$, id);
    }
  });
  const moveAnnotationMarkRect$ = command(
    (
      { set },
      id: string,
      rect: { x: number; y: number; width: number; height: number },
    ) => {
      set(applyDragEdit$, (current) => {
        return {
          ...current,
          marks: current.marks.map((mark) => {
            if (mark.id !== id) {
              return mark;
            }
            if (mark.shape === "box") {
              return { ...mark, rect };
            }
            if (mark.shape === "text") {
              return { ...mark, at: { x: rect.x, y: rect.y } };
            }
            // An arrow and a freehand stroke have no rectangle to assign, so
            // the incoming rect is read as a destination for their bounding box
            // and the difference is applied to every point. The drag computes
            // each rect from the box it grabbed, so the difference against the
            // mark's *current* bounds is exactly this move's increment — which
            // is what keeps amended moves from compounding.
            const bounds = markBounds(mark);
            return offsetMark(mark, rect.x - bounds.x, rect.y - bounds.y);
          }),
        };
      });
    },
  );
  /**
   * Re-aims an arrow by dragging one of its ends.
   *
   * The pointer position is the new end outright rather than an offset: an
   * arrow is defined by where it starts and where it points, so a grip that
   * lags the cursor by its grab offset would feel like the tip is slipping.
   */
  const moveAnnotationArrowEnd$ = command(
    (
      { set },
      id: string,
      endpoint: AnnotationArrowEnd,
      point: AnnotationPoint,
    ) => {
      set(applyDragEdit$, (current) => {
        return {
          ...current,
          marks: current.marks.map((mark) => {
            if (mark.id !== id || mark.shape !== "arrow") {
              return mark;
            }
            return endpoint === "from"
              ? { ...mark, from: point }
              : { ...mark, to: point };
          }),
        };
      });
    },
  );
  /**
   * Moves the open mark by a step from the keyboard.
   *
   * One press is one undo step. That differs from a drag on purpose: a nudge is
   * already the smallest edit the user can make, so collapsing a run of them
   * would leave no way to take back just the last one.
   */
  const nudgeAnnotationMark$ = command(
    ({ get, set }, dx: number, dy: number) => {
      const id = get(session.signals.annotationOpenMarkId$);
      if (id === null) {
        return;
      }
      set(history.pushAnnotation$, (current) => {
        return {
          ...current,
          marks: current.marks.map((mark) => {
            return mark.id === id ? offsetMark(mark, dx, dy) : mark;
          }),
        };
      });
    },
  );
  return {
    addAnnotationMark$,
    removeAnnotationMark$,
    removeSelectedAnnotationMark$,
    moveAnnotationMarkRect$,
    moveAnnotationArrowEnd$,
    scaleAnnotationTextMark$,
    nudgeAnnotationMark$,
  };
}

function createCommitAnnotationSignal(session: AnnotationSessionSignals) {
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    // Attaching straight from an open, empty text mark must not ship it.
    set(session.internal.discardEmptyOpenTextMark$, null);
    const current = get(session.internal.session$);
    if (!current) {
      return;
    }
    const annotations = isAnnotationMeaningful(current.present)
      ? current.present
      : null;
    set(session.signals.closeAnnotationEditor$);
    await current.target.commit(annotations, signal);
  });
}

export function createImageAnnotationSignals() {
  const viewport = createAnnotationViewportSignals();
  const session = createAnnotationSessionSignals(viewport);
  const history = createAnnotationHistorySignals(session);
  const content = createAnnotationContentSignals(session, history);
  const geometry = createAnnotationGeometrySignals(session, history, viewport);
  return {
    ...viewport.signals,
    ...session.signals,
    ...history,
    ...content,
    ...geometry,
    commitAnnotation$: createCommitAnnotationSignal(session),
  };
}

export type ImageAnnotationSignals = ReturnType<
  typeof createImageAnnotationSignals
>;
