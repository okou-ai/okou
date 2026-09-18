import type { UIEvent as ReactUIEvent } from "react";
import type { ArtifactCatalogKind } from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  AlertTriangle,
  ChevronRight,
  File,
  Image,
  Presentation,
  MessagesSquare,
  User,
  Video,
  Globe,
} from "lucide-react";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useLoadable,
  useSet,
} from "ccstate-react";
import { surfaceVariants, cn } from "@okouai/ui";
import { Alert, AlertDescription } from "@okouai/ui/components/ui/alert";
import { useTranslation } from "react-i18next";

import {
  artifactCatalog$,
  loadMoreArtifactCatalog$,
  openArtifact$,
  scrollArtifactCardIntoViewRef$,
  selectedArtifactCatalogKind$,
  setArtifactCatalogKind$,
} from "../../signals/artifacts-page/artifact-catalog-signals.ts";
import type { CatalogArtifact } from "../../signals/artifacts-page/create-artifact-catalog-signals.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ArtifactThumbnailImage } from "../okou-page/artifact-thumbnail.tsx";
import { emptyArtifactImg } from "../okou-page/platform-assets.ts";
import {
  FilePreviewIcon,
  getFilePreviewAccentClass,
} from "../okou-page/file-preview-icon.tsx";

// Distance from the bottom of the scroll container at which the next page is
// requested. The signal layer deduplicates repeated requests for one cursor.
const ARTIFACT_AUTO_LOAD_VIEWPORT_COUNT = 2;
const ARTIFACT_GRID_MIN_CARD_WIDTH_PX = 292;

const ARTIFACT_KIND_OPTIONS: readonly ArtifactCatalogKind[] = [
  "presentation",
  "hosted-site",
  "image",
  "video",
  "avatar",
  "shared-thread",
  "file",
];

function ArtifactKindIcon({ kind }: { readonly kind: ArtifactCatalogKind }) {
  const { t } = useTranslation();
  const icon =
    kind === "presentation" ? (
      <Presentation size={16} />
    ) : kind === "hosted-site" ? (
      <Globe size={16} />
    ) : kind === "image" ? (
      <Image size={16} />
    ) : kind === "video" ? (
      <Video size={16} />
    ) : kind === "avatar" ? (
      <User size={16} />
    ) : kind === "shared-thread" ? (
      <MessagesSquare size={16} />
    ) : (
      <File size={16} />
    );
  const kindLabel =
    kind === "presentation"
      ? t(($) => {
          return $.artifacts.kinds.presentation;
        })
      : kind === "hosted-site"
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

  return (
    <span
      aria-label={t(
        ($) => {
          return $.artifacts.catalog.kindIcon;
        },
        { kind: kindLabel },
      )}
      data-testid={`artifact-catalog-kind-icon-${kind}`}
      className="pointer-events-none absolute left-3 top-3 z-10 inline-flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white shadow-sm ring-1 ring-white/15"
    >
      {icon}
    </span>
  );
}

function ArtifactCatalogFallbackPreview({
  artifact,
}: {
  readonly artifact: CatalogArtifact;
}) {
  return (
    <div
      className={cn(
        "relative flex h-full w-full items-center justify-center overflow-hidden bg-gradient-to-br p-6",
        getFilePreviewAccentClass(artifact.title),
      )}
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.45),transparent_55%)] dark:bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.08),transparent_55%)]" />
      <div className="absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-black/10 to-transparent" />
      <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-foreground/10 bg-background/90 shadow-sm transition-transform duration-200 group-hover:scale-105">
        <FilePreviewIcon
          filename={artifact.title}
          testId="artifact-catalog-file-preview-icon"
        />
      </div>
    </div>
  );
}

function ArtifactCatalogVideoPreview({
  artifact,
}: {
  artifact: CatalogArtifact;
}) {
  const resourceUrl = useLastResolved(artifact.videoUrl$);
  return (
    <video
      src={resourceUrl ? `${resourceUrl}#t=0.001` : undefined}
      preload="metadata"
      muted
      playsInline
      aria-hidden="true"
      data-testid="artifact-catalog-video-source"
      className="h-full w-full object-contain"
    />
  );
}

