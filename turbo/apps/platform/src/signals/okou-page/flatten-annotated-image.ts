import { fetchResource } from "../../lib/resource-fetch.ts";
import {
  annotatedImageFilename,
  type ImageAnnotation,
  type ImageAnnotationMark,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  annotationTextBox,
  HIGHLIGHT_FILL,
  markOrdinal,
  NOTE_GROUND,
  noteOnImage,
  PIN_INSET_PX,
  PIN_RADIUS_PX,
  REDACT_FILL,
  STROKE_HALO_INNER,
  textScale,
} from "./image-annotation.ts";
import { createDeferredPromise, withCleanup } from "../utils.ts";

/**
 * Stroke weights are expressed against a 1000px reference edge and scaled to
 * whatever the image actually is. A fixed pixel width would draw a hairline on
 * a 4K screenshot and a crayon on a thumbnail; the mark has to read the same
 * regardless of what the user happened to capture.
 */
const REFERENCE_EDGE_PX = 1000;
const STROKE_WIDTH_UNITS = 3;
const HALO_WIDTH_UNITS = 1;
const PIN_FONT_UNITS = 13;
const TEXT_FONT_UNITS = 18;
const NOTE_FONT_UNITS = 15;
const NOTE_LINE_UNITS = 20;
const NOTE_PADDING_UNITS = 6;
/** Label leading, matching the `leading-tight` the DOM label is printed with. */
const LABEL_LINE_RATIO = 1.25;
const ARROW_HEAD_UNITS = 18;
const CORNER_RADIUS_UNITS = 4;

/**
 * Resolved to a concrete stack rather than passed as `var(...)`: canvas takes a
 * plain CSS font shorthand and does not resolve custom properties. Reading the
 * token keeps flattened annotations on whatever typeface the app is currently
 * rendering.
 */
function annotationFontFamily(): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue("--font-family-sans")
    .trim();
}

interface Scale {
  readonly width: number;
  readonly height: number;
  readonly unit: number;
}

function scaleFor(width: number, height: number): Scale {
  return {
    width,
    height,
    unit: Math.min(width, height) / REFERENCE_EDGE_PX,
  };
}

function px(scale: Scale, units: number): number {
  // Never let a mark disappear on a very small image.
  return Math.max(1, units * scale.unit);
}

/**
 * Reads the original image as bytes, then decodes it from a same-origin blob.
 *
 * This used to be one `<img crossOrigin="anonymous">`, which made flattening the
 * only step in the feature that needed a CORS handshake: the editor renders the
 * very same URL as a plain `<img>`, and a plain `<img>` negotiates nothing. So
 * the image a user had just been drawing on could still refuse to load here,
 * and an image element reports that as a bare `error` event carrying no status,
 * no headers and no reason — which is why the failure had nothing to show for
 * itself.
 *
 * A `fetch` keeps the response observable, so a refused read fails with its HTTP
 * status attached. Decoding through `URL.createObjectURL` then happens on a
 * `blob:` URL, which is same-origin by definition: the canvas is never tainted
 * and `toBlob` below stays readable without asking the CDN for permission.
 */
async function loadImage(
  url: string,
  signal: AbortSignal,
): Promise<HTMLImageElement> {
  // The preview renders this URL through a plain <img>, which can cache an
  // opaque no-CORS response. Bypass that entry so this read performs the CORS
  // request required for access to the image bytes.
  const response = await fetchResource(url, { cache: "no-store" }, signal);
  if (!response.ok) {
    throw new Error(
      `Failed to read image for flattening: ${response.status} ${response.statusText}`,
    );
  }
  const blob = await response.blob();
  signal.throwIfAborted();

  const objectUrl = URL.createObjectURL(blob);
  const deferred = createDeferredPromise<HTMLImageElement>(signal);
  const image = new Image();
  image.addEventListener(
    "load",
    () => {
      deferred.resolve(image);
    },
    { once: true, signal },
  );
  image.addEventListener(
    "error",
    () => {
      deferred.reject(
        new Error(`Failed to decode image for flattening: ${blob.type}`),
      );
    },
    { once: true, signal },
  );
  image.src = objectUrl;
  return await withCleanup(deferred.promise, () => {
    URL.revokeObjectURL(objectUrl);
  });
}

interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function roundedRectPath(
  context: CanvasRenderingContext2D,
  { x, y, width, height }: PixelRect,
  radius: number,
): void {
  const limit = Math.min(radius, Math.abs(width) / 2, Math.abs(height) / 2);
  context.beginPath();
  context.moveTo(x + limit, y);
  context.arcTo(x + width, y, x + width, y + height, limit);
  context.arcTo(x + width, y + height, x, y + height, limit);
  context.arcTo(x, y + height, x, y, limit);
  context.arcTo(x, y, x + width, y, limit);
  context.closePath();
}

/**
 * Draws the shape twice — a light halo, then the ink over it — matching what
 * the editor shows. The dark outer pass is gone: it read as a grey outline
 * around every mark.
 */
