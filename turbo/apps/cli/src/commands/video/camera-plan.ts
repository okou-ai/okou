import {
  array,
  literal,
  number,
  object,
  string,
  union,
  enum as zEnum,
  unknown as zUnknown,
  type infer as zInfer,
} from "zod";

/**
 * Click-driven camera, second algorithm.
 *
 * The camera exists to show clicks and typing. Everything else about the
 * pointer is used only to keep the picture calm:
 *
 * - A click pushes the camera in on what was clicked: the element the click
 *   hit when the recording says what that was, else the point. The move is a
 *   finite ease-in-out that ends on the click, so the click lands in a frame
 *   that has already settled. After a click the camera stays put for a beat
 *   before it may leave, and the one thing that must never happen, a click
 *   outside the frame, is verified against the simulated camera and repaired
 *   by starting a move earlier.
 * - Between clicks the camera pulls back to the shot's base framing, which
 *   fits every click of the shot, so the viewer keeps their bearings. A click
 *   that changed the page around it pulls back early, so the viewer sees the
 *   result rather than the spot that used to be a menu.
 * - Typing keeps the camera on the field it was typed into.
 * - Drags, jitter and a pointer parked outside the frame move nothing.
 */

const BASE_ZOOM_MAX = 2;
const BASE_ZOOM_MIN = 1.5;
const FOCUS_ZOOM = 2.2;
/** Fraction of the viewport a click point must end up inside. */
const COMFORT = 0.5;
/** Viewport left around a framed element. */
const ELEMENT_MARGIN = 0.08;
/** An element larger than this share of the content is a container, not a target. */
const ELEMENT_MAX_AREA = 0.6;
const HOLD_MS = 2_200;
const MERGE_GAP_MS = 6_000;
const MIN_SHOT_MS = 2_500;
const KEEP_TO_END_MS = 1_500;
const ZOOM_IN_MS = 800;
const PUSH_MS = 650;
const PULL_MS = 800;
const ZOOM_OUT_MS = 1_000;
/** Only pull back to the base framing when the next push-in is at least this far off. */
const PULL_GAP_MS = 1_200;
/** After a click the camera stays put this long before its next move. */
const DWELL_MS = 700;
/** A pointer at rest on the target this long before the click lets the camera arrive early. */
const EARLY_ARRIVAL_MS = 300;
const ARRIVAL_RADIUS_PX = 60;
const SMOOTH_WINDOW_MS = 100;
/** A burst shorter than this is a shortcut, not typing. */
const TYPING_MIN_MS = 1_000;
/** Share of pixels that changed after a click for the page to count as changed. */
/** How long after a click the picture is compared with the click frame. */
export const REACTION_DELAY_MS = 400;
const REACTION_LOCAL = 0.12;
const REACTION_PAGE = 0.35;
const REACTION_RELEASE_MS = 300;
/** A click must sit at least this far inside the frame at its own moment. */
const CLICK_MARGIN = 0.06;
const MAX_REPAIR_ROUNDS = 20;

const FRAMED_ROLES = new Set([
  "AXTextField",
  "AXTextArea",
  "AXComboBox",
  "AXSearchField",
  "AXButton",
  "AXPopUpButton",
  "AXMenuButton",
  "AXMenuItem",
  "AXCheckBox",
  "AXRadioButton",
  "AXLink",
  "AXTab",
  "AXCell",
  "AXRow",
]);

const normalizedPointSchema = object({
  x: number().min(0).max(1),
  y: number().min(0).max(1),
});

const normalizedRectSchema = object({
  x: number().min(0).max(1),
  y: number().min(0).max(1),
  width: number().min(0).max(1),
  height: number().min(0).max(1),
});

const clickElementSchema = object({
  role: string(),
  normalized: normalizedRectSchema,
}).passthrough();

const trackedPointerEventSchema = object({
  tMs: number().int().nonnegative(),
  kind: zEnum(["click", "move"]),
  normalized: normalizedPointSchema,
  element: clickElementSchema.optional(),
}).passthrough();

const trackedClickSchema = object({
  tMs: number().int().nonnegative(),
  normalized: normalizedPointSchema,
  element: clickElementSchema.optional(),
}).passthrough();

const typingBurstSchema = object({
  startMs: number().int().nonnegative(),
  endMs: number().int().nonnegative(),
});

const pixelRectSchema = object({
  x: number(),
  y: number(),
  width: number().positive(),
  height: number().positive(),
});

const desktopInputTrackSchema = object({
  version: literal(1),
  recording: object({
    durationMs: number().int().positive(),
    video: object({
      width: number().int().positive(),
      height: number().int().positive(),
      frameRate: number().positive(),
    }).passthrough(),
    content: object({ pixelRect: pixelRectSchema.optional() })
      .passthrough()
      .optional(),
  }).passthrough(),
  clicks: array(trackedClickSchema).default([]),
  pointerEvents: array(trackedPointerEventSchema).optional(),
  typingBursts: array(typingBurstSchema).optional(),
}).passthrough();

