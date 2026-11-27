import type { KeyboardEvent, UIEvent } from "react";
import type { ArtifactCatalogCategory } from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useLoadable,
  useSet,
} from "ccstate-react";
import {
  ArrowDown,
  ArrowUp,
  File,
  LayoutGrid,
  List,
  Loader2,
  Search,
  X,
} from "lucide-react";
import {
  Button,
  Input,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Toggle,
  ToggleGroup,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@okouai/ui";
import { useTranslation } from "react-i18next";

import { resolvedAppLocale } from "../../i18n/format.ts";
import { now } from "../../lib/time.ts";
import { artifactCatalogViewportRef$ } from "../../signals/artifact-deletion.ts";
import { artifactCatalogSidebar } from "../../signals/artifacts-page/artifact-catalog-instance.ts";
import {
  artifactCatalog$,
  artifactCatalogPagingState$,
  artifactCatalogSearch$,
  artifactCatalogDirection$,
  loadMoreArtifactCatalog$,
  openArtifact$,
  reloadArtifactCatalog$,
  rememberArtifactCatalogTrigger$,
  scrollArtifactCardIntoViewRef$,
  selectedArtifactCatalogCategory$,
  selectedArtifactCatalogKind$,
  setArtifactCatalogCategory$,
  setArtifactCatalogSearch$,
  setArtifactCatalogDirection$,
} from "../../signals/artifacts-page/artifact-catalog-signals.ts";
import {
  artifactLibraryView$,
  setArtifactLibraryView$,
  type ArtifactLibraryView as LibraryView,
} from "../../signals/artifacts-page/artifact-library-view.ts";
import type { CatalogArtifact } from "../../signals/artifacts-page/create-artifact-catalog-signals.ts";
import { userPreferences$ } from "../../signals/okou-page/settings/user-preferences.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ChatThreadSidebarShell } from "../okou-page/chat-thread-sidebar-shell.tsx";
import {
  ArtifactCatalogCover,
  artifactGalleryKind,
  artifactKindIcon,
  useArtifactKindLabel,
} from "./artifact-catalog-cover.tsx";
import {
  ArtifactCatalogRowActions,
  ArtifactCatalogRowDeleteDialog,
} from "./artifact-catalog-row-actions.tsx";
import { ArtifactCatalogSidebar } from "./artifact-catalog-sidebar.tsx";

const LIBRARY_GRID_CLASS_NAME =
  "grid grid-cols-[repeat(auto-fill,minmax(min(100%,240px),1fr))] gap-x-5 gap-y-6";

function useCategoryOptions() {
  const { t } = useTranslation();
  return [
    {
      value: "all",
      label: t(($) => {
        return $.artifacts.library.categories.all;
      }),
    },
    {
      value: "document",
      label: t(($) => {
        return $.artifacts.library.categories.document;
      }),
    },
    {
      value: "presentation",
      label: t(($) => {
        return $.artifacts.library.categories.presentation;
      }),
    },
    {
      value: "website",
      label: t(($) => {
        return $.artifacts.library.categories.website;
      }),
    },
    {
      value: "spreadsheet",
      label: t(($) => {
        return $.artifacts.library.categories.spreadsheet;
      }),
    },
    {
      value: "image",
      label: t(($) => {
        return $.artifacts.library.categories.image;
      }),
    },
    {
      value: "video",
      label: t(($) => {
        return $.artifacts.library.categories.video;
      }),
    },
    {
      value: "audio",
      label: t(($) => {
        return $.artifacts.library.categories.audio;
      }),
    },
    {
      value: "other",
      label: t(($) => {
        return $.artifacts.library.categories.other;
      }),
    },
  ] satisfies { value: ArtifactCatalogCategory | "all"; label: string }[];
}

function ArtifactTimestamp({
  value,
  timezone,
}: {
  readonly value: string;
  readonly timezone: string;
}) {
  const date = new Date(value);
  const locale = resolvedAppLocale();
  const exact = new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "long",
  }).format(date);
  return (
    <Tooltip>
      <TooltipTrigger render={<time dateTime={value} title={exact} />}>
        {new Intl.DateTimeFormat(locale, {
          timeZone: timezone,
          dateStyle: "medium",
        }).format(date)}
      </TooltipTrigger>
      <TooltipContent>{exact}</TooltipContent>
    </Tooltip>
  );
}

function moveArtifactFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
    return;
  }
  const targets = event.currentTarget
    .closest("[data-artifact-library-results]")
    ?.querySelectorAll<HTMLElement>("[data-artifact-open]");
  if (!targets) {
    return;
  }
  const controls = Array.from(targets);
  const next =
    controls[
      controls.indexOf(event.currentTarget) +
        (event.key === "ArrowDown" ? 1 : -1)
    ];
  if (next) {
    // Preserve catalog preview navigation across date groups and both views.
    event.preventDefault();
    next.focus();
  }
}

function useArtifactPreview(artifact: CatalogArtifact) {
  const { t } = useTranslation();
  const openArtifact = useSet(openArtifact$);
  const signal = useGet(pageSignal$);
  const rememberTrigger = useSet(rememberArtifactCatalogTrigger$);
  return {
    label: t(
      ($) => {
        return $.artifacts.catalog.cardPreview;
      },
      { title: artifact.title },
    ),
    open: (trigger: HTMLElement) => {
      rememberTrigger(trigger);
      detach(
        openArtifact(artifact.id, signal),
        Reason.DomCallback,
        "open library artifact",
      );
    },
  };
}

function ArtifactLibraryCard({
  artifact,
  selected,
  scrollIntoView,
  timezone,
}: {
  readonly artifact: CatalogArtifact;
  readonly selected: boolean;
  readonly scrollIntoView: boolean;
  readonly timezone: string;
}) {
  const preview = useArtifactPreview(artifact);
  const scrollTargetRef = useSet(scrollArtifactCardIntoViewRef$);
  const displayKind = artifactGalleryKind(artifact);
  const kindLabel = useArtifactKindLabel(displayKind);
  const controlClassName =
    "group col-span-2 col-start-1 row-span-2 row-start-1 block w-full min-w-0 rounded-surface text-left no-underline outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";
  const content = (
    <>
      <ArtifactCatalogCover artifact={artifact} />
      <span className="mt-3 flex h-8 min-w-0 items-center pl-4 pr-16 text-sm font-medium text-foreground">
        <span className="truncate">{artifact.title}</span>
      </span>
    </>
  );
  return (
    <article
      ref={scrollIntoView ? scrollTargetRef : undefined}
      data-artifact-id={artifact.id}
      aria-label={artifact.title}
      data-state={selected ? "selected" : undefined}
      className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] grid-rows-[auto_2rem_auto] items-center rounded-surface p-1 data-[state=selected]:bg-state-selected"
    >
      {artifact.kind === "shared-thread" ? (
        <a
          href={`/share/threads/${encodeURIComponent(artifact.sharedThreadId)}`}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={preview.label}
          data-artifact-open
          className={controlClassName}
          onKeyDown={moveArtifactFocus}
        >
          {content}
        </a>
      ) : (
        <button
          type="button"
          aria-label={preview.label}
          aria-current={selected ? "true" : undefined}
          data-artifact-open
          className={controlClassName}
          onKeyDown={moveArtifactFocus}
          onClick={(event) => {
            preview.open(event.currentTarget);
          }}
        >
          {content}
        </button>
      )}
      <div className="col-start-2 row-start-2 mr-4">
        <ArtifactCatalogRowActions artifact={artifact} />
      </div>
      <div className="col-span-2 row-start-3 mx-4 mb-3 mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span className="truncate">{kindLabel}</span>
        <span aria-hidden="true">·</span>
        <span className="shrink-0">
          <ArtifactTimestamp value={artifact.createdAt} timezone={timezone} />
        </span>
      </div>
    </article>
  );
}

