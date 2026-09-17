import type { IntroVideoStyle } from "@okouai/api-contracts/contracts/intro-video-presenter";
import { cn } from "@okouai/ui";
import { Check, LayoutTemplate, Play } from "lucide-react";
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
 * chip says "this is a video" and toggles the preview. Everything else — the
 * hover scrim, the Use pill, the selected ring and badge — comes from the
 * shared tile chrome, so this wall matches the presentation, illustration and
 * creative video walls.
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
            className="absolute bottom-2 left-2 z-20 grid h-[18px] w-[18px] cursor-pointer place-items-center rounded-md bg-black/45 text-white backdrop-blur-[2px] transition-colors hover:bg-black/70 group-hover/tile:bg-black/60"
          >
            <Play size={9} fill="currentColor" />
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
              return $.artifacts.templates.use;
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
