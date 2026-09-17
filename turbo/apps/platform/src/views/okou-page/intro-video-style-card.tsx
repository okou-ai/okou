import type { IntroVideoStyle } from "@okouai/api-contracts/contracts/intro-video-presenter";
import { cn } from "@okouai/ui";
import { Check, LayoutTemplate, Play } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  markVideoPreviewPlaying,
  resetVideoPreview,
  startVideoPreview,
} from "./video-preview-hover.ts";

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
          className="h-full w-full object-contain"
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
            preload="none"
            playsInline
            muted
            loop
            aria-hidden="true"
            className="peer pointer-events-none absolute inset-0 h-full w-full object-contain opacity-0 data-[preview-playing=true]:opacity-100"
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
          <button
            type="button"
            aria-label={t(
              ($) => {
                return $.chat.introVideo.style.preview;
              },
              { title: style.name },
            )}
            onClick={(event) => {
              startVideoPreview(
                event.currentTarget.parentElement?.querySelector("video") ??
                  null,
              );
            }}
            className="absolute inset-0 grid place-items-center bg-black/10 text-white transition-colors hover:bg-black/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring peer-data-[preview-playing=true]:pointer-events-none peer-data-[preview-playing=true]:opacity-0"
          >
            <span className="grid size-11 place-items-center rounded-full bg-black/55">
              <Play size={20} fill="currentColor" />
            </span>
          </button>
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
    <div
      className={cn(
        "min-w-0 overflow-hidden rounded-xl border bg-card transition-colors hover:border-foreground/20",
        selected ? "border-primary" : "border-border",
      )}
    >
      <div
        className="relative aspect-video overflow-hidden bg-muted"
        onMouseEnter={(event) => {
          startVideoPreview(event.currentTarget.querySelector("video"));
        }}
        onMouseLeave={(event) => {
          resetVideoPreview(event.currentTarget.querySelector("video"));
        }}
      >
        <StylePreviewMedia style={style} />
      </div>
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
        className="flex min-h-12 w-full min-w-0 items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <strong className="min-w-0 flex-1 text-sm font-medium text-foreground">
          {style.name}
        </strong>
        {style.aspectRatio ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            {style.aspectRatio}
          </span>
        ) : null}
        {selected ? (
          <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
            <Check size={12} />
          </span>
        ) : null}
      </button>
    </div>
  );
}