function ArtifactLibraryRow({
  artifact,
  selected,
  scrollIntoView,
  timezone,
}: {
  readonly artifact: CatalogArtifact;
  readonly selected: boolean;
  readonly scrollIntoView: boolean;
  readonly timezone: string;
}) {
  const preview = useArtifactPreview(artifact);
  const scrollTargetRef = useSet(scrollArtifactCardIntoViewRef$);
  const displayKind = artifactGalleryKind(artifact);
  const kindLabel = useArtifactKindLabel(displayKind);
  const content = (
    <>
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-nested-fill text-muted-foreground"
      >
        {artifactKindIcon(displayKind, 18)}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
        {artifact.title}
      </span>
    </>
  );
  const controlClassName =
    "flex min-w-0 w-full items-center gap-3 rounded-sm py-2 text-left no-underline outline-none focus-visible:ring-2 focus-visible:ring-ring";
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
        trigger?.click();
      }}
    >
      <TableCell className="px-3 py-1">
        {artifact.kind === "shared-thread" ? (
          <a
            href={`/share/threads/${encodeURIComponent(artifact.sharedThreadId)}`}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={preview.label}
            data-artifact-open
            className={controlClassName}
            onKeyDown={moveArtifactFocus}
          >
            {content}
          </a>
        ) : (
          <button
            type="button"
            aria-label={preview.label}
            aria-current={selected ? "true" : undefined}
            data-artifact-open
            className={controlClassName}
            onKeyDown={moveArtifactFocus}
            onClick={(event) => {
              preview.open(event.currentTarget);
            }}
          >
            {content}
          </button>
        )}
      </TableCell>
      <TableCell className="hidden px-3 py-3 text-xs text-muted-foreground @3xl:table-cell">
        <ArtifactTimestamp value={artifact.createdAt} timezone={timezone} />
      </TableCell>
      <TableCell className="hidden truncate px-3 py-3 text-xs text-muted-foreground @4xl:table-cell">
        {kindLabel}
      </TableCell>
      <TableCell
        className="px-2 py-2 text-right"
        onClick={(event) => {
          // Menu actions belong to the row menu, not the preview hit area.
          event.stopPropagation();
        }}
      >
        <ArtifactCatalogRowActions artifact={artifact} />
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
    <div className="relative min-w-40 flex-1 @3xl:max-w-72">
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

function ArtifactLibrarySort() {
  const { t } = useTranslation();
  const direction = useGet(artifactCatalogDirection$);
  const setDirection = useSet(setArtifactCatalogDirection$);
  const Icon = direction === "asc" ? ArrowUp : ArrowDown;
  const content = (
    <>
      {t(($) => {
        return $.artifacts.library.created;
      })}
      <span className="sr-only">
        {" "}
        {direction === "asc"
          ? t(($) => {
              return $.artifacts.library.sortDescending;
            })
          : t(($) => {
              return $.artifacts.library.sortAscending;
            })}
      </span>
      <Icon className="size-3.5" aria-hidden="true" />
    </>
  );
  const toggle = () => {
    setDirection(direction === "asc" ? "desc" : "asc");
  };
  return (
    <Button
      type="button"
      variant="neutral"
      className="shrink-0"
      onClick={toggle}
    >
      {content}
    </Button>
  );
}

function ArtifactLibraryViewToggle({ view }: { readonly view: LibraryView }) {
  const { t } = useTranslation();
  const setView = useSet(setArtifactLibraryView$);
  const signal = useGet(pageSignal$);
  return (
    <ToggleGroup<LibraryView>
      value={[view]}
      aria-label={t(($) => {
        return $.artifacts.library.view;
      })}
      className="h-9 shrink-0 gap-1"
      onValueChange={(values) => {
        const next = values[0];
        if (next) {
          detach(
            setView(next, signal),
            Reason.DomCallback,
            "change artifact library view",
          );
        }
      }}
    >
      <Toggle
        value="grid"
        variant="filter"
        className="size-9 p-0"
        aria-label={t(($) => {
          return $.artifacts.library.gridView;
        })}
      >
        <LayoutGrid className="size-4" aria-hidden="true" />
      </Toggle>
      <Toggle
        value="list"
        variant="filter"
        className="size-9 p-0"
        aria-label={t(($) => {
          return $.artifacts.library.listView;
        })}
      >
        <List className="size-4" aria-hidden="true" />
      </Toggle>
    </ToggleGroup>
  );
}

