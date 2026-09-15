import type { PointerEvent as ReactPointerEvent } from "react";
import { cn } from "@okouai/ui";
import type {
  ImageAnnotation,
  ImageAnnotationMark,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  annotationTextBox,
  HIGHLIGHT_FILL,
  LABEL_BASE_PX,
  markOrdinal,
  NOTE_GROUND,
  noteOnImage,
  PIN_INSET_PX,
  PIN_RADIUS_PX,
  REDACT_FILL,
  STROKE_HALO_INNER,
  textScale,
} from "../../signals/okou-page/image-annotation.ts";

/**
 * One renderer for both surfaces. The read-only viewer and the editor drew the
 * same marks from two implementations before, which is how the viewer ended up
 * showing a clean image while the editor showed the annotations.
 */

/** Head length as a fraction of the shorter edge. */
const ARROW_HEAD_UNITS = 0.045;

/**
 * How wide the invisible grab band around a stroke is, in on-screen pixels.
 *
 * A 3px line is not a target anyone can hit, so every stroke carries a second
 * copy of its own path drawn in `transparent` at this width. It has to be the
 * *stroke* that is hittable and not the SVG box: the box spans the whole image,
 * and a hittable box would swallow every press meant for the canvas underneath,
 * leaving no way to draw a second mark anywhere near the first.
 */
const STROKE_HIT_WIDTH = 14;

function percent(value: number): string {
  return `${value * 100}%`;
}

/**
 * The pointer surface for a stroke, or nothing when the layer is read-only.
 *
 * `pointerEvents: "stroke"` overrides the `pointer-events-none` on the parent
 * `<svg>` for this one path, which is what confines hit-testing to the band
 * around the line.
 */
function strokeHitProps(interaction: MarkInteraction | null) {
  if (!interaction) {
    return null;
  }
  return {
    fill: "none",
    stroke: "transparent",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    vectorEffect: "non-scaling-stroke" as const,
    className: "cursor-move",
    style: { pointerEvents: "stroke" as const, strokeWidth: STROKE_HIT_WIDTH },
    ...interaction,
  };
}

function StrokeMark({
  mark,
  aspect,
  interaction,
}: {
  mark: ImageAnnotationMark;
  aspect: number;
  interaction: MarkInteraction | null;
}) {
  const hit = strokeHitProps(interaction);

  if (mark.shape === "pen") {
    const points = mark.points
      .map((point) => {
        return `${point.x * 100},${point.y * 100}`;
      })
      .join(" ");
    return (
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="pointer-events-none absolute inset-0 h-full w-full"
      >
        <polyline
          points={points}
          fill="none"
          stroke={STROKE_HALO_INNER}
          vectorEffect="non-scaling-stroke"
          style={{ strokeWidth: 5 }}
        />
        <polyline
          points={points}
          fill="none"
          stroke={mark.ink}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          style={{ strokeWidth: 3 }}
        />
        {hit && <polyline points={points} {...hit} />}
      </svg>
    );
  }

  if (mark.shape !== "arrow") {
    return null;
  }

  // The SVG is stretched to a non-square box, so anything that is not a
  // straight line comes out skewed — which is why the tip used to render as a
  // squashed ellipse instead of a head. The head is therefore built from the
  // angle as it appears *on screen* and converted back into the stretched
  // space, using the box's aspect ratio.
  const dx = (mark.to.x - mark.from.x) * aspect;
  const dy = mark.to.y - mark.from.y;
  const angle = Math.atan2(dy, dx);
  const spread = Math.PI / 7;
  const head = ARROW_HEAD_UNITS;
  const wing = (offset: number) => {
    return {
      x: (mark.to.x - (head * Math.cos(angle + offset)) / aspect) * 100,
      y: (mark.to.y - head * Math.sin(angle + offset)) * 100,
    };
  };
  const left = wing(-spread);
  const right = wing(spread);
  const shaft = `M ${mark.from.x * 100} ${mark.from.y * 100} L ${mark.to.x * 100} ${mark.to.y * 100}`;
  const arrowHead = `M ${left.x} ${left.y} L ${mark.to.x * 100} ${mark.to.y * 100} L ${right.x} ${right.y}`;

  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-0 h-full w-full"
    >
      <path
        d={`${shaft} ${arrowHead}`}
        fill="none"
        stroke={STROKE_HALO_INNER}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        style={{ strokeWidth: 5 }}
      />
      <path
        d={`${shaft} ${arrowHead}`}
        fill="none"
        stroke={mark.ink}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        style={{ strokeWidth: 3 }}
      />
      {/* The shaft alone. Grabbing the head would put the band the arrow is
          dragged by right on top of the two endpoint grips that re-aim it. */}
      {hit && <path d={shaft} {...hit} />}
    </svg>
  );
}

function boxedFill(
  mark: Extract<ImageAnnotationMark, { shape: "box" | "highlight" | "redact" }>,
) {
  if (mark.shape === "redact") {
    return { background: REDACT_FILL };
  }
  if (mark.shape === "highlight") {
    return { background: HIGHLIGHT_FILL };
  }
  return {
    border: `2.5px solid ${mark.ink}`,
    background: `${mark.ink}1A`,
    boxShadow: `inset 0 0 0 1px ${STROKE_HALO_INNER}`,
  };
}

/** What a mark needs in order to be picked up, shared by every shape. */
interface MarkInteraction {
  onClick: () => void;
  onPointerDown?: (event: ReactPointerEvent<Element>) => void;
  "data-testid": string;
}

/**
 * Selection is carried entirely by the resize handles. An outline on top of the
 * mark's own border reads as two strokes around one shape, which looks like a
 * rendering fault rather than a state, so nothing here changes when a mark is
 * picked.
 */
