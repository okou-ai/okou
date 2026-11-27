import type { ReactNode } from "react";
import type { ArtifactCatalogKind } from "@okouai/api-contracts/contracts/artifact-catalog";
import { useGet, useLastLoadable } from "ccstate-react";
import {
  File,
  FileText,
  Globe,
  Image,
  MessagesSquare,
  Music,
  Presentation,
  Table2,
  User,
  Video,
} from "lucide-react";
import { cn } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import type { CatalogArtifact } from "../../signals/artifacts-page/create-artifact-catalog-signals.ts";
import type { ArtifactKind } from "../../signals/chat-page/artifact-card-signals.ts";
import { classifyChatAttachment } from "../../signals/chat-page/parse-body-blocks.ts";
import { ArtifactThumbnailImage } from "../okou-page/artifact-thumbnail.tsx";
import {
  FilePreviewIcon,
  getFilePreviewAccentClass,
} from "../okou-page/file-preview-icon.tsx";
import { officeFilePreviewKind } from "../okou-page/office-file-preview.ts";

export type ArtifactCatalogAppearance = "card" | "gallery";
type ArtifactDisplayKind =
  ArtifactCatalogKind | ArtifactKind | "document" | "spreadsheet";

export function artifactGalleryKind(
  artifact: CatalogArtifact,
): ArtifactDisplayKind {
  return artifact.kind === "file"
    ? (officeFilePreviewKind(artifact.title) ??
        classifyChatAttachment({ filename: artifact.title }))
    : artifact.kind;
}

export function artifactKindIcon(
  kind: ArtifactDisplayKind,
  size: number,
): ReactNode {
  return kind === "presentation" ? (
    <Presentation size={size} />
  ) : kind === "hosted-site" || kind === "html" ? (
    <Globe size={size} />
  ) : kind === "image" ? (
    <Image size={size} />
  ) : kind === "video" ? (
    <Video size={size} />
  ) : kind === "avatar" ? (
    <User size={size} />
  ) : kind === "shared-thread" ? (
    <MessagesSquare size={size} />
  ) : kind === "audio" ? (
    <Music size={size} />
  ) : kind === "csv" || kind === "json" || kind === "spreadsheet" ? (
    <Table2 size={size} />
  ) : kind === "document" ||
    kind === "markdown" ||
    kind === "pdf" ||
    kind === "text" ? (
    <FileText size={size} />
  ) : (
    <File size={size} />
  );
}

export function useArtifactKindLabel(kind: ArtifactDisplayKind): string {
  const { t } = useTranslation();
  if (kind === "csv" || kind === "spreadsheet") {
    return t(($) => {
      return $.artifacts.kinds.spreadsheet;
    });
  }
  if (kind === "markdown") {
    return t(($) => {
      return $.artifacts.kinds.markdown;
    });
  }
  if (kind === "pdf" || kind === "document") {
    return t(($) => {
      return $.artifacts.kinds.document;
    });
  }
  if (kind === "text") {
    return t(($) => {
      return $.artifacts.kinds.text;
    });
  }
  if (kind === "json") {
    return t(($) => {
      return $.artifacts.kinds.data;
    });
  }
  if (kind === "audio") {
    return t(($) => {
      return $.artifacts.kinds.audio;
    });
  }
  return kind === "presentation"
    ? t(($) => {
        return $.artifacts.kinds.presentation;
      })
    : kind === "hosted-site" || kind === "html"
      ? t(($) => {
          return $.artifacts.kinds.hostedSite;
        })
      : kind === "image"
        ? t(($) => {
            return $.artifacts.kinds.image;
          })
        : kind === "video"
          ? t(($) => {
              return $.artifacts.kinds.video;
            })
          : kind === "avatar"
            ? t(($) => {
                return $.artifacts.kinds.avatar;
              })
            : kind === "shared-thread"
              ? t(($) => {
                  return $.artifacts.kinds.sharedConversation;
                })
              : t(($) => {
                  return $.artifacts.kinds.file;
                });
}

