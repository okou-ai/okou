import type { FeatureGuideMedia } from "@okouai/api-contracts/contracts/feature-guides";
import { Expand } from "lucide-react";
import { useTranslation } from "react-i18next";

type ScreenshotMedia = Extract<FeatureGuideMedia, { type: "screenshots" }>;

function ScreenshotPanel({
  panel,
}: {
  readonly panel: ScreenshotMedia["before"];
}) {
  const { t } = useTranslation();
  return (
    <section aria-label={panel.label} className="min-w-0">
      <div className="mb-2 flex items-baseline gap-2 text-sm">
        <span className="shrink-0 font-medium">{panel.label}</span>
        <span className="min-w-0 text-muted-foreground">{panel.title}</span>
      </div>
      <a
        href={panel.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t(
          ($) => {
            return $.artifacts.attachments.openImagePreview;
          },
          { filename: panel.title },
        )}
        className="group relative block overflow-hidden rounded-xl border border-border bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <img
          src={panel.url}
          alt={panel.alt}
          width={panel.width}
          height={panel.height}
          className="h-auto w-full"
        />
        <span className="absolute right-2 top-2 rounded-md bg-background/90 p-1.5 text-muted-foreground group-hover:text-foreground">
          <Expand className="size-3.5" aria-hidden="true" />
        </span>
      </a>
    </section>
  );
}

export function FeatureGuideScreenshots({
  media,
}: {
  readonly media: ScreenshotMedia;
}) {
  return (
    <figure aria-label={media.label} className="flex flex-col gap-4">
      <ScreenshotPanel panel={media.before} />
      <ScreenshotPanel panel={media.after} />
      <p className="text-sm leading-relaxed text-muted-foreground">
        {media.note}
      </p>
      <figcaption className="text-xs text-muted-foreground">
        {media.caption}
      </figcaption>
    </figure>
  );
}