const demoCaptureTrackSchema = object({
  schemaVersion: literal(1),
  session: object({
    recording: object({
      durationMs: number().positive(),
      goOffsetMs: number().default(0),
      width: number().int().positive(),
      height: number().int().positive(),
      frameRate: number().positive(),
    }).passthrough(),
  }).passthrough(),
  events: array(zUnknown()),
}).passthrough();

export const inputTrackSchema = union([
  desktopInputTrackSchema,
  demoCaptureTrackSchema,
]);

const demoPointerSampleSchema = object({
  type: zEnum(["pointermove", "pointerdown", "click"]),
  t: number().nonnegative(),
  nx: number().min(0).max(1),
  ny: number().min(0).max(1),
}).passthrough();

const viewportSchema = object({
  x: number(),
  y: number(),
  width: number().positive(),
});

const cameraKeySchema = object({
  id: string().min(1),
  startMs: number().int(),
  durationMs: number().int().positive(),
  rect: viewportSchema,
  reason: string(),
  clickMs: number().int().nonnegative().optional(),
});

const cameraShotSchema = object({
  id: string().min(1),
  startMs: number().int().nonnegative(),
  endMs: number().int().positive(),
  baseZoom: number().min(1).max(4),
  keys: array(cameraKeySchema).min(1),
}).refine(
  (shot) => {
    return shot.endMs > shot.startMs;
  },
  { message: "Camera shot endMs must be greater than startMs" },
);

export const cameraPlanSchema = object({
  version: literal(2),
  algorithm: literal("click-camera-v2"),
  source: object({
    durationMs: number().int().positive(),
    width: number().int().positive(),
    height: number().int().positive(),
    frameRate: number().positive().max(240),
  }),
  content: pixelRectSchema,
  shots: array(cameraShotSchema),
  /** The clicks the plan serves, so a review can check them against whatever the plan became. */
  clicks: array(
    object({
      tMs: number().int().nonnegative(),
      x: number(),
      y: number(),
      elementRole: string().optional(),
      /** Share of the picture that changed within `REACTION_DELAY_MS` of the click. */
      reaction: number().min(0).max(1).optional(),
    }),
  ).default([]),
}).superRefine((plan, context) => {
  let previousEndMs = 0;
  for (const [shotIndex, shot] of plan.shots.entries()) {
    if (shot.startMs < previousEndMs) {
      context.addIssue({
        code: "custom",
        path: ["shots", shotIndex, "startMs"],
        message: "Camera shots must be ordered and must not overlap",
      });
    }
    if (shot.endMs > plan.source.durationMs) {
      context.addIssue({
        code: "custom",
        path: ["shots", shotIndex, "endMs"],
        message: "Camera shot exceeds the source duration",
      });
    }
    let previousKeyMs = Number.NEGATIVE_INFINITY;
    for (const [keyIndex, key] of shot.keys.entries()) {
      if (key.startMs < previousKeyMs) {
        context.addIssue({
          code: "custom",
          path: ["shots", shotIndex, "keys", keyIndex, "startMs"],
          message: "Camera keys must be ordered inside their shot",
        });
      }
      previousKeyMs = key.startMs;
    }
    previousEndMs = shot.endMs;
  }
});

type DesktopInputTrack = zInfer<typeof desktopInputTrackSchema>;
type DemoCaptureTrack = zInfer<typeof demoCaptureTrackSchema>;
type InputTrack = zInfer<typeof inputTrackSchema>;
export type CameraPlan = zInfer<typeof cameraPlanSchema>;

export interface VideoSource {
  readonly durationMs: number;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
}

export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * What the command learned from the video itself before planning: where the
 * content sits (a letterbox band is not content) and how much the picture
 * changed right after each click.
 */
export interface SourceAnalysis {
  readonly contentRect: PixelRect | null;
  /** Click time in ms to the share of pixels that changed within 400 ms of it. */
  readonly reactions: ReadonlyMap<number, number>;
}

export interface CameraFrameState {
  readonly timeMs: number;
  readonly scale: number;
  readonly cropWidth: number;
  readonly cropHeight: number;
  readonly cropX: number;
  readonly cropY: number;
}