function useArtifactKindIconLabel(kind: ArtifactCatalogKind): string {
  const { t } = useTranslation();
  const kindLabel = useArtifactKindLabel(kind);
  return t(
    ($) => {
      return $.artifacts.catalog.kindIcon;
    },
    { kind: kindLabel },
  );
}

function ArtifactKindIcon({ kind }: { readonly kind: ArtifactCatalogKind }) {
  const label = useArtifactKindIconLabel(kind);
  return (
    <span
      role="img"
      aria-label={label}
      data-testid={`artifact-catalog-kind-icon-${kind}`}
      className="pointer-events-none absolute left-3 top-3 z-10 inline-flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white shadow-sm ring-1 ring-white/15"
    >
      {artifactKindIcon(kind, 16)}
    </span>
  );
}

function ArtifactCatalogFallbackPreview({
  artifact,
  appearance,
}: {
  readonly artifact: CatalogArtifact;
  readonly appearance: ArtifactCatalogAppearance;
}) {
  const kindIconLabel = useArtifactKindIconLabel(artifact.kind);
  const showsFileFormat = artifact.kind === "file";
  return (
    <span
      className={cn(
        "relative flex h-full w-full items-center justify-center overflow-hidden p-6",
        appearance === "gallery"
          ? "bg-gray-50"
          : cn("bg-gradient-to-br", getFilePreviewAccentClass(artifact.title)),
      )}
    >
      {appearance === "card" && (
        <>
          <span className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.45),transparent_55%)] dark:bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.08),transparent_55%)]" />
          <span className="absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-black/10 to-transparent" />
        </>
      )}
      <span
        role={showsFileFormat ? undefined : "img"}
        aria-label={showsFileFormat ? undefined : kindIconLabel}
        data-testid={
          showsFileFormat
            ? undefined
            : `artifact-catalog-kind-cover-${artifact.kind}`
        }
        className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-foreground/10 bg-background/90 text-muted-foreground shadow-sm transition-transform duration-200 group-hover:scale-105"
      >
        {showsFileFormat ? (
          <FilePreviewIcon
            filename={artifact.title}
            testId="artifact-catalog-file-preview-icon"
          />
        ) : (
          artifactKindIcon(artifact.kind, 30)
        )}
      </span>
    </span>
  );
}

/** Reuse the catalog's producer-owned thumbnail and broken-image state. */
export function ArtifactCatalogCover({
  artifact,
  appearance = "gallery",
}: {
  readonly artifact: CatalogArtifact;
  readonly appearance?: ArtifactCatalogAppearance;
}) {
  const gallery = appearance === "gallery";
  const thumbnailLoadable = useLastLoadable(artifact.thumbnailUrl$);
  const thumbnailUrl =
    thumbnailLoadable.state === "hasData" ? thumbnailLoadable.data : null;
  const fallbackPreview = (
    <ArtifactCatalogFallbackPreview
      artifact={artifact}
      appearance={appearance}
    />
  );
  const thumbnailFailed = useGet(artifact.thumbnailLoad.status$) === "error";
  const kindCoverShown =
    artifact.kind !== "file" && (thumbnailUrl === null || thumbnailFailed);
  return (
    <span
      data-testid="artifact-catalog-card-preview"
      className={cn(
        "relative block aspect-[16/10] w-full shrink-0 overflow-hidden",
        gallery
          ? "rounded-surface border border-border bg-gray-50 transition-colors group-hover:border-foreground/20"
          : "bg-background",
      )}
    >
      {thumbnailUrl ? (
        <ArtifactThumbnailImage
          src={thumbnailUrl}
          load={artifact.thumbnailLoad}
          className={cn(
            "h-full w-full",
            gallery ? "object-contain" : "object-cover",
          )}
          fallback={fallbackPreview}
          testId="artifact-catalog-thumbnail"
        />
      ) : (
        fallbackPreview
      )}
      {gallery || kindCoverShown ? null : (
        <ArtifactKindIcon kind={artifact.kind} />
      )}
    </span>
  );
}