function strokeWithHalo(
  context: CanvasRenderingContext2D,
  scale: Scale,
  ink: string,
  path: () => void,
): void {
  const stroke = px(scale, STROKE_WIDTH_UNITS);
  const halo = px(scale, HALO_WIDTH_UNITS);

  context.lineCap = "round";
  context.lineJoin = "round";

  context.strokeStyle = STROKE_HALO_INNER;
  context.lineWidth = stroke + halo * 2;
  path();
  context.stroke();

  context.strokeStyle = ink;
  context.lineWidth = stroke;
  path();
  context.stroke();
}

interface PixelSegment {
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
}

function drawArrowHead(
  context: CanvasRenderingContext2D,
  scale: Scale,
  { fromX, fromY, toX, toY }: PixelSegment,
): () => void {
  const angle = Math.atan2(toY - fromY, toX - fromX);
  const size = px(scale, ARROW_HEAD_UNITS);
  const spread = Math.PI / 7;
  return () => {
    context.beginPath();
    context.moveTo(toX, toY);
    context.lineTo(
      toX - size * Math.cos(angle - spread),
      toY - size * Math.sin(angle - spread),
    );
    context.moveTo(toX, toY);
    context.lineTo(
      toX - size * Math.cos(angle + spread),
      toY - size * Math.sin(angle + spread),
    );
  };
}

