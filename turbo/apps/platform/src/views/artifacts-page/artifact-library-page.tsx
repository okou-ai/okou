import type { KeyboardEvent, UIEvent } from "react";
import type {
  ArtifactCatalogKind,
  ArtifactCatalogSort,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  File,
  Globe,
  Image,
  Loader2,
  MessagesSquare,
  Presentation,
  Search,
  User,
  Video,
  X,
} from "lucide-react";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@okouai/ui";
import { useTranslation } from "react-i18next";

import {
  formatRelativeTimestamp,
  resolvedAppLocale,
} from "../../i18n/format.ts";
import { artifactCatalogViewportRef$ } from "../../signals/artifact-deletion.ts";
import { artifactCatalogSidebar } from "../../signals/artifacts-page/artifact-catalog-instance.ts";
import {
  artifactCatalog$,
  artifactCatalogPagingState$,
  artifactCatalogSearch$,
  artifactCatalogSort$,
  loadMoreArtifactCatalog$,
  openArtifact$,
  reloadArtifactCatalog$,
  rememberArtifactCatalogTrigger$,
  scrollArtifactCardIntoViewRef$,
  selectedArtifactCatalogKind$,
  setArtifactCatalogKind$,
  setArtifactCatalogSearch$,
  setArtifactCatalogSort$,
} from "../../signals/artifacts-page/artifact-catalog-signals.ts";
import type { CatalogArtifact } from "../../signals/artifacts-page/create-artifact-catalog-signals.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ChatThreadSidebarShell } from "../okou-page/chat-thread-sidebar-shell.tsx";
import { FilePreviewIcon } from "../okou-page/file-preview-icon.tsx";
import {
  ArtifactCatalogRowActions,
  ArtifactCatalogRowDeleteDialog,
} from "./artifact-catalog-row-actions.tsx";
import { ArtifactCatalogSidebar } from "./artifact-catalog-sidebar.tsx";

const KIND_ICONS = Object.freeze({
  file: File,
  presentation: Presentation,
  "hosted-site": Globe,
  image: Image,
  video: Video,
  avatar: User,
  "shared-thread": MessagesSquare,
});

function useKindOptions() {
  const { t } = useTranslation();
  return [
    {
      value: "presentation",
      label: t(($) => {
        return $.artifacts.kinds.presentation;
      }),
    },
    {
      value: "hosted-site",
      label: t(($) => {
        return $.artifacts.kinds.hostedSite;
      }),
    },
    {
      value: "image",
      label: t(($) => {
        return $.artifacts.kinds.image;
      }),
    },
    {
      value: "video",
      label: t(($) => {
        return $.artifacts.kinds.video;
      }),
    },
    {
      value: "avatar",
      label: t(($) => {
        return $.artifacts.kinds.avatar;
      }),
    },
    {
      value: "shared-thread",
      label: t(($) => {
        return $.artifacts.kinds.sharedConversation;
      }),
    },
    {
      value: "file",
      label: t(($) => {
        return $.artifacts.kinds.file;
      }),
    },
  ] satisfies { value: ArtifactCatalogKind; label: string }[];
}

function ArtifactTimestamp({ value }: { readonly value?: string | null }) {
  if (!value) {
    return <span className="text-muted-foreground">—</span>;
  }
  const exact = new Date(value).toLocaleString(resolvedAppLocale(), {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
  return (
    <Tooltip>
      <TooltipTrigger render={<time dateTime={value} title={exact} />}>
        {formatRelativeTimestamp(value)}
      </TooltipTrigger>
      <TooltipContent>{exact}</TooltipContent>
    </Tooltip>
  );
}

function SortHeading({
  field,
  label,
  className,
}: {
  readonly field: ArtifactCatalogSort;
  readonly label: string;
  readonly className?: string;
}) {
  const order = useGet(artifactCatalogSort$);
  const setSort = useSet(setArtifactCatalogSort$);
  const active = order.sort === field;
  const Icon = active
    ? order.direction === "asc"
      ? ArrowUp
      : ArrowDown
    : ArrowUpDown;
  return (
    <TableHead
      aria-sort={
        active
          ? order.direction === "asc"
            ? "ascending"
            : "descending"
          : "none"
      }
      className={cn("px-4 text-xs text-muted-foreground", className)}
    >
      <button
        type="button"
        className="inline-flex min-h-10 items-center gap-1.5 rounded-sm text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => {
          setSort(
            field,
            active
              ? order.direction === "asc"
                ? "desc"
                : "asc"
              : field === "title"
                ? "asc"
                : "desc",
          );
        }}
      >
        {label}
        <Icon
          className={cn("size-3.5", !active && "opacity-40")}
          aria-hidden="true"
        />
      </button>
    </TableHead>
  );
}

function moveRowFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
    return;
  }
  const targets = event.currentTarget
    .closest("table")
    ?.querySelectorAll<HTMLElement>("[data-artifact-open]");
  if (!targets) {
    return;
  }
  const rows = Array.from(targets);
  const next =
    rows[
      rows.indexOf(event.currentTarget) + (event.key === "ArrowDown" ? 1 : -1)
    ];
  if (next) {
    // Row navigation owns these arrows; Enter and Space remain native controls.
    event.preventDefault();
    next.focus();
  }
}

function ArtifactLibraryName({
  artifact,
  kindLabel,
}: {
  readonly artifact: CatalogArtifact;
  readonly kindLabel: string;
}) {
  const { t } = useTranslation();
  const Icon = KIND_ICONS[artifact.kind];
  return (
    <>
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50 text-muted-foreground"
      >
        {artifact.kind === "file" ? (
          <FilePreviewIcon filename={artifact.title} size="sm" />
        ) : (
          <Icon size={18} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {artifact.title}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground @3xl:hidden">
          <span>{kindLabel}</span>
          <span>
            {t(($) => {
              return $.artifacts.library.created;
            })}
            {": "}
            <ArtifactTimestamp value={artifact.createdAt} />
          </span>
        </span>
      </span>
    </>
  );
}

function ArtifactLibraryRow({
  artifact,
  selected,
  scrollIntoView,
}: {
  readonly artifact: CatalogArtifact;
  readonly selected: boolean;
  readonly scrollIntoView: boolean;
}) {
  const { t } = useTranslation();
  const openArtifact = useSet(openArtifact$);
  const signal = useGet(pageSignal$);
  const openPreview = () => {
    detach(
      openArtifact(artifact.id, signal),
      Reason.DomCallback,
      "open library artifact",
    );
  };
  const rememberTrigger = useSet(rememberArtifactCatalogTrigger$);
  const scrollTargetRef = useSet(scrollArtifactCardIntoViewRef$);
  const options = useKindOptions();
  const kindLabel = options.find((option) => {
    return option.value === artifact.kind;
  })!.label;
  const label = t(
    ($) => {
      return $.artifacts.catalog.cardPreview;
    },
    { title: artifact.title },
  );
  const content = (
    <ArtifactLibraryName artifact={artifact} kindLabel={kindLabel} />
  );
  const controlClassName =
    "flex min-w-0 w-full items-center gap-3 rounded-sm py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <TableRow
      ref={scrollIntoView ? scrollTargetRef : undefined}
      data-artifact-id={artifact.id}
      data-state={selected ? "selected" : undefined}
      className="cursor-default hover:bg-state-hover/60 data-[state=selected]:bg-state-selected"
      onClick={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest("button,a")
        ) {
          return;
        }
        const trigger = event.currentTarget.querySelector<HTMLElement>(
          "[data-artifact-open]",
        );
        if (artifact.kind === "shared-thread") {
          trigger?.click();
          return;
        }
        if (trigger) {
          rememberTrigger(trigger);
        }
        openPreview();
      }}
    >
      <TableCell className="px-4 py-0">
        {artifact.kind === "shared-thread" ? (
          <a
            href={`/share/threads/${encodeURIComponent(artifact.sharedThreadId)}`}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={label}
            data-artifact-open
            className={controlClassName}
            onKeyDown={moveRowFocus}
          >
            {content}
          </a>
        ) : (
          <button
            type="button"
            aria-label={label}
            aria-current={selected ? "true" : undefined}
            data-artifact-open
            className={controlClassName}
            onKeyDown={moveRowFocus}
            onClick={(event) => {
              rememberTrigger(event.currentTarget);
              openPreview();
            }}
          >
            {content}
          </button>
        )}
      </TableCell>
      <TableCell className="hidden px-4 py-3 text-xs text-muted-foreground @3xl:table-cell">
        <ArtifactTimestamp value={artifact.createdAt} />
      </TableCell>
      <TableCell className="hidden truncate px-4 py-3 text-xs text-muted-foreground @4xl:table-cell">
        {kindLabel}
      </TableCell>
      <TableCell
        className="px-2 py-2 text-right"
        onClick={(event) => {
          // Menu actions belong to the row menu, not the preview hit area.
          event.stopPropagation();
        }}
      >
        <ArtifactCatalogRowActions artifactId={artifact.id} />
      </TableCell>
    </TableRow>
  );
}