export function MarkShape({
  mark,
  ordinal,
  aspect = 1,
  onSelect,
  onGrab,
}: {
  mark: ImageAnnotationMark;
  ordinal: number;
  aspect?: number;
  onSelect?: () => void;
  onGrab?: (event: ReactPointerEvent<Element>) => void;
}) {
  // Without a handler the mark is decoration, so it must not eat pointer events
  // from the surface underneath — that surface is where new marks get drawn.
  const interaction: MarkInteraction | null = onSelect
    ? {
        onClick: onSelect,
        ...(onGrab ? { onPointerDown: onGrab } : {}),
        "data-testid": `annotation-mark-${ordinal}`,
      }
    : null;
  const boxedProps = interaction
    ? { ...interaction, className: "absolute cursor-move" }
    : { className: "pointer-events-none absolute" };

  // A stroke used to drop `interaction` here and render as decoration in the
  // editor too, so an arrow or a freehand line could be drawn and then never
  // clicked, moved, recoloured, or given a note.
  if (mark.shape === "pen" || mark.shape === "arrow") {
    return <StrokeMark mark={mark} aspect={aspect} interaction={interaction} />;
  }

  if (mark.shape === "text") {
    return (
      <span
        {...boxedProps}
        style={{
          left: percent(mark.at.x),
          top: percent(mark.at.y),
          // Wrapped at the same ceiling the field wrapped it at while it was
          // being typed, and printed at the size its corners were dragged to.
          maxWidth: percent(annotationTextBox(mark).maxWidth),
          fontSize: `${LABEL_BASE_PX * textScale(mark)}px`,
          color: mark.ink,
          textShadow: `0 0 3px ${STROKE_HALO_INNER}, 0 0 3px ${STROKE_HALO_INNER}`,
        }}
      >
        <span className="block whitespace-pre-wrap break-words px-0.5 font-bold leading-tight">
          {mark.text}
        </span>
      </span>
    );
  }

  return (
    <span
      {...boxedProps}
      style={{
        left: percent(mark.rect.x),
        top: percent(mark.rect.y),
        width: percent(mark.rect.width),
        height: percent(mark.rect.height),
        borderRadius: mark.shape === "box" ? 4 : 3,
        ...boxedFill(mark),
      }}
    >
      {mark.shape === "box" && (
        // Inside the corner, not on it — the selection grip owns the corner
        // itself. `flatten-annotated-image` prints the same disc at the same
        // offset, so what is picked here is what gets sent.
        <span
          style={{
            background: mark.ink,
            left: PIN_INSET_PX - PIN_RADIUS_PX,
            top: PIN_INSET_PX - PIN_RADIUS_PX,
            height: PIN_RADIUS_PX * 2,
            width: PIN_RADIUS_PX * 2,
          }}
          className="absolute flex items-center justify-center rounded-full border-[1.5px] border-on-filled text-[11px] font-bold text-on-filled"
        >
          {ordinal}
        </span>
      )}
    </span>
  );
}

/**
 * A mark's note, drawn on the image itself rather than only travelling as text.
 *
 * The flattened copy is what the vision model actually looks at, so a sentence
 * that only exists in the prompt makes the model match words to regions by
 * position alone. Printed next to its mark, the instruction and the thing it is
 * about arrive together.
 */
export function MarkNoteLabel({
  mark,
  onSelect,
}: {
  mark: ImageAnnotationMark;
  onSelect?: () => void;
}) {
  const note = noteOnImage(mark);
  if (!note) {
    return null;
  }

  // A label is words, and the gesture words invite is "click them to change
  // them". It used to carry a move drag and a width grip instead, so a click
  // moved the sentence and there was no way to edit it from the image at all.
  // The label stops the pointer from reaching the canvas underneath — without
  // that, pressing it also starts a new stroke.
  const interaction = onSelect
    ? {
        onClick: onSelect,
        onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
          event.stopPropagation();
        },
        className: "cursor-text",
        "data-testid": `annotation-note-label-${mark.id}`,
      }
    : { className: "pointer-events-none" };

  return (
    <span
      {...interaction}
      className={cn(
        interaction.className,
        "absolute whitespace-pre-wrap break-words rounded-md px-1.5 py-1 text-[11px] font-semibold leading-snug",
      )}
      style={{
        left: percent(note.box.x),
        top: percent(note.box.y),
        // Content-sized, with the ceiling as the only width anyone sets. A note
        // drawn as wide as its mark left short sentences in a mostly empty
        // strip, and the outline around that emptiness is what made a caption
        // read as an input box.
        maxWidth: percent(note.box.maxWidth),
        color: note.ink,
        // An image can be any colour under the text, so the label carries its
        // own ground rather than relying on a halo to separate it.
        background: NOTE_GROUND,
      }}
    >
      {note.text}
    </span>
  );
}

/**
 * The read-only layer. Sits inside whatever element carries the image so the
 * normalized geometry lands on the same box the marks were drawn against.
 */
export function AnnotationMarkLayer({
  annotation,
  aspect = 1,
}: {
  annotation: ImageAnnotation;
  aspect?: number;
}) {
  return (
    <span
      className="pointer-events-none absolute inset-0"
      data-testid="annotation-mark-layer"
    >
      {annotation.marks.map((mark, index) => {
        return (
          <MarkShape
            key={mark.id}
            mark={mark}
            ordinal={markOrdinal(mark, index)}
            aspect={aspect}
          />
        );
      })}
      {annotation.marks.map((mark) => {
        return <MarkNoteLabel key={`${mark.id}-note`} mark={mark} />;
      })}
    </span>
  );
}