function ArtifactCatalogCard({
  artifact,
  onOpen,
  scrollIntoView,
}: {
  readonly artifact: CatalogArtifact;
  readonly onOpen: (artifactId: string) => void;
  readonly scrollIntoView: boolean;
}) {
  const { t } = useTranslation();
  const scrollArtifactCardIntoViewRef = useSet(scrollArtifactCardIntoViewRef$);
  const thumbnailLoadable = useLastLoadable(artifact.thumbnailUrl$);
  const thumbnailUrl =
    thumbnailLoadable.state === "hasData" ? thumbnailLoadable.data : null;
  const thumbnailPending =
    artifact.thumbnail !== null && thumbnailLoadable.state === "loading";
  const sourceVideo =
    artifact.videoSourceUrl && !thumbnailPending ? (
      <ArtifactCatalogVideoPreview artifact={artifact} />
    ) : null;
  const fallbackPreview =
    sourceVideo ??
    (artifact.kind === "file" ? (
      <ArtifactCatalogFallbackPreview artifact={artifact} />
    ) : (
      <div className="flex h-full w-full items-center justify-center bg-muted/30" />
    ));
  return (
    <article
      ref={scrollIntoView ? scrollArtifactCardIntoViewRef : undefined}
      role="button"
      tabIndex={0}
      data-artifact-id={artifact.id}
      aria-label={t(
        ($) => {
          return $.artifacts.catalog.cardPreview;
        },
        {
          title: artifact.title,
        },
      )}
      onClick={() => {
        onOpen(artifact.id);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") {
          return;
        }
        event.preventDefault();
        onOpen(artifact.id);
      }}
      className="group flex cursor-pointer flex-col overflow-hidden rounded-lg border border-border bg-card outline-none transition-colors hover:border-foreground/20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <div
        data-testid="artifact-catalog-card-preview"
        className="relative aspect-[16/10] w-full shrink-0 overflow-hidden bg-background"
      >
        {thumbnailUrl ? (
          <ArtifactThumbnailImage
            src={thumbnailUrl}
            load={artifact.thumbnailLoad}
            className="h-full w-full object-cover"
            fallback={
              sourceVideo ?? (
                <ArtifactCatalogFallbackPreview artifact={artifact} />
              )
            }
            testId="artifact-catalog-thumbnail"
          />
        ) : (
          fallbackPreview
        )}
        <ArtifactKindIcon kind={artifact.kind} />
      </div>
      <div className="flex min-w-0 shrink-0 items-center border-t border-border p-3">
        <h2
          title={artifact.title}
          className="min-w-0 truncate text-sm font-semibold leading-5 text-foreground"
        >
          {artifact.title}
        </h2>
      </div>
    </article>
  );
}