interface Viewport {
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

interface PointerSample {
  readonly tMs: number;
  readonly kind: "click" | "move";
  readonly x: number;
  readonly y: number;
}

interface ClickTarget {
  readonly tMs: number;
  readonly x: number;
  readonly y: number;
  readonly element: PixelRect | null;
  readonly elementRole: string | null;
}

interface PlannedKey {
  startMs: number;
  readonly rect: Viewport;
  readonly durationMs: number;
  readonly reason: string;
  readonly click: ClickTarget | null;
  /** When the camera may leave this key's framing. */
  releaseMs: number;
}

interface PlannedShot {
  readonly clicks: ClickTarget[];
  startMs: number;
  endMs: number;
  baseZoom: number;
  keys: PlannedKey[];
}

function isDemoCaptureTrack(track: InputTrack): track is DemoCaptureTrack {
  return "schemaVersion" in track;
}

function desktopSamples(track: DesktopInputTrack): readonly PointerSample[] {
  const pointerEvents = track.pointerEvents ?? [];
  const samples =
    pointerEvents.length > 0
      ? pointerEvents.map((event) => {
          return {
            tMs: event.tMs,
            kind: event.kind,
            x: event.normalized.x,
            y: event.normalized.y,
          };
        })
      : track.clicks.map((click) => {
          return {
            tMs: click.tMs,
            kind: "click" as const,
            x: click.normalized.x,
            y: click.normalized.y,
          };
        });
  return samples.slice().sort((left, right) => {
    return left.tMs - right.tMs;
  });
}

function demoCaptureSamples(track: DemoCaptureTrack): readonly PointerSample[] {
  const events = track.events.flatMap((rawEvent) => {
    const parsed = demoPointerSampleSchema.safeParse(rawEvent);
    return parsed.success ? [parsed.data] : [];
  });
  const clickType = events.some((event) => {
    return event.type === "pointerdown";
  })
    ? "pointerdown"
    : "click";
  const goOffsetMs = track.session.recording.goOffsetMs;

  return events
    .filter((event) => {
      return event.type === "pointermove" || event.type === clickType;
    })
    .flatMap((event) => {
      const tMs = Math.round(event.t - goOffsetMs);
      if (tMs < 0) {
        return [];
      }
      const kind: PointerSample["kind"] =
        event.type === clickType ? "click" : "move";
      return [{ tMs, kind, x: event.nx, y: event.ny }];
    })
    .sort((left, right) => {
      return left.tMs - right.tMs;
    });
}

function samplesFromTrack(track: InputTrack): readonly PointerSample[] {
  return isDemoCaptureTrack(track)
    ? demoCaptureSamples(track)
    : desktopSamples(track);
}

export function inputTrackClickTimes(track: InputTrack): readonly number[] {
  return samplesFromTrack(track)
    .filter((sample) => {
      return sample.kind === "click";
    })
    .map((sample) => {
      return sample.tMs;
    });
}

export function inputTrackVideoSource(track: InputTrack): VideoSource {
  if (isDemoCaptureTrack(track)) {
    return {
      durationMs: Math.round(track.session.recording.durationMs),
      width: track.session.recording.width,
      height: track.session.recording.height,
      frameRate: track.session.recording.frameRate,
    };
  }
  return {
    durationMs: track.recording.durationMs,
    width: track.recording.video.width,
    height: track.recording.video.height,
    frameRate: track.recording.video.frameRate,
  };
}

function trackTypingBursts(
  track: InputTrack,
): readonly { readonly startMs: number; readonly endMs: number }[] {
  if (isDemoCaptureTrack(track)) {
    return [];
  }
  return (track.typingBursts ?? [])
    .filter((burst) => {
      return burst.endMs - burst.startMs >= TYPING_MIN_MS;
    })
    .sort((left, right) => {
      return left.startMs - right.startMs;
    });
}

function trackContentRect(track: InputTrack): PixelRect | null {
  if (isDemoCaptureTrack(track)) {
    return null;
  }
  return track.recording.content?.pixelRect ?? null;
}

function clickTargets(
  track: InputTrack,
  source: VideoSource,
  content: PixelRect,
): readonly ClickTarget[] {
  const elementsByTime = new Map<
    number,
    { readonly role: string; readonly rect: PixelRect }
  >();
  if (!isDemoCaptureTrack(track)) {
    const carriers = [
      ...track.clicks,
      ...(track.pointerEvents ?? []).filter((event) => {
        return event.kind === "click";
      }),
    ];
    for (const carrier of carriers) {
      const element = carrier.element;
      if (!element || !FRAMED_ROLES.has(element.role)) {
        continue;
      }
      const rect = {
        x: element.normalized.x * source.width,
        y: element.normalized.y * source.height,
        width: element.normalized.width * source.width,
        height: element.normalized.height * source.height,
      };
      const share =
        (rect.width * rect.height) / (content.width * content.height);
      if (rect.width < 8 || rect.height < 8 || share > ELEMENT_MAX_AREA) {
        continue;
      }
      elementsByTime.set(carrier.tMs, { role: element.role, rect });
    }
  }
  return samplesFromTrack(track)
    .filter((sample) => {
      return sample.kind === "click" && sample.tMs <= source.durationMs;
    })
    .map((sample) => {
      const element = elementsByTime.get(sample.tMs) ?? null;
      return {
        tMs: sample.tMs,
        x: sample.x * source.width,
        y: sample.y * source.height,
        element: element?.rect ?? null,
        elementRole: element?.role ?? null,
      };
    });
}

/** The pointer's path with the jitter taken out: a short median in time. */
function smoothedTrail(
  samples: readonly PointerSample[],
  source: VideoSource,
): readonly { readonly tMs: number; readonly x: number; readonly y: number }[] {
  const moves = samples.filter((sample) => {
    return sample.kind === "move";
  });
  const median = (values: number[]): number => {
    const sorted = values.slice().sort((left, right) => {
      return left - right;
    });
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
  };
  return moves.map((move, index) => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (
      let other = index;
      other >= 0 && move.tMs - (moves[other]?.tMs ?? 0) <= SMOOTH_WINDOW_MS / 2;
      other -= 1
    ) {
      const sample = moves[other];
      if (sample) {
        xs.push(sample.x * source.width);
        ys.push(sample.y * source.height);
      }
    }
    for (
      let other = index + 1;
      other < moves.length &&
      (moves[other]?.tMs ?? 0) - move.tMs <= SMOOTH_WINDOW_MS / 2;
      other += 1
    ) {
      const sample = moves[other];
      if (sample) {
        xs.push(sample.x * source.width);
        ys.push(sample.y * source.height);
      }
    }
    return { tMs: move.tMs, x: median(xs), y: median(ys) };
  });
}