function ArtifactLibrarySearch({ loading }: { readonly loading: boolean }) {
  const { t } = useTranslation();
  const search = useGet(artifactCatalogSearch$);
  const setSearch = useSet(setArtifactCatalogSearch$);
  const signal = useGet(pageSignal$);
  const SearchIcon = loading ? Loader2 : Search;
  const updateSearch = (value: string) => {
    detach(
      setSearch(value, signal),
      Reason.DomCallback,
      "search artifact library",
    );
  };
  return (
    <div className="relative min-w-40 flex-1 @3xl:max-w-80">
      <SearchIcon
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground",
          loading && "animate-spin",
        )}
      />
      <Input
        type="search"
        value={search}
        aria-label={t(($) => {
          return $.artifacts.library.search;
        })}
        placeholder={t(($) => {
          return $.artifacts.library.search;
        })}
        className="h-9 pl-9 pr-9"
        onChange={(event) => {
          updateSearch(event.currentTarget.value);
        }}
      />
      {search && (
        <Button
          type="button"
          variant="quiet"
          size="icon-sm"
          className="absolute right-1 top-1/2 size-7 -translate-y-1/2"
          aria-label={t(($) => {
            return $.artifacts.library.clearSearch;
          })}
          onClick={() => {
            updateSearch("");
          }}
        >
          <X size={14} />
        </Button>
      )}
    </div>
  );
}