function ArtifactSharedConversationList({
  artifacts,
  onOpen,
  scrollToArtifactId,
}: {
  readonly artifacts: readonly CatalogArtifact[];
  readonly onOpen: (artifactId: string) => void;
  readonly scrollToArtifactId: string | null;
}) {
  const { t } = useTranslation();
  const scrollArtifactCardIntoViewRef = useSet(scrollArtifactCardIntoViewRef$);
  return (
    <ul
      className={surfaceVariants({
        className: "divide-y divide-border overflow-hidden",
      })}
    >
      {artifacts.map((artifact) => {
        return (
          <li key={artifact.id}>
            <button
              ref={
                artifact.id === scrollToArtifactId
                  ? scrollArtifactCardIntoViewRef
                  : undefined
              }
              type="button"
              data-artifact-id={artifact.id}
              aria-label={t(
                ($) => {
                  return $.artifacts.catalog.cardPreview;
                },
                { title: artifact.title },
              )}
              onClick={() => {
                onOpen(artifact.id);
              }}
              className="group flex w-full items-center gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-state-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gray-50 text-muted-foreground transition-colors group-hover:text-foreground">
                <MessagesSquare size={16} aria-hidden />
              </span>
              <span
                title={artifact.title}
                className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
              >
                {artifact.title}
              </span>
              <ChevronRight
                size={16}
                aria-hidden
                className="shrink-0 transition-colors group-hover:text-foreground"
              />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function ArtifactCatalogGrid({
  artifacts,
  onOpen,
  scrollToArtifactId = null,
}: {
  readonly artifacts: readonly CatalogArtifact[];
  readonly onOpen: (artifactId: string) => void;
  readonly scrollToArtifactId?: string | null;
}) {
  return (
    <div
      data-testid="artifact-catalog-grid"
      className="grid gap-3"
      style={{
        gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${String(ARTIFACT_GRID_MIN_CARD_WIDTH_PX)}px), 1fr))`,
      }}
    >
      {artifacts.map((artifact) => {
        return (
          <ArtifactCatalogCard
            key={artifact.id}
            artifact={artifact}
            onOpen={onOpen}
            scrollIntoView={artifact.id === scrollToArtifactId}
          />
        );
      })}
    </div>
  );
}

export function ArtifactCatalogSkeleton({
  layout = "grid",
}: {
  readonly layout?: "grid" | "list";
} = {}) {
  const { t } = useTranslation();
  const loadingLabel = t(($) => {
    return $.artifacts.catalog.loading;
  });
  if (layout === "list") {
    return (
      <div
        className={surfaceVariants({
          className: "divide-y divide-border overflow-hidden",
        })}
        aria-label={loadingLabel}
      >
        {Array.from({ length: 8 }, (_, index) => {
          return (
            <div key={index} className="flex items-center gap-3 px-4 py-3">
              <div className="size-8 shrink-0 rounded-lg bg-gray-50" />
              <div className="h-4 w-2/3 rounded bg-muted/60" />
            </div>
          );
        })}
      </div>
    );
  }
  return (
    <div
      className="grid gap-3"
      aria-label={loadingLabel}
      style={{
        gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${String(ARTIFACT_GRID_MIN_CARD_WIDTH_PX)}px), 1fr))`,
      }}
    >
      {Array.from({ length: 8 }, (_, index) => {
        return (
          <div
            key={index}
            className="flex flex-col overflow-hidden rounded-lg border border-border bg-card"
          >
            <div className="aspect-[16/10] w-full shrink-0 bg-muted/30" />
            <div className="flex shrink-0 items-center border-t border-border p-3">
              <div className="h-5 w-3/4 rounded bg-muted/60" />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ArtifactCatalogError() {
  const { t } = useTranslation();
  return (
    <Alert variant="destructive">
      <AlertTriangle size={16} aria-hidden />
      <AlertDescription>
        {t(($) => {
          return $.artifacts.catalog.error;
        })}
      </AlertDescription>
    </Alert>
  );
}

export function ArtifactCatalogEmpty() {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border border-dashed border-border bg-card px-6 py-12 text-center">
      <img
        src={emptyArtifactImg}
        alt=""
        role="presentation"
        loading="lazy"
        className="mx-auto h-24 w-24 object-contain opacity-80"
      />
      <h2 className="mt-4 text-sm font-medium text-foreground">
        {t(($) => {
          return $.artifacts.catalog.emptyTitle;
        })}
      </h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
        {t(($) => {
          return $.artifacts.catalog.emptyDescription;
        })}
      </p>
    </div>
  );
}

function ArtifactCatalogKindFilter({
  selectedKind,
  onKindChange,
}: {
  readonly selectedKind: ArtifactCatalogKind | null;
  readonly onKindChange: (value: ArtifactCatalogKind | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      aria-label={t(($) => {
        return $.artifacts.catalog.filters.label;
      })}
    >
      {ARTIFACT_KIND_OPTIONS.map((kind) => {
        const selected = kind === selectedKind;
        const label =
          kind === "presentation"
            ? t(($) => {
                return $.artifacts.catalog.filters.presentation;
              })
            : kind === "hosted-site"
              ? t(($) => {
                  return $.artifacts.catalog.filters.website;
                })
              : kind === "image"
                ? t(($) => {
                    return $.artifacts.catalog.filters.image;
                  })
                : kind === "video"
                  ? t(($) => {
                      return $.artifacts.catalog.filters.video;
                    })
                  : kind === "avatar"
                    ? t(($) => {
                        return $.artifacts.catalog.filters.avatar;
                      })
                    : kind === "shared-thread"
                      ? t(($) => {
                          return $.artifacts.catalog.filters.sharedConversation;
                        })
                      : t(($) => {
                          return $.artifacts.catalog.filters.file;
                        });
        const ariaLabel =
          kind === "presentation"
            ? t(($) => {
                return $.artifacts.catalog.filters.presentationAria;
              })
            : kind === "hosted-site"
              ? t(($) => {
                  return $.artifacts.catalog.filters.websiteAria;
                })
              : kind === "image"
                ? t(($) => {
                    return $.artifacts.catalog.filters.imageAria;
                  })
                : kind === "video"
                  ? t(($) => {
                      return $.artifacts.catalog.filters.videoAria;
                    })
                  : kind === "avatar"
                    ? t(($) => {
                        return $.artifacts.catalog.filters.avatarAria;
                      })
                    : kind === "shared-thread"
                      ? t(($) => {
                          return $.artifacts.catalog.filters
                            .sharedConversationAria;
                        })
                      : t(($) => {
                          return $.artifacts.catalog.filters.fileAria;
                        });
        return (
          <button
            key={kind}
            type="button"
            aria-label={ariaLabel}
            aria-pressed={selected}
            onClick={() => {
              onKindChange(kind);
            }}
            className={cn(
              "inline-flex h-7 shrink-0 cursor-pointer items-center rounded-md border border-border px-2.5 text-sm font-medium leading-none transition-colors",
              selected
                ? "bg-muted text-foreground"
                : "bg-background text-muted-foreground hover:bg-state-hover hover:text-foreground",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

export function ArtifactCatalogPage({
  scrollToArtifactId,
}: {
  readonly scrollToArtifactId: string | null;
}) {
  const { t } = useTranslation();
  const selectedKind = useGet(selectedArtifactCatalogKind$);
  const setKind = useSet(setArtifactCatalogKind$);
  const openArtifact = useSet(openArtifact$);
  const loadMore = useSet(loadMoreArtifactCatalog$);
  const pageSignal = useGet(pageSignal$);
  const catalog = useLoadable(artifactCatalog$);
  const artifacts = catalog.state === "hasData" ? catalog.data.artifacts : [];
  const sharedConversationLayout = selectedKind === "shared-thread";
  const hasMore =
    catalog.state === "hasData" && catalog.data.nextCursor !== null;
  const handleScroll = (event: ReactUIEvent<HTMLElement>) => {
    if (!hasMore) {
      return;
    }
    const viewport = event.currentTarget;
    const distanceFromBottom =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    const autoLoadThreshold =
      viewport.clientHeight * ARTIFACT_AUTO_LOAD_VIEWPORT_COUNT;
    if (distanceFromBottom > autoLoadThreshold) {
      return;
    }
    detach(loadMore(pageSignal), Reason.DomCallback, "artifact catalog paging");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The header sits outside the scroll container so the kind filter stays
          pinned to the top while the catalog scrolls under it. */}
      <header className="shrink-0 bg-transparent px-4 pb-3 pt-3 sm:px-6 md:pt-10">
        <div className="mx-auto flex w-full max-w-[900px] flex-col gap-3">
          <div className="hidden min-w-0 md:block">
            <h1 className="text-lg font-semibold tracking-tight text-foreground">
              {t(($) => {
                return $.artifacts.title;
              })}
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {t(($) => {
                return $.artifacts.catalog.description;
              })}
            </p>
          </div>
          <ArtifactCatalogKindFilter
            selectedKind={selectedKind}
            onKindChange={setKind}
          />
        </div>
      </header>

      <main
        onScroll={handleScroll}
        className="flex-1 overflow-auto px-4 pb-[max(2rem,var(--sab))] pt-1 sm:px-6 [scrollbar-gutter:stable]"
      >
        <div className="mx-auto flex w-full max-w-[900px] flex-col gap-4">
          {catalog.state === "loading" ? (
            <ArtifactCatalogSkeleton
              layout={sharedConversationLayout ? "list" : "grid"}
            />
          ) : catalog.state === "hasError" ? (
            <ArtifactCatalogError />
          ) : artifacts.length === 0 ? (
            <ArtifactCatalogEmpty />
          ) : sharedConversationLayout ? (
            <ArtifactSharedConversationList
              artifacts={artifacts}
              scrollToArtifactId={scrollToArtifactId}
              onOpen={(artifactId) => {
                detach(
                  openArtifact(artifactId, pageSignal),
                  Reason.DomCallback,
                  "artifact catalog open",
                );
              }}
            />
          ) : (
            <ArtifactCatalogGrid
              artifacts={artifacts}
              scrollToArtifactId={scrollToArtifactId}
              onOpen={(artifactId) => {
                detach(
                  openArtifact(artifactId, pageSignal),
                  Reason.DomCallback,
                  "artifact catalog open",
                );
              }}
            />
          )}
        </div>
      </main>
    </div>
  );
}