class CameraGeometry {
  constructor(
    readonly source: VideoSource,
    readonly content: PixelRect,
  ) {}

  height(width: number): number {
    return (width * this.source.height) / this.source.width;
  }

  /**
   * Keeps a viewport inside the content area, continuously. A viewport wider
   * than the content sits at its left edge; there is no separate frame-sized
   * regime, because switching regimes as the width crossed the content width
   * made the viewport reverse for one frame mid zoom.
   */
  clamp(viewport: Viewport): Viewport {
    const width = Math.min(
      Math.max(viewport.width, this.source.width / 4),
      this.source.width,
    );
    const height = this.height(width);
    const maxX = this.content.x + Math.max(0, this.content.width - width);
    const maxY = this.content.y + Math.max(0, this.content.height - height);
    return {
      x: Math.min(Math.max(viewport.x, this.content.x), maxX),
      y: Math.min(Math.max(viewport.y, this.content.y), maxY),
      width,
    };
  }

  /**
   * The wide shot is the content area itself, not the whole frame: with every
   * target inside the content area, a straight interpolation between any two
   * of them stays inside it, so no frame of a move ever needs clamping and a
   * letterbox band never appears.
   */
  wide(): Viewport {
    const width = Math.min(
      this.content.width,
      (this.content.height * this.source.width) / this.source.height,
    );
    return this.clamp({
      x: this.content.x,
      y: this.content.y + (this.content.height - this.height(width)) / 2,
      width,
    });
  }

  centered(x: number, y: number, width: number): Viewport {
    return this.clamp({
      x: x - width / 2,
      y: y - this.height(width) / 2,
      width,
    });
  }

  focus(click: ClickTarget): Viewport {
    let width = this.source.width / FOCUS_ZOOM;
    if (click.element) {
      const element = click.element;
      width = Math.min(
        this.content.width,
        Math.max(
          width,
          element.width / (1 - 2 * ELEMENT_MARGIN),
          ((element.height / (1 - 2 * ELEMENT_MARGIN)) * this.source.width) /
            this.source.height,
        ),
      );
      return this.centered(
        element.x + element.width / 2,
        element.y + element.height / 2,
        width,
      );
    }
    return this.centered(click.x, click.y, width);
  }

  base(shot: PlannedShot): Viewport {
    const xs = shot.clicks.map((click) => {
      return click.x;
    });
    const ys = shot.clicks.map((click) => {
      return click.y;
    });
    return this.centered(
      (Math.min(...xs) + Math.max(...xs)) / 2,
      (Math.min(...ys) + Math.max(...ys)) / 2,
      this.source.width / shot.baseZoom,
    );
  }

  fitZoom(clicks: readonly ClickTarget[]): number {
    const xs = clicks.map((click) => {
      return click.x;
    });
    const ys = clicks.map((click) => {
      return click.y;
    });
    const spreadX = Math.max(...xs) - Math.min(...xs);
    const spreadY = Math.max(...ys) - Math.min(...ys);
    const zoom = Math.min(
      this.source.width / Math.max(spreadX / COMFORT, 1),
      this.source.height / Math.max(spreadY / COMFORT, 1),
      BASE_ZOOM_MAX,
    );
    return Math.max(BASE_ZOOM_MIN, zoom);
  }