function ArtifactLibraryTypeFilter() {
  const { t } = useTranslation();
  const kind = useGet(selectedArtifactCatalogKind$);
  const setKind = useSet(setArtifactCatalogKind$);
  const kindOptions = useKindOptions();
  const items = [
    {
      value: "all" as const,
      label: t(($) => {
        return $.artifacts.library.allTypes;
      }),
    },
    ...kindOptions,
  ];
  return (
    <Select<ArtifactCatalogKind | "all">
      items={items}
      value={kind ?? "all"}
      onValueChange={(value) => {
        if (value) {
          setKind(value === "all" ? null : value);
        }
      }}
    >
      <SelectTrigger
        variant="neutral"
        aria-label={t(($) => {
          return $.artifacts.library.type;
        })}
        className="h-9 w-auto min-w-32 max-w-44"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => {
          return (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

function ArtifactLibraryCompactSort() {
  const { t } = useTranslation();
  const order = useGet(artifactCatalogSort$);
  const setSort = useSet(setArtifactCatalogSort$);
  const items = [
    {
      value: "createdAt",
      label: t(($) => {
        return $.artifacts.library.created;
      }),
    },
    {
      value: "title",
      label: t(($) => {
        return $.artifacts.library.name;
      }),
    },
  ] satisfies { value: ArtifactCatalogSort; label: string }[];
  return (
    <div className="flex items-center gap-1 @3xl:hidden">
      <Select<ArtifactCatalogSort>
        items={items}
        value={order.sort}
        onValueChange={(value) => {
          if (value) {
            setSort(value, value === "title" ? "asc" : "desc");
          }
        }}
      >
        <SelectTrigger
          variant="neutral"
          aria-label={t(($) => {
            return $.artifacts.library.sort;
          })}
          className="h-9 w-auto max-w-44"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => {
            return (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      <Button
        type="button"
        variant="quiet"
        size="icon-sm"
        aria-label={
          order.direction === "asc"
            ? t(($) => {
                return $.artifacts.library.sortDescending;
              })
            : t(($) => {
                return $.artifacts.library.sortAscending;
              })
        }
        onClick={() => {
          setSort(order.sort, order.direction === "asc" ? "desc" : "asc");
        }}
      >
        {order.direction === "asc" ? (
          <ArrowUp size={16} />
        ) : (
          <ArrowDown size={16} />
        )}
      </Button>
    </div>
  );
}

function ArtifactLibraryToolbar({ loading }: { readonly loading: boolean }) {
  const previewOpen = useGet(artifactCatalogSidebar.open$);
  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 bg-background pb-4 pt-1">
      <ArtifactLibrarySearch loading={loading} />
      <ArtifactLibraryTypeFilter />
      {!previewOpen && <ArtifactLibraryCompactSort />}
    </div>
  );
}

function ArtifactLibraryTable({
  artifacts,
  scrollTargetId,
}: {
  readonly artifacts: readonly CatalogArtifact[];
  readonly scrollTargetId?: string | null;
}) {
  const { t } = useTranslation();
  const open = useGet(artifactCatalogSidebar.open$);
  const detail = useLastLoadable(artifactCatalogSidebar.detail$);
  return (
    <TooltipProvider delay={300}>
      <Table className="min-w-0">
        <colgroup>
          <col />
          <col className="hidden w-36 @3xl:table-column" />
          <col className="hidden w-28 @4xl:table-column" />
          <col className="w-12" />
        </colgroup>
        <TableHeader className="bg-background">
          <TableRow>
            <SortHeading
              field="title"
              label={t(($) => {
                return $.artifacts.library.name;
              })}
            />
            <SortHeading
              field="createdAt"
              label={t(($) => {
                return $.artifacts.library.created;
              })}
              className="hidden @3xl:table-cell"
            />
            <TableHead className="hidden px-4 text-xs text-muted-foreground @4xl:table-cell">
              {t(($) => {
                return $.artifacts.library.type;
              })}
            </TableHead>
            <TableHead>
              <span className="sr-only">
                {t(($) => {
                  return $.artifacts.actions.more;
                })}
              </span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {artifacts.map((artifact) => {
            return (
              <ArtifactLibraryRow
                key={artifact.id}
                artifact={artifact}
                selected={
                  open &&
                  detail.state === "hasData" &&
                  detail.data?.id === artifact.id
                }
                scrollIntoView={scrollTargetId === artifact.id}
              />
            );
          })}
        </TableBody>
      </Table>
    </TooltipProvider>
  );
}

function ArtifactLibraryEmpty() {
  const { t } = useTranslation();
  const kind = useGet(selectedArtifactCatalogKind$);
  const search = useGet(artifactCatalogSearch$);
  const setKind = useSet(setArtifactCatalogKind$);
  const setSearch = useSet(setArtifactCatalogSearch$);
  const signal = useGet(pageSignal$);
  const filtered = Boolean(kind || search);
  return (
    <div
      role="status"
      className="flex min-h-64 flex-col items-center justify-center gap-2 text-center"
    >
      <File
        size={28}
        className="mb-2 text-muted-foreground"
        aria-hidden="true"
      />
      <h3 className="text-sm font-medium">
        {t(($) => {
          return $.artifacts.library.emptyTitle;
        })}
      </h3>
      <p className="text-sm text-muted-foreground">
        {filtered
          ? t(($) => {
              return $.artifacts.library.emptyDescription;
            })
          : t(($) => {
              return $.artifacts.catalog.emptyDescription;
            })}
      </p>
      {filtered && (
        <Button
          variant="neutral"
          className="mt-2"
          onClick={() => {
            setKind(null);
            detach(
              setSearch("", signal),
              Reason.DomCallback,
              "clear artifact library filters",
            );
          }}
        >
          {t(($) => {
            return $.artifacts.library.clearFilters;
          })}
        </Button>
      )}
    </div>
  );
}

function ArtifactLibraryResults({
  scrollTargetId,
}: {
  readonly scrollTargetId?: string | null;
}) {
  const { t } = useTranslation();
  const catalog = useLastLoadable(artifactCatalog$);
  const reload = useSet(reloadArtifactCatalog$);
  if (catalog.state === "loading") {
    return (
      <div
        role="status"
        aria-label={t(($) => {
          return $.artifacts.catalog.loading;
        })}
        className="space-y-2"
      >
        {Array.from({ length: 6 }, (_, index) => {
          return <Skeleton key={index} className="h-16 w-full" />;
        })}
      </div>
    );
  }
  if (catalog.state === "hasError") {
    return (
      <div
        role="alert"
        className="flex min-h-48 flex-col items-center justify-center gap-3 text-sm text-muted-foreground"
      >
        <p>
          {t(($) => {
            return $.artifacts.catalog.error;
          })}
        </p>
        <Button
          variant="neutral"
          onClick={() => {
            reload();
          }}
        >
          {t(($) => {
            return $.artifacts.library.retry;
          })}
        </Button>
      </div>
    );
  }
  return catalog.data.artifacts.length === 0 ? (
    <ArtifactLibraryEmpty />
  ) : (
    <ArtifactLibraryTable
      artifacts={catalog.data.artifacts}
      scrollTargetId={scrollTargetId}
    />
  );
}

function ArtifactLibraryPaging() {
  const { t } = useTranslation();
  const catalog = useLastLoadable(artifactCatalog$);
  const pagingState = useGet(artifactCatalogPagingState$);
  const loadMore = useSet(loadMoreArtifactCatalog$);
  const signal = useGet(pageSignal$);
  if (catalog.state !== "hasData" || catalog.data.nextCursor === null) {
    return null;
  }
  return (
    <div className="flex justify-center pt-4">
      <Button
        variant="neutral"
        disabled={pagingState === "loading"}
        onClick={() => {
          detach(
            loadMore(signal),
            Reason.DomCallback,
            "load more library artifacts",
          );
        }}
      >
        {pagingState === "loading" && (
          <Loader2 className="size-4 animate-spin" />
        )}
        {t(($) => {
          return pagingState === "error"
            ? $.artifacts.library.retry
            : $.artifacts.library.loadMore;
        })}
      </Button>
    </div>
  );
}

export function ArtifactLibraryPage({
  animateEntry = true,
  scrollTargetId,
}: {
  readonly animateEntry?: boolean;
  readonly scrollTargetId?: string | null;
}) {
  const { t } = useTranslation();
  const open = useGet(artifactCatalogSidebar.open$);
  const catalogRequest = useLoadable(artifactCatalog$);
  const catalog = useLastLoadable(artifactCatalog$);
  const viewportRef = useSet(artifactCatalogViewportRef$);
  const signal = useGet(pageSignal$);
  const pagingState = useGet(artifactCatalogPagingState$);
  const loadMore = useSet(loadMoreArtifactCatalog$);
  const onScroll = (event: UIEvent<HTMLElement>) => {
    const viewport = event.currentTarget;
    if (
      catalog.state === "hasData" &&
      catalog.data.nextCursor !== null &&
      pagingState === "idle" &&
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <=
        viewport.clientHeight * 2
    ) {
      detach(
        loadMore(signal),
        Reason.DomCallback,
        "load more library artifacts",
      );
    }
  };
  return (
    <ChatThreadSidebarShell
      animateEntry={animateEntry}
      open={open}
      widthKey="artifacts"
      sidebar={<ArtifactCatalogSidebar />}
    >
      <main
        ref={viewportRef}
        tabIndex={-1}
        onScroll={onScroll}
        aria-busy={catalogRequest.state === "loading"}
        className="@container min-h-0 flex-1 overflow-y-auto bg-background outline-none"
      >
        <div className="px-4 pb-8 pt-6 md:px-8 md:pt-8">
          <div className="mb-6">
            <h1 className="text-2xl font-semibold tracking-tight">
              {t(($) => {
                return $.artifacts.title;
              })}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t(($) => {
                return $.artifacts.catalog.description;
              })}
            </p>
          </div>
          <h2 className="mb-4 inline-block border-b-2 border-foreground pb-2 text-sm font-medium">
            {t(($) => {
              return $.artifacts.library.allArtifacts;
            })}
          </h2>
          <ArtifactLibraryToolbar
            loading={catalogRequest.state === "loading"}
          />
          <ArtifactLibraryResults scrollTargetId={scrollTargetId} />
          <ArtifactLibraryPaging />
        </div>
        <ArtifactCatalogRowDeleteDialog />
      </main>
    </ChatThreadSidebarShell>
  );
}