function ArtifactLibraryToolbar({
  loading,
  view,
}: {
  readonly loading: boolean;
  readonly view: LibraryView;
}) {
  const { t } = useTranslation();
  const options = useCategoryOptions();
  const legacyKind = useGet(selectedArtifactCatalogKind$);
  const setCategory = useSet(setArtifactCatalogCategory$);
  return (
    <div className="sticky top-0 z-10 space-y-5 bg-background pb-4 pt-1">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="basis-full pb-1 text-xl font-semibold tracking-tight @3xl:basis-auto @3xl:flex-1 @3xl:pb-0">
          {t(($) => {
            return $.artifacts.title;
          })}
        </h1>
        <ArtifactLibrarySearch loading={loading} />
        <ArtifactLibraryViewToggle view={view} />
        <ArtifactLibrarySort />
      </div>
      <div className="min-w-0 overflow-x-auto pb-1">
        <TabsList
          aria-label={t(($) => {
            return $.artifacts.library.type;
          })}
          className="h-10 w-max min-w-full justify-start gap-5 rounded-none border-b border-divider bg-transparent p-0"
        >
          {options.map((option) => {
            return (
              <TabsTrigger
                key={option.value}
                value={option.value}
                className="rounded-none border-b border-transparent px-0 data-active:border-foreground data-active:bg-transparent data-active:shadow-none not-data-active:hover:bg-transparent focus-visible:ring-inset"
                onClick={() => {
                  // All also clears a kind filter retained by an older link.
                  if (option.value === "all" && legacyKind) {
                    setCategory(null);
                  }
                }}
              >
                {option.label}
              </TabsTrigger>
            );
          })}
        </TabsList>
      </div>
    </div>
  );
}

function ArtifactLibraryTable({
  artifacts,
  selectedId,
  scrollTargetId,
  timezone,
}: {
  readonly artifacts: readonly CatalogArtifact[];
  readonly selectedId: string | null;
  readonly scrollTargetId?: string | null;
  readonly timezone: string;
}) {
  const { t } = useTranslation();
  const direction = useGet(artifactCatalogDirection$);
  return (
    <Table className="min-w-0">
      <colgroup>
        <col />
        <col className="hidden w-36 @3xl:table-column" />
        <col className="hidden w-28 @4xl:table-column" />
        <col className="w-12" />
      </colgroup>
      <TableHeader className="sr-only">
        <TableRow className="hover:bg-transparent">
          <TableHead className="px-3 text-xs font-normal text-muted-foreground">
            {t(($) => {
              return $.artifacts.library.name;
            })}
          </TableHead>
          <TableHead
            aria-sort={direction === "asc" ? "ascending" : "descending"}
            className="hidden px-3 text-xs font-normal text-muted-foreground @3xl:table-cell"
          >
            {t(($) => {
              return $.artifacts.library.created;
            })}
          </TableHead>
          <TableHead className="hidden px-3 text-xs font-normal text-muted-foreground @4xl:table-cell">
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
              selected={selectedId === artifact.id}
              scrollIntoView={scrollTargetId === artifact.id}
              timezone={timezone}
            />
          );
        })}
      </TableBody>
    </Table>
  );
}

function ArtifactLibraryEmpty() {
  const { t } = useTranslation();
  const category = useGet(selectedArtifactCatalogCategory$);
  const kind = useGet(selectedArtifactCatalogKind$);
  const search = useGet(artifactCatalogSearch$);
  const setCategory = useSet(setArtifactCatalogCategory$);
  const setSearch = useSet(setArtifactCatalogSearch$);
  const signal = useGet(pageSignal$);
  const filtered = Boolean(category || kind || search);
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
      <h2 className="text-sm font-medium">
        {t(($) => {
          return $.artifacts.library.emptyTitle;
        })}
      </h2>
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
            setCategory(null);
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

interface ArtifactDateGroup {
  readonly day: number;
  readonly date: Date;
  readonly artifacts: CatalogArtifact[];
}

function calendarDay(date: Date, formatter: Intl.DateTimeFormat): number {
  const parts = formatter.formatToParts(date);
  const component = (type: "year" | "month" | "day") => {
    return Number(
      parts.find((part) => {
        return part.type === type;
      })!.value,
    );
  };
  // Compare calendar components, not elapsed 24-hour periods across DST.
  return Date.UTC(component("year"), component("month") - 1, component("day"));
}

function groupArtifactsByDate(
  artifacts: readonly CatalogArtifact[],
  formatter: Intl.DateTimeFormat,
): ArtifactDateGroup[] {
  const groups = new Map<number, ArtifactDateGroup>();
  for (const artifact of artifacts) {
    const date = new Date(artifact.createdAt);
    const day = calendarDay(date, formatter);
    const group = groups.get(day);
    if (group) {
      group.artifacts.push(artifact);
    } else {
      groups.set(day, { day, date, artifacts: [artifact] });
    }
  }
  return Array.from(groups.values());
}

function ArtifactLibraryLoading({ view }: { readonly view: LibraryView }) {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      aria-label={t(($) => {
        return $.artifacts.catalog.loading;
      })}
      className={view === "grid" ? LIBRARY_GRID_CLASS_NAME : "space-y-2"}
    >
      {Array.from({ length: 6 }, (_, index) => {
        return view === "grid" ? (
          <div key={index} className="space-y-3">
            <Skeleton className="aspect-[16/10] w-full rounded-surface" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ) : (
          <Skeleton key={index} className="h-16 w-full" />
        );
      })}
    </div>
  );
}