  contains(viewport: Viewport, x: number, y: number, margin: number): boolean {
    const height = this.height(viewport.width);
    const marginPx = viewport.width * margin;
    return (
      x >= viewport.x + marginPx &&
      x <= viewport.x + viewport.width - marginPx &&
      y >= viewport.y + marginPx &&
      y <= viewport.y + height - marginPx
    );
  }
}

function sameViewport(left: Viewport, right: Viewport): boolean {
  return (
    Math.abs(left.x - right.x) < 1 &&
    Math.abs(left.y - right.y) < 1 &&
    Math.abs(left.width - right.width) < 1
  );
}

function arrivalMs(
  click: ClickTarget,
  trail: readonly {
    readonly tMs: number;
    readonly x: number;
    readonly y: number;
  }[],
): number {
  let arrival = click.tMs;
  for (let index = trail.length - 1; index >= 0; index -= 1) {
    const sample = trail[index];
    if (!sample || sample.tMs > click.tMs) {
      continue;
    }
    if (
      Math.hypot(sample.x - click.x, sample.y - click.y) <= ARRIVAL_RADIUS_PX
    ) {
      arrival = sample.tMs;
    } else {
      break;
    }
  }
  return arrival;
}

function typingEndAfter(
  bursts: readonly { readonly startMs: number; readonly endMs: number }[],
  fromMs: number,
  untilMs: number,
): number | null {
  let end: number | null = null;
  for (const burst of bursts) {
    if (burst.startMs >= fromMs && burst.startMs < untilMs) {
      end = Math.max(end ?? 0, burst.endMs);
    }
  }
  return end;
}

function groupShots(
  clicks: readonly ClickTarget[],
  bursts: readonly { readonly startMs: number; readonly endMs: number }[],
  durationMs: number,
): PlannedShot[] {
  const shots: PlannedShot[] = [];
  for (const click of clicks) {
    const last = shots.at(-1);
    const lastClick = last?.clicks.at(-1);
    if (last && lastClick && click.tMs - lastClick.tMs <= MERGE_GAP_MS) {
      last.clicks.push(click);
    } else {
      shots.push({
        clicks: [click],
        startMs: 0,
        endMs: 0,
        baseZoom: 1,
        keys: [],
      });
    }
  }
  for (const shot of shots) {
    const lastClick = shot.clicks.at(-1);
    if (!lastClick) {
      continue;
    }
    shot.endMs = lastClick.tMs + HOLD_MS;
    const typedUntil = typingEndAfter(
      bursts,
      lastClick.tMs,
      shot.endMs + 1_500,
    );
    if (typedUntil !== null) {
      shot.endMs = Math.max(shot.endMs, typedUntil + HOLD_MS);
    }
    if (shot.endMs >= durationMs - KEEP_TO_END_MS) {
      shot.endMs = durationMs;
    }
    shot.startMs = Math.max(0, (shot.clicks[0]?.tMs ?? 0) - ZOOM_IN_MS);
  }
  const merged: PlannedShot[] = [];
  for (const shot of shots) {
    const previous = merged.at(-1);
    if (
      previous &&
      (shot.endMs - shot.startMs < MIN_SHOT_MS ||
        shot.startMs - previous.endMs < 3_500)
    ) {
      previous.clicks.push(...shot.clicks);
      previous.endMs = shot.endMs;
    } else {
      merged.push(shot);
    }
  }
  return merged.map((shot) => {
    return { ...shot, endMs: Math.min(shot.endMs, durationMs) };
  });
}

type Trail = readonly {
  readonly tMs: number;
  readonly x: number;
  readonly y: number;
}[];
type TypingBursts = readonly {
  readonly startMs: number;
  readonly endMs: number;
}[];

function describeClick(click: ClickTarget): string {
  return click.elementRole
    ? `click at ${String(click.tMs)} ms on ${click.elementRole}`
    : `click at ${String(click.tMs)} ms`;
}

/** When a move for this click should be done: on the click, or a beat after the pointer settled early on it. */
function moveEndMs(click: ClickTarget, trail: Trail): number {
  const arrival = arrivalMs(click, trail);
  return click.tMs - arrival >= EARLY_ARRIVAL_MS ? arrival + 150 : click.tMs;
}

