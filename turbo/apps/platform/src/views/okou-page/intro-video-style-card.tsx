import type { IntroVideoStyle } from "@okouai/api-contracts/contracts/intro-video-presenter";
import { cn } from "@okouai/ui";
import { Check, LayoutTemplate, LoaderCircle, Pause, Play } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  TEMPLATE_TILE_CAPTION,
  TEMPLATE_TILE_MEDIA,
  TEMPLATE_TILE_NAME,
  TEMPLATE_TILE_RING,
  TEMPLATE_TILE_RING_SELECTED,
  TEMPLATE_TILE_SCRIM,
  TEMPLATE_TILE_SELECTED_BADGE,
  TEMPLATE_TILE_USE,
  TEMPLATE_TILE_WRAPPER,
} from "./template-tile.ts";
import {
  markVideoPreviewPlaying,
  resetVideoPreview,
  startVideoPreview,
} from "./video-preview-hover.ts";

/**
 * The cover's only chrome is a chip in the bottom-left corner: the middle of
 * the artwork is what the user is reading, so nothing is drawn over it. The
 * chip is the preview's whole state in one 18px square — play at rest, a
 * spinner while the clip buffers, pause while it runs — and it grows to 22px
 * on hover, where it is the thing being aimed at. Everything else — the hover
 * scrim, the Use pill, the selected ring and badge — comes from the shared
 * tile chrome, so this wall matches the presentation, illustration and
 * creative video walls.
 *
 * The chip states no duration: the styles catalog does not return one, and a
 * number invented from nothing is worse than no number.
 */
function StylePreviewMedia({ style }: { readonly style: IntroVideoStyle }) {
  const { t } = useTranslation();
  return (
    <>
      {style.thumbnailUrl ? (
        <img
          src={style.thumbnailUrl}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
        />
      ) : (
        <span className="grid h-full place-items-center text-muted-foreground">
          <LayoutTemplate size={28} />
        </span>
      )}
      {style.previewVideoUrl ? (
        <>
          <video
            src={style.previewVideoUrl}
            poster={style.thumbnailUrl ?? undefined}
            preload="none"
            playsInline
            muted
            loop
            aria-hidden="true"
            className="peer pointer-events-none absolute inset-0 h-full w-full object-cover opacity-0 data-[preview-playing=true]:opacity-100"
            onPlaying={(event) => {
              markVideoPreviewPlaying(event.currentTarget, true);
            }}
            onPause={(event) => {
              markVideoPreviewPlaying(event.currentTarget, false);
            }}
            onError={(event) => {
              markVideoPreviewPlaying(event.currentTarget, false);
            }}
          />
          <span
            role="button"
            tabIndex={-1}
            aria-label={t(
              ($) => {
                return $.chat.introVideo.style.preview;
              },
              { title: style.name },
            )}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const video =
                event.currentTarget.parentElement?.querySelector("video") ??
                null;
              if (video && !video.paused) {
                resetVideoPreview(video);
                return;
              }
              startVideoPreview(video);
            }}
            className={cn(
              "absolute bottom-2 left-2 z-20 grid size-[18px] cursor-pointer place-items-center rounded-md bg-black/45 text-white backdrop-blur-[2px] transition-all hover:bg-black/70 group-hover/tile:size-[22px] group-hover/tile:bg-black/60 group-focus-visible/tile:size-[22px]",
              // The video is this chip's `peer`, so its own state picks the
              // glyph. React state would need this component to own playback,
              // which the shared hover helpers own instead.
              "peer-data-[preview-playing=true]:[&_[data-glyph=play]]:hidden peer-data-[preview-playing=true]:[&_[data-glyph=pause]]:block",
              "peer-data-[preview-buffering=true]:[&_[data-glyph=play]]:hidden peer-data-[preview-buffering=true]:[&_[data-glyph=spinner]]:block",
            )}
          >
            <Play
              data-glyph="play"
              size={9}
              fill="currentColor"
              className="col-start-1 row-start-1"
            />
            <Pause
              data-glyph="pause"
              size={9}
              fill="currentColor"
              className="col-start-1 row-start-1 hidden"
            />
            <LoaderCircle
              data-glyph="spinner"
              size={11}
              className="col-start-1 row-start-1 hidden animate-spin"
            />
          </span>
        </>
      ) : null}
    </>
  );
}

export function IntroVideoStyleCard({
  style,
  selected,
  onSelect,
}: {
  readonly style: IntroVideoStyle;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={TEMPLATE_TILE_WRAPPER}>
      <button
        type="button"
        aria-label={t(
          ($) => {
            return $.artifacts.templates.selectStyle;
          },
          { style: style.name },
        )}
        aria-pressed={selected}
        onClick={onSelect}
        className="block w-full min-w-0 text-left focus-visible:outline-none"
      >
        <div
          className={cn(
            TEMPLATE_TILE_MEDIA,
            TEMPLATE_TILE_RING,
            "aspect-video group-focus-visible/tile:ring-1 group-focus-visible/tile:ring-ring",
            selected && TEMPLATE_TILE_RING_SELECTED,
          )}
          onMouseEnter={(event) => {
            startVideoPreview(event.currentTarget.querySelector("video"));
          }}
          onMouseLeave={(event) => {
            resetVideoPreview(event.currentTarget.querySelector("video"));
          }}
        >
          <StylePreviewMedia style={style} />
          <div className={TEMPLATE_TILE_SCRIM} />
          {selected ? (
            <span className={TEMPLATE_TILE_SELECTED_BADGE}>
              <Check size={14} />
            </span>
          ) : null}
          <span className={cn(TEMPLATE_TILE_USE, "grid place-items-center")}>
            {t(($) => {
              return selected
                ? $.artifacts.templates.selected
                : $.artifacts.templates.use;
            })}
          </span>
        </div>
        <div className={TEMPLATE_TILE_CAPTION}>
          <p className={TEMPLATE_TILE_NAME}>{style.name}</p>
        </div>
      </button>
    </div>
  );
}