function ArtifactLibraryResults({
  scrollTargetId,
  view,
}: {
  readonly scrollTargetId?: string | null;
  readonly view: LibraryView;
}) {
  const { t } = useTranslation();
  const catalog = useLastLoadable(artifactCatalog$);
  const reload = useSet(reloadArtifactCatalog$);
  const open = useGet(artifactCatalogSidebar.open$);
  const detail = useLastLoadable(artifactCatalogSidebar.detail$);
  const preferences = useLastResolved(userPreferences$);
  const timezone =
    preferences?.timezone ??
    new Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (catalog.state === "loading") {
    return <ArtifactLibraryLoading view={view} />;
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
  if (catalog.data.artifacts.length === 0) {
    return <ArtifactLibraryEmpty />;
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
  const today = calendarDay(new Date(now()), formatter);
  const dateLabel = new Intl.DateTimeFormat(resolvedAppLocale(), {
    timeZone: timezone,
    dateStyle: "long",
  });
  // The catalog already accumulates pages in server order for this query.
  const groups = groupArtifactsByDate(catalog.data.artifacts, formatter);
  const selectedId =
    open && detail.state === "hasData" ? (detail.data?.id ?? null) : null;
  return (
    <TooltipProvider delay={300}>
      <div data-artifact-library-results className="space-y-7">
        {groups.map((group) => {
          const label =
            group.day === today
              ? t(($) => {
                  return $.artifacts.library.today;
                })
              : group.day === today - 86_400_000
                ? t(($) => {
                    return $.artifacts.library.yesterday;
                  })
                : dateLabel.format(group.date);
          return (
            <section key={group.day} aria-label={label}>
              <h2 className="mb-3 px-1 text-sm font-medium text-muted-foreground">
                {label}
              </h2>
              {view === "grid" ? (
                <div className={LIBRARY_GRID_CLASS_NAME}>
                  {group.artifacts.map((artifact) => {
                    return (
                      <ArtifactLibraryCard
                        key={artifact.id}
                        artifact={artifact}
                        selected={selectedId === artifact.id}
                        scrollIntoView={scrollTargetId === artifact.id}
                        timezone={timezone}
                      />
                    );
                  })}
                </div>
              ) : (
                <ArtifactLibraryTable
                  artifacts={group.artifacts}
                  selectedId={selectedId}
                  scrollTargetId={scrollTargetId}
                  timezone={timezone}
                />
              )}
            </section>
          );
        })}
      </div>
    </TooltipProvider>
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
    <div className="flex justify-center pt-6">
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
  const open = useGet(artifactCatalogSidebar.open$);
  const catalogRequest = useLoadable(artifactCatalog$);
  const catalog = useLastLoadable(artifactCatalog$);
  const viewportRef = useSet(artifactCatalogViewportRef$);
  const signal = useGet(pageSignal$);
  const pagingState = useGet(artifactCatalogPagingState$);
  const loadMore = useSet(loadMoreArtifactCatalog$);
  const category = useGet(selectedArtifactCatalogCategory$);
  const setCategory = useSet(setArtifactCatalogCategory$);
  const categoryOptions = useCategoryOptions();
  const view = useLastResolved(artifactLibraryView$) ?? "grid";
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
        <Tabs
          value={category ?? "all"}
          onValueChange={(value) => {
            const option = categoryOptions.find((item) => {
              return item.value === value;
            });
            if (option) {
              setCategory(option.value === "all" ? null : option.value);
            }
          }}
          className="px-4 pb-8 pt-5 md:px-8 md:pt-7"
        >
          <ArtifactLibraryToolbar
            loading={catalogRequest.state === "loading"}
            view={view}
          />
          <TabsContent value={category ?? "all"}>
            <ArtifactLibraryResults
              scrollTargetId={scrollTargetId}
              view={view}
            />
            <ArtifactLibraryPaging />
          </TabsContent>
        </Tabs>
        <ArtifactCatalogRowDeleteDialog />
      </main>
    </ChatThreadSidebarShell>
  );
}