function pushInKey(args: {
  readonly click: ClickTarget;
  readonly index: number;
  readonly next: ClickTarget | null;
  readonly previous: PlannedKey | undefined;
  readonly rect: Viewport;
  readonly trail: Trail;
  readonly bursts: TypingBursts;
  readonly reaction: number;
  readonly durationMs: number;
}): PlannedKey {
  const { click, index, next, previous, rect, trail, bursts, reaction } = args;
  const endMs = moveEndMs(click, trail);
  let startMs = endMs - args.durationMs;
  if (previous) {
    startMs = Math.max(startMs, previous.releaseMs);
  }
  let releaseMs = click.tMs + DWELL_MS;
  const typedUntil = typingEndAfter(
    bursts,
    click.tMs,
    next ? next.tMs : args.durationMs + Number.MAX_SAFE_INTEGER / 2,
  );
  if (typedUntil !== null) {
    releaseMs = Math.max(releaseMs, typedUntil + DWELL_MS);
  } else if (reaction >= REACTION_LOCAL) {
    releaseMs = Math.min(releaseMs, click.tMs + REACTION_RELEASE_MS);
  }
  const lateMs = startMs + args.durationMs - click.tMs;
  const verb = index === 0 ? "zoom in" : "push in";
  return {
    startMs,
    rect,
    durationMs: args.durationMs,
    reason:
      `${verb} on ${describeClick(click)}` +
      (lateMs > 0 ? `, arriving ${String(lateMs)} ms after it` : "") +
      (typedUntil !== null
        ? `, holding through typing until ${String(typedUntil)} ms`
        : ""),
    click,
    releaseMs,
  };
}

function pullBackKey(args: {
  readonly click: ClickTarget;
  readonly from: PlannedKey;
  readonly next: ClickTarget | null;
  readonly base: Viewport;
  readonly wide: Viewport;
  readonly trail: Trail;
  readonly reaction: number;
  readonly shotEndMs: number;
}): PlannedKey | null {
  const { click, from, next, reaction } = args;
  const pageChanged = reaction >= REACTION_PAGE;
  const target = pageChanged ? args.wide : args.base;
  const nextStartMs = next
    ? Math.max(moveEndMs(next, args.trail) - PUSH_MS, from.releaseMs)
    : null;
  const farEnough =
    nextStartMs === null || nextStartMs - from.releaseMs >= PULL_GAP_MS;
  if ((!farEnough && !pageChanged) || sameViewport(target, from.rect)) {
    return null;
  }
  if (next === null && from.releaseMs + PULL_MS >= args.shotEndMs) {
    return null;
  }
  const reason = pageChanged
    ? `pull back to the wide shot: the page changed after the ${describeClick(click)}`
    : reaction >= REACTION_LOCAL
      ? `pull back early: the picture changed after the ${describeClick(click)}`
      : `pull back to the base framing after the ${describeClick(click)}`;
  return {
    startMs: from.releaseMs,
    rect: target,
    durationMs: PULL_MS,
    reason,
    click: null,
    releaseMs: from.releaseMs + PULL_MS,
  };
}

function planKeys(
  shot: PlannedShot,
  geometry: CameraGeometry,
  trail: Trail,
  bursts: TypingBursts,
  reactions: ReadonlyMap<number, number>,
): PlannedKey[] {
  const base = geometry.base(shot);
  const wide = geometry.wide();
  const keys: PlannedKey[] = [];
  shot.clicks.forEach((click, index) => {
    const next = shot.clicks[index + 1] ?? null;
    const previous = keys.at(-1);
    const rect = geometry.focus(click);
    if (previous?.click && sameViewport(rect, previous.rect)) {
      previous.releaseMs = Math.max(previous.releaseMs, click.tMs + DWELL_MS);
      return;
    }
    const reaction = reactions.get(click.tMs) ?? 0;
    const pushIn = pushInKey({
      click,
      index,
      next,
      previous,
      rect,
      trail,
      bursts,
      reaction,
      durationMs: index === 0 ? ZOOM_IN_MS : PUSH_MS,
    });
    keys.push(pushIn);
    const pullBack = pullBackKey({
      click,
      from: pushIn,
      next,
      base,
      wide,
      trail,
      reaction,
      shotEndMs: shot.endMs,
    });
    if (pullBack) {
      keys.push(pullBack);
    }
  });
  return keys;
}

/** Zero velocity and acceleration at both ends; the move has a clear start and stop. */
function ease(progress: number): number {
  const clamped = Math.min(1, Math.max(0, progress));
  return clamped * clamped * clamped * (clamped * (clamped * 6 - 15) + 10);
}

