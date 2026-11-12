import {
  avatarTextureUrl,
  defaultAgentAvatarTextures,
} from "@okouai/core/agent-avatar-texture";
import { type SVGProps, useCallback, useId, useSyncExternalStore } from "react";
import { cn } from "../../lib/utils";
import {
  createOkouAvatarRig,
  OKOU_AVATAR_VIEW,
  type OkouAvatarMood,
  okouAvatarHeroTime,
} from "./okou-avatar-rig";
import { squirclePath } from "./squircle";

/**
 * The frame is laid out in a 40-unit square, the crop lab's design space.
 * The artwork overhangs it: 48 units wide, 4 left and 1.5 up, which puts the
 * bun just inside the top edge and cuts at the collar, as the iOS widget does.
 */
const FRAME = 40;
const ARTWORK = { x: -4, y: -1.5, size: 48 } as const;

/**
 * Corner radius 30% of the side with 60% smoothing. Fitted to the iOS widget
 * tiles, whose corner profile a plain 29.5% radius matches to a pixel; the
 * smoothing is Figma's iOS setting and leaves that profile intact.
 */
const FRAME_PATH = squirclePath(FRAME, FRAME, FRAME * 0.3, 0.6);

/** The brand tile drawn at 180%, centred, so two or three marks read per tile. */
const TEXTURE = { offset: -16, size: 72 } as const;

/**
 * The Okou avatar's own tile: the one brand texture that clears every colour
 * the figure is painted in, by the same rule every agent's texture follows.
 */
const TEXTURE_URL = avatarTextureUrl(defaultAgentAvatarTextures()[0]!);

// ---------- One animation clock for every animated avatar on the page ----------

type Tick = (now: number) => void;
const ticks = new Set<Tick>();
let frameRequest: number | null = null;
let lastDrawn = -Infinity;

/**
 * The moods are slow sways and blinks, so 30 frames a second reads as smooth
 * and halves the drawing cost when every avatar on a page is moving.
 */
const FRAME_INTERVAL_MS = 1000 / 30;

function runTicks(now: number): void {
  // A small tolerance keeps a 60Hz display on every other frame; a clock that
  // starts over (a new document) draws at once.
  if (now - lastDrawn >= FRAME_INTERVAL_MS - 2 || now < lastDrawn) {
    lastDrawn = now;
    for (const tick of ticks) {
      tick(now);
    }
  }
  frameRequest = ticks.size > 0 ? requestAnimationFrame(runTicks) : null;
}

function subscribeTick(tick: Tick): () => void {
  ticks.add(tick);
  frameRequest ??= requestAnimationFrame(runTicks);
  return () => {
    ticks.delete(tick);
    if (ticks.size === 0 && frameRequest !== null) {
      cancelAnimationFrame(frameRequest);
      frameRequest = null;
    }
  };
}

/**
 * Plays `draw` on the shared clock while `element` is on screen. An avatar
 * scrolled out of view stops drawing and resumes where it left off, so a
 * long transcript costs only the avatars a reader can see.
 */
function playWhileVisible(
  element: Element,
  draw: (elapsedSeconds: number) => void,
  dispose: () => void,
): () => void {
  let elapsed = 0;
  let previous: number | null = null;
  let stop: (() => void) | null = null;
  const play = () => {
    stop ??= subscribeTick((now) => {
      elapsed += previous === null ? 0 : (now - previous) / 1000;
      previous = now;
      draw(elapsed);
    });
  };
  const pause = () => {
    stop?.();
    stop = null;
    previous = null;
  };
  const observer =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => {
          if (
            entries.some((entry) => {
              return entry.isIntersecting;
            })
          ) {
            play();
          } else {
            pause();
          }
        })
      : null;
  if (observer) {
    observer.observe(element);
  } else {
    play();
  }
  return () => {
    observer?.disconnect();
    pause();
    dispose();
  };
}