function drawPin(
  context: CanvasRenderingContext2D,
  scale: Scale,
  at: { x: number; y: number },
  pin: { ink: string; ordinal: number },
): void {
  const { x, y } = at;
  const { ink, ordinal } = pin;
  const radius = px(scale, PIN_RADIUS_PX);
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fillStyle = ink;
  context.fill();
  context.lineWidth = px(scale, HALO_WIDTH_UNITS * 1.5);
  context.strokeStyle = STROKE_HALO_INNER;
  context.stroke();

  context.fillStyle = "#FFFFFF";
  context.font = `700 ${px(scale, PIN_FONT_UNITS)}px ${annotationFontFamily()}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(String(ordinal), x, y);
}

/**
 * Breaks `text` into lines that fit `maxWidth`, measuring with the font already
 * set on the context. A word longer than the box (a URL, a long identifier) is
 * left to overhang rather than being cut, because a truncated instruction is
 * worse than an untidy one.
 */
function wrapNote(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/u).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && context.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Prints a mark's note onto the image next to the region it is about.
 *
 * This is the whole point of flattening rather than only sending the notes as
 * prompt text: the model sees one picture, and the sentence has to be in it.
 */
function drawNote(
  context: CanvasRenderingContext2D,
  scale: Scale,
  mark: ImageAnnotationMark,
): void {
  const note = noteOnImage(mark);
  if (!note) {
    return;
  }

  const fontSize = px(scale, NOTE_FONT_UNITS);
  const lineHeight = px(scale, NOTE_LINE_UNITS);
  const padding = px(scale, NOTE_PADDING_UNITS);
  context.font = `600 ${fontSize}px ${annotationFontFamily()}`;
  context.textAlign = "left";
  context.textBaseline = "top";

  // The ground is measured from the text, exactly like the label on screen: the
  // note's box is a ceiling to wrap at, not a width to fill, so a three-word
  // note under a wide mark no longer prints a strip of empty white.
  const maxWidth = note.box.maxWidth * scale.width;
  const lines = wrapNote(context, note.text, maxWidth - padding * 2);
  const textWidth = lines.reduce((widest, line) => {
    return Math.max(widest, context.measureText(line).width);
  }, 0);
  const boxWidth = Math.min(maxWidth, textWidth + padding * 2);
  const boxHeight = lines.length * lineHeight + padding * 2;
  const x = note.box.x * scale.width;
  // The box is clamped in normalized space before it gets here, but the height
  // is only known once the text has wrapped. A long note near the bottom would
  // still run past the edge and be cropped out of the image the model reads.
  const y = Math.max(
    0,
    Math.min(note.box.y * scale.height, scale.height - boxHeight),
  );

  context.fillStyle = NOTE_GROUND;
  context.beginPath();
  context.roundRect(x, y, boxWidth, boxHeight, px(scale, CORNER_RADIUS_UNITS));
  context.fill();

  context.fillStyle = note.ink;
  for (const [index, line] of lines.entries()) {
    context.fillText(line, x + padding, y + padding + index * lineHeight);
  }
}

function drawMark(
  context: CanvasRenderingContext2D,
  scale: Scale,
  mark: ImageAnnotationMark,
  ordinal: number,
): void {
  const toX = (value: number) => {
    return value * scale.width;
  };
  const toY = (value: number) => {
    return value * scale.height;
  };

  if (mark.shape === "redact") {
    context.fillStyle = REDACT_FILL;
    context.fillRect(
      toX(mark.rect.x),
      toY(mark.rect.y),
      toX(mark.rect.width),
      toY(mark.rect.height),
    );
    return;
  }

  if (mark.shape === "highlight") {
    context.fillStyle = HIGHLIGHT_FILL;
    context.fillRect(
      toX(mark.rect.x),
      toY(mark.rect.y),
      toX(mark.rect.width),
      toY(mark.rect.height),
    );
    return;
  }

  if (mark.shape === "box") {
    const x = toX(mark.rect.x);
    const y = toY(mark.rect.y);
    const width = toX(mark.rect.width);
    const height = toY(mark.rect.height);
    strokeWithHalo(context, scale, mark.ink, () => {
      roundedRectPath(
        context,
        { x, y, width, height },
        px(scale, CORNER_RADIUS_UNITS),
      );
    });
    // Inset to match the editor, where the corner belongs to the resize grip.
    const inset = px(scale, PIN_INSET_PX);
    drawPin(
      context,
      scale,
      { x: x + inset, y: y + inset },
      { ink: mark.ink, ordinal },
    );
    return;
  }

  if (mark.shape === "arrow") {
    const fromX = toX(mark.from.x);
    const fromY = toY(mark.from.y);
    const tipX = toX(mark.to.x);
    const tipY = toY(mark.to.y);
    strokeWithHalo(context, scale, mark.ink, () => {
      context.beginPath();
      context.moveTo(fromX, fromY);
      context.lineTo(tipX, tipY);
    });
    strokeWithHalo(
      context,
      scale,
      mark.ink,
      drawArrowHead(context, scale, {
        fromX,
        fromY,
        toX: tipX,
        toY: tipY,
      }),
    );
    drawPin(context, scale, { x: fromX, y: fromY }, { ink: mark.ink, ordinal });
    return;
  }

  if (mark.shape === "pen") {
    if (mark.points.length < 2) {
      return;
    }
    strokeWithHalo(context, scale, mark.ink, () => {
      context.beginPath();
      for (const [index, point] of mark.points.entries()) {
        const x = toX(point.x);
        const y = toY(point.y);
        if (index === 0) {
          context.moveTo(x, y);
        } else {
          context.lineTo(x, y);
        }
      }
    });
    return;
  }

  const x = toX(mark.at.x);
  const y = toY(mark.at.y);
  // The size the label's corners were dragged to, and the same ceiling the
  // field wrapped it at. `fillText` draws one line and ignores `\n`, so a label
  // that wrapped on screen used to print as a single run past the edge.
  const fontSize = px(scale, TEXT_FONT_UNITS) * textScale(mark);
  const lineHeight = fontSize * LABEL_LINE_RATIO;
  context.font = `700 ${fontSize}px ${annotationFontFamily()}`;
  context.textAlign = "left";
  context.textBaseline = "top";
  context.lineJoin = "round";
  context.lineWidth = px(scale, HALO_WIDTH_UNITS * 3);
  const lines = wrapNote(
    context,
    mark.text,
    annotationTextBox(mark).maxWidth * scale.width,
  );
  for (const [index, line] of lines.entries()) {
    const lineY = y + index * lineHeight;
    context.strokeStyle = STROKE_HALO_INNER;
    context.strokeText(line, x, lineY);
    context.fillStyle = mark.ink;
    context.fillText(line, x, lineY);
  }
}

interface FlattenedAnnotatedImage {
  readonly file: File;
  readonly width: number;
  readonly height: number;
}

/**
 * Renders `annotation` into a copy of the image at its **native** resolution.
 *
 * Flattening at the size the editor happened to display would resample every
 * mark and alias the small text that screenshots are usually full of, so the
 * canvas is sized from `naturalWidth`/`naturalHeight` and the normalized
 * geometry is projected onto that instead.
 */
export async function flattenAnnotatedImage(
  url: string,
  annotation: ImageAnnotation,
  filename: string,
  signal: AbortSignal,
): Promise<FlattenedAnnotatedImage> {
  const image = await loadImage(url, signal);
  signal.throwIfAborted();

  const crop = annotation.crop;
  const sourceX = crop ? crop.x * image.naturalWidth : 0;
  const sourceY = crop ? crop.y * image.naturalHeight : 0;
  const width = Math.max(
    1,
    Math.round(crop ? crop.width * image.naturalWidth : image.naturalWidth),
  );
  const height = Math.max(
    1,
    Math.round(crop ? crop.height * image.naturalHeight : image.naturalHeight),
  );

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas 2D context unavailable");
  }

  context.drawImage(
    image,
    sourceX,
    sourceY,
    width,
    height,
    0,
    0,
    width,
    height,
  );

  const scale = scaleFor(width, height);
  for (const [index, mark] of annotation.marks.entries()) {
    context.save();
    drawMark(context, scale, mark, markOrdinal(mark, index));
    context.restore();
    context.save();
    drawNote(context, scale, mark);
    context.restore();
  }

  const encoded = createDeferredPromise<Blob | null>(signal);
  canvas.toBlob(encoded.resolve, "image/png");
  const blob = await encoded.promise;
  signal.throwIfAborted();
  if (!blob) {
    throw new Error("Failed to encode the annotated image");
  }

  return {
    file: new File([blob], annotatedImageFilename(filename), {
      type: "image/png",
    }),
    width,
    height,
  };
}