function simulate(
  shots: readonly PlannedShot[],
  geometry: CameraGeometry,
  source: VideoSource,
): readonly CameraFrameState[] {
  const frameMs = 1_000 / source.frameRate;
  const frameCount = Math.max(
    1,
    Math.ceil((source.durationMs / 1_000) * source.frameRate),
  );
  const wide = geometry.wide();
  const frames: CameraFrameState[] = [];
  let current = wide;
  let move: {
    readonly startMs: number;
    readonly from: Viewport;
    readonly to: Viewport;
    readonly durationMs: number;
  } | null = null;
  let activeId: string | null = null;

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const timeMs = frameIndex * frameMs;
    const shotIndex = shots.findIndex((shot) => {
      return shot.startMs <= timeMs && timeMs < shot.endMs;
    });
    const shot = shots[shotIndex];
    let wanted: {
      readonly id: string;
      readonly rect: Viewport;
      readonly durationMs: number;
      readonly startMs: number;
    };
    if (shot) {
      const active = shot.keys.filter((key) => {
        return key.startMs <= timeMs;
      });
      const key = active.at(-1);
      wanted = key
        ? {
            id: `shot-${String(shotIndex)}-key-${String(shot.keys.indexOf(key))}`,
            rect: key.rect,
            durationMs: key.durationMs,
            startMs: key.startMs,
          }
        : {
            id: `shot-${String(shotIndex)}-wide`,
            rect: wide,
            durationMs: ZOOM_OUT_MS,
            startMs: shot.startMs,
          };
    } else {
      let previousIndex = -1;
      for (let index = shots.length - 1; index >= 0; index -= 1) {
        if ((shots[index]?.endMs ?? Number.POSITIVE_INFINITY) <= timeMs) {
          previousIndex = index;
          break;
        }
      }
      const previous = shots[previousIndex];
      wanted = {
        id: previous ? `after-shot-${String(previousIndex)}` : "idle",
        rect: wide,
        durationMs: ZOOM_OUT_MS,
        startMs: previous?.endMs ?? 0,
      };
    }
    if (wanted.id !== activeId) {
      activeId = wanted.id;
      if (!sameViewport(wanted.rect, current)) {
        move = {
          startMs: Math.max(wanted.startMs, timeMs - frameMs),
          from: current,
          to: wanted.rect,
          durationMs: wanted.durationMs,
        };
      }
    }
    if (move) {
      const progress = (timeMs - move.startMs) / move.durationMs;
      const eased = ease(progress);
      current = {
        x: move.from.x + (move.to.x - move.from.x) * eased,
        y: move.from.y + (move.to.y - move.from.y) * eased,
        width: move.from.width + (move.to.width - move.from.width) * eased,
      };
      if (progress >= 1) {
        current = move.to;
        move = null;
      }
    }
    const viewport = geometry.clamp(current);
    frames.push({
      timeMs,
      scale: source.width / viewport.width,
      cropWidth: viewport.width,
      cropHeight: geometry.height(viewport.width),
      cropX: viewport.x,
      cropY: viewport.y,
    });
  }
  return frames;
}

function frameAt(
  frames: readonly CameraFrameState[],
  timeMs: number,
  frameRate: number,
): CameraFrameState | undefined {
  const index = Math.min(
    frames.length - 1,
    Math.max(0, Math.round((timeMs / 1_000) * frameRate)),
  );
  return frames[index];
}

function clickInFrame(
  frames: readonly CameraFrameState[],
  click: ClickTarget,
  source: VideoSource,
  margin: number,
): boolean {
  const frame = frameAt(frames, click.tMs, source.frameRate);
  if (!frame) {
    return false;
  }
  const marginPx = frame.cropWidth * margin;
  return (
    click.x >= frame.cropX + marginPx &&
    click.x <= frame.cropX + frame.cropWidth - marginPx &&
    click.y >= frame.cropY + marginPx &&
    click.y <= frame.cropY + frame.cropHeight - marginPx
  );
}

function toPlanShots(shots: readonly PlannedShot[]): CameraPlan["shots"] {
  return shots.map((shot, shotIndex) => {
    const id = `shot-${String(shotIndex + 1).padStart(3, "0")}`;
    return {
      id,
      startMs: Math.round(shot.startMs),
      endMs: Math.round(shot.endMs),
      baseZoom: shot.baseZoom,
      keys: shot.keys.map((key, keyIndex) => {
        return {
          id: `${id}-key-${String(keyIndex + 1).padStart(3, "0")}`,
          startMs: Math.round(key.startMs),
          durationMs: key.durationMs,
          rect: {
            x: Math.round(key.rect.x * 1_000) / 1_000,
            y: Math.round(key.rect.y * 1_000) / 1_000,
            width: Math.round(key.rect.width * 1_000) / 1_000,
          },
          reason: key.reason,
          ...(key.click ? { clickMs: key.click.tMs } : {}),
        };
      }),
    };
  });
}