// ---------- Reduced motion ----------

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function reducedMotionQuery(): MediaQueryList | null {
  return typeof window.matchMedia === "function"
    ? window.matchMedia(REDUCED_MOTION_QUERY)
    : null;
}

function subscribeReducedMotion(onChange: () => void): () => void {
  const query = reducedMotionQuery();
  query?.addEventListener("change", onChange);
  return () => {
    query?.removeEventListener("change", onChange);
  };
}

function prefersReducedMotion(): boolean {
  return reducedMotionQuery()?.matches ?? false;
}

function prefersReducedMotionOnServer(): boolean {
  return true;
}

// ---------- Component ----------

interface OkouAvatarProps extends Omit<
  SVGProps<SVGSVGElement>,
  "children" | "width" | "height" | "viewBox" | "role"
> {
  /**
   * Rendered size in px, which also sets the facial line weight. Omit it when
   * the caller sizes the avatar with classes; the avatar then reads its
   * rendered size once, when it mounts.
   */
  size?: number;
  /** One of the rig's moods. Defaults to `idle`. */
  mood?: OkouAvatarMood;
  /**
   * `animated` plays the mood; `static` holds its most readable frame, for
   * places that cannot or should not move. Reduced-motion users always get
   * the static frame.
   */
  motion?: "animated" | "static";
  /** Accessible name. Omit it when adjacent text already names Okou. */
  label?: string;
}

function OkouAvatar({
  size,
  mood = "idle",
  motion = "animated",
  label,
  className,
  ...rest
}: OkouAvatarProps) {
  // `useId` output contains characters that do not survive inside `url(#…)`.
  const clipId = `okou-avatar-${useId().replace(/[^\w-]/g, "")}`;
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    prefersReducedMotion,
    prefersReducedMotionOnServer,
  );
  const animated = motion === "animated" && !reducedMotion;

  // The rig is an imperative SVG drawing, so it mounts into its own group and
  // is rebuilt whenever what it draws changes.
  const mountArtwork = useCallback(
    (group: SVGGElement | null) => {
      if (!group) {
        return;
      }
      const rig = createOkouAvatarRig();
      rig.svg.setAttribute("x", String(ARTWORK.x));
      rig.svg.setAttribute("y", String(ARTWORK.y));
      rig.svg.setAttribute("width", String(ARTWORK.size));
      rig.svg.setAttribute("height", String(ARTWORK.size));
      group.append(rig.svg);
      const renderedSize =
        size ?? (group.ownerSVGElement?.getBoundingClientRect().width || FRAME);
      const pxPerUnit =
        (renderedSize / FRAME) * (ARTWORK.size / OKOU_AVATAR_VIEW);
      const hero = okouAvatarHeroTime(mood);
      rig.render({ mood, time: hero, pxPerUnit });
      if (!animated) {
        return () => {
          rig.svg.remove();
        };
      }
      return playWhileVisible(
        group.ownerSVGElement ?? group,
        (elapsed) => {
          rig.render({ mood, time: hero + elapsed, pxPerUnit });
        },
        () => {
          rig.svg.remove();
        },
      );
    },
    [mood, animated, size],
  );

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${FRAME} ${FRAME}`}
      fill="none"
      {...(label
        ? { role: "img", "aria-label": label }
        : { "aria-hidden": true })}
      data-okou-avatar={animated ? "animated" : "static"}
      className={cn("shrink-0", className)}
      {...rest}
    >
      <defs>
        <clipPath id={clipId}>
          <path d={FRAME_PATH} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        <image
          href={TEXTURE_URL}
          x={TEXTURE.offset}
          y={TEXTURE.offset}
          width={TEXTURE.size}
          height={TEXTURE.size}
          preserveAspectRatio="xMidYMid slice"
        />
        <g ref={mountArtwork} />
      </g>
    </svg>
  );
}

export { OkouAvatar, type OkouAvatarProps, type OkouAvatarMood };