function fromPlanShots(plan: CameraPlan): PlannedShot[] {
  return plan.shots.map((shot) => {
    return {
      clicks: [],
      startMs: shot.startMs,
      endMs: shot.endMs,
      baseZoom: shot.baseZoom,
      keys: shot.keys.map((key) => {
        return {
          startMs: key.startMs,
          rect: key.rect,
          durationMs: key.durationMs,
          reason: key.reason,
          click: null,
          releaseMs: key.startMs + key.durationMs,
        };
      }),
    };
  });
}

export function createCameraPlan(
  track: InputTrack,
  source: VideoSource,
  analysis: SourceAnalysis,
): CameraPlan {
  const describedSource = inputTrackVideoSource(track);
  if (
    describedSource.width !== source.width ||
    describedSource.height !== source.height
  ) {
    throw new Error("Pointer events do not match the source video dimensions");
  }
  if (Math.abs(describedSource.durationMs - source.durationMs) > 1_000) {
    throw new Error("Pointer events do not match the source video duration");
  }

  const content: PixelRect = trackContentRect(track) ??
    analysis.contentRect ?? {
      x: 0,
      y: 0,
      width: source.width,
      height: source.height,
    };
  const geometry = new CameraGeometry(source, content);
  const samples = samplesFromTrack(track);
  const trail = smoothedTrail(samples, source);
  const bursts = trackTypingBursts(track);
  const clicks = clickTargets(track, source, content);
  const shots = groupShots(clicks, bursts, source.durationMs);
  for (const shot of shots) {
    shot.baseZoom = geometry.fitZoom(shot.clicks);
    shot.keys = planKeys(shot, geometry, trail, bursts, analysis.reactions);
    const firstKey = shot.keys[0];
    if (firstKey) {
      shot.startMs = Math.max(0, Math.min(shot.startMs, firstKey.startMs));
    }
  }

  // The one thing that must not happen is a click outside the frame. Check
  // every click against the simulated camera and start a late move earlier
  // until its click sits comfortably inside.
  for (let round = 0; round < MAX_REPAIR_ROUNDS; round += 1) {
    const frames = simulate(shots, geometry, source);
    let repaired = false;
    for (const shot of shots) {
      for (const key of shot.keys) {
        if (
          key.click &&
          !clickInFrame(frames, key.click, source, CLICK_MARGIN)
        ) {
          key.startMs -= 100;
          shot.startMs = Math.max(0, Math.min(shot.startMs, key.startMs));
          repaired = true;
        }
      }
    }
    if (!repaired) {
      break;
    }
  }

  return cameraPlanSchema.parse({
    version: 2,
    algorithm: "click-camera-v2",
    source,
    content,
    shots: toPlanShots(shots),
    clicks: clicks.map((click) => {
      const reaction = analysis.reactions.get(click.tMs);
      return {
        tMs: click.tMs,
        x: Math.round(click.x * 1_000) / 1_000,
        y: Math.round(click.y * 1_000) / 1_000,
        ...(click.elementRole ? { elementRole: click.elementRole } : {}),
        ...(reaction === undefined
          ? {}
          : { reaction: Math.round(reaction * 1_000) / 1_000 }),
      };
    }),
  });
}

export interface PlanClickVerification {
  readonly tMs: number;
  readonly inFrame: boolean;
}

/**
 * Every click of the plan checked against the camera the plan describes, as it
 * will be rendered. Run on the plan being rendered rather than on the one that
 * was generated, so an edited plan is judged on its edits.
 */
export function verifyPlanClicks(
  plan: CameraPlan,
): readonly PlanClickVerification[] {
  const frames = createCameraFrameStates(plan);
  return plan.clicks.map((click) => {
    return {
      tMs: click.tMs,
      inFrame: clickInFrame(
        frames,
        {
          tMs: click.tMs,
          x: click.x,
          y: click.y,
          element: null,
          elementRole: null,
        },
        plan.source,
        CLICK_MARGIN,
      ),
    };
  });
}

export function createCameraFrameStates(
  plan: CameraPlan,
): readonly CameraFrameState[] {
  const geometry = new CameraGeometry(plan.source, plan.content);
  return simulate(fromPlanShots(plan), geometry, plan.source);
}

function commandNumber(value: number): string {
  const rounded = Math.abs(value) < 0.000_000_5 ? 0 : value;
  return rounded.toFixed(6);
}

export function createFfmpegCameraCommands(plan: CameraPlan): string {
  const commands = createCameraFrameStates(plan).map((frame) => {
    return `${commandNumber(frame.timeMs / 1_000)} crop@camera w ${commandNumber(
      frame.cropWidth,
    )}, crop@camera h ${commandNumber(frame.cropHeight)}, crop@camera x ${commandNumber(
      frame.cropX,
    )}, crop@camera y ${commandNumber(frame.cropY)};`;
  });
  return `${commands.join("\n")}\n`;
}
