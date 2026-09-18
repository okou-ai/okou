import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import type { IntroVideoOptions } from "@okouai/api-contracts/contracts/intro-video-options";
import type {
  IntroVideoAvatar,
  IntroVideoStyle,
  IntroVideoVoice,
} from "@okouai/api-contracts/contracts/intro-video-presenter";
import { Button, IconButton, Input, Skeleton, cn } from "@okouai/ui";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import {
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  Search,
  SlidersHorizontal,
  UserRound,
  UserRoundX,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { IntroVideoPickerSignals } from "../../signals/okou-page/intro-video-picker.ts";
import { introVideoStyleGallerySignals } from "../../signals/okou-page/intro-video-style-gallery.ts";
import { introVideoAvatarPickerSignals } from "../../signals/okou-page/intro-video-catalog-picker.ts";
import { introVideoVoicePickerSignals } from "../../signals/okou-page/intro-video-voice-picker.ts";
import {
  groupIntroVideoAvatars,
  type IntroVideoAvatarGroup,
} from "../../signals/okou-page/intro-video-avatar-groups.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { IntroVideoStyleCard } from "./intro-video-style-card.tsx";
import {
  INTRO_VIDEO_STYLE_TAGS,
  useIntroVideoStyleGroupLabels,
} from "./intro-video-style-gallery.tsx";
import { IntroVideoAvatarGroupCard } from "./intro-video-avatar-group-card.tsx";
import { IntroVideoCatalogPagination } from "./intro-video-catalog-pagination.tsx";
import { TemplateFilterPillRow } from "./template-filter-pill.tsx";
import { SCROLL_FADE_Y } from "./scroll-fade.ts";
import {
  TEMPLATE_TILE_MEDIA,
  TEMPLATE_TILE_RING,
  TEMPLATE_TILE_RING_SELECTED,
  TEMPLATE_TILE_SELECTED_BADGE,
} from "./template-tile.ts";
import {
  VoiceLibraryContent,
  VoiceLibraryToolbar,
  VoicePreviewControl,
} from "./avatar-template-picker.tsx";
import {
  avatarSelectionLabel,
  voiceSelectionLabel,
} from "./intro-video-selection-labels.ts";

/**
 * The options layer's width, and the gutter the gallery section gives up for
 * it: 344 plus 8px of air on the layer's right edge and 8px between the layer
 * and the cards. The section takes the whole figure as padding, so the layer
 * floats over empty space rather than over a card.
 */
const OPTIONS_PANEL_WIDTH = "w-[344px]";
const OPTIONS_PANEL_RESERVE = "pr-[360px]";

/** How many of each library the layer's first screen offers outright. */
const PANEL_PREVIEW_COUNT = 2;

interface PickerProps {
  readonly signals: IntroVideoPickerSignals;
}

function PickerMessage({
  error,
  onRetry,
}: {
  readonly error?: boolean;
  readonly onRetry?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      className="grid min-h-40 content-center justify-items-center gap-3 text-center text-sm text-muted-foreground"
    >
      <p>
        {t(($) => {
          return error
            ? $.chat.introVideo.catalog.error
            : $.chat.introVideo.picker.noMatches;
        })}
      </p>
      {onRetry && (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t(($) => {
            return $.chat.introVideo.catalog.retry;
          })}
        </Button>
      )}
    </div>
  );
}

function PickerSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 @[720px]/panel:grid-cols-3">
      {Array.from({ length: 6 }, (_, index) => {
        return <Skeleton key={index} className="aspect-video rounded-xl" />;
      })}
    </div>
  );
}

/**
 * Style search, placed where the workflow template tab puts its own: top left,
 * above the filters. Same width and height, so the two tabs of one dialog do
 * not present two different toolbars.
 */
function StyleSearch({ signals }: PickerProps) {
  const { t } = useTranslation();
  const query = useGet(signals.query$);
  const setQuery = useSet(signals.setQuery$);
  const label = t(($) => {
    return $.chat.introVideo.picker.searchStyles;
  });
  return (
    <div className="relative w-56 shrink-0">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        aria-label={label}
        placeholder={label}
        className="h-9 pl-9 text-sm"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
        }}
      />
    </div>
  );
}

function StyleToolbar({ signals }: PickerProps) {
  const { t } = useTranslation();
  const panelOpen = useGet(signals.panelOpen$);
  const setPanelOpen = useSet(signals.setPanelOpen$);
  const label = t(($) => {
    return $.chat.introVideo.picker.moreOptions;
  });
  return (
    // 68px, the height the sibling tabs' toolbar row states, so the search box
    // does not move when the category changes.
    <div className="flex h-[68px] shrink-0 items-center gap-2 px-4 sm:px-6 sm:pr-14">
      <StyleSearch signals={signals} />
      <Button
        type="button"
        variant="outline"
        aria-label={label}
        aria-expanded={panelOpen}
        aria-controls="intro-video-options"
        onClick={() => {
          setPanelOpen(!panelOpen);
        }}
        className="ml-auto shrink-0 gap-2"
      >
        <SlidersHorizontal size={16} />
        {/* Below this width the label is what the toolbar runs out of room
            for first; the icon and the accessible name both stay. */}
        <span className="hidden @[520px]/panel:inline">{label}</span>
      </Button>
    </div>
  );
}

/**
 * The count of what the filters left, or — when the chosen style is not among
 * them — a way back to it. A selection the user cannot see is the one thing
 * this row has to answer for.
 */
function StyleCount({
  signals,
  ready,
  shown,
  total,
  hiddenSelection,
}: PickerProps & {
  readonly ready: boolean;
  readonly shown: number;
  readonly total: number;
  readonly hiddenSelection: string | null;
}) {
  const { t } = useTranslation();
  const clearFilters = useSet(signals.clearFilters$);
  if (!ready) {
    // Before the catalog resolves there is nothing to count, and a restored
    // style would read as filtered out of a wall that has not arrived.
    return null;
  }
  if (hiddenSelection !== null) {
    return (
      <Button
        type="button"
        variant="quiet"
        size="xs"
        className="shrink-0 font-normal"
        onClick={clearFilters}
      >
        {t(
          ($) => {
            return $.chat.introVideo.picker.selectedStyle;
          },
          { name: hiddenSelection },
        )}
      </Button>
    );
  }
  return (
    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
      {shown === total
        ? t(
            ($) => {
              return $.chat.introVideo.picker.styleCount;
            },
            { count: shown },
          )
        : t(
            ($) => {
              return $.chat.introVideo.picker.styleCountOf;
            },
            { shown, total },
          )}
    </span>
  );
}

function StyleFilterRow({
  signals,
  hasOther,
  ready,
  shown,
  total,
  hiddenSelection,
}: PickerProps & {
  readonly hasOther: boolean;
  readonly ready: boolean;
  readonly shown: number;
  readonly total: number;
  readonly hiddenSelection: string | null;
}) {
  const { t } = useTranslation();
  const labels = useIntroVideoStyleGroupLabels();
  const group = useGet(signals.group$);
  const setGroup = useSet(signals.setGroup$);
  const fade = useGet(signals.filterFade$);
  const setFilterRowRef = useSet(signals.setFilterRowRef$);
  return (
    <div className="flex shrink-0 items-center gap-3 px-4 pb-3 sm:px-6">
      <TemplateFilterPillRow
        layout="scroll"
        className="min-w-0 flex-1"
        fade={fade}
        scrollerRef={setFilterRowRef}
        label={t(($) => {
          return $.chat.introVideo.style.browseGroups;
        })}
        active={group}
        pills={[
          {
            id: "all",
            label: t(($) => {
              return $.artifacts.templates.all;
            }),
          },
          ...INTRO_VIDEO_STYLE_TAGS.map((id) => {
            return { id, label: labels[id] };
          }),
          ...(hasOther ? [{ id: "other", label: labels.other }] : []),
        ]}
        onSelect={setGroup}
      />
      <StyleCount
        signals={signals}
        ready={ready}
        shown={shown}
        total={total}
        hiddenSelection={hiddenSelection}
      />
    </div>
  );
}

function StyleGallery({
  signals,
  items,
  loading,
  error,
}: PickerProps & {
  readonly items: readonly IntroVideoStyle[];
  readonly loading: boolean;
  readonly error: boolean;
}) {
  const style = useGet(signals.style$);
  const setStyle = useSet(signals.setStyle$);
  const reload = useSet(introVideoStyleGallerySignals.reload$);
  const fade = useGet(signals.galleryFade$);
  const setGalleryRef = useSet(signals.setGalleryRef$);
  return (
    <div
      ref={setGalleryRef}
      data-fade={fade === "none" ? undefined : fade}
      data-intro-video-catalog-scroll=""
      className={cn(
        "min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6",
        SCROLL_FADE_Y,
      )}
    >
      {error ? (
        <PickerMessage error onRetry={reload} />
      ) : loading ? (
        <PickerSkeleton />
      ) : items.length === 0 ? (
        <PickerMessage />
      ) : (
        // Columns follow the section's own width, not the viewport: the
        // options layer takes 360px off it while the window never changes.
        <div className="grid grid-cols-1 gap-x-4 gap-y-5 @[420px]/panel:grid-cols-2 @[720px]/panel:grid-cols-3">
          {items.map((item) => {
            return (
              <IntroVideoStyleCard
                key={item.id}
                style={item}
                selected={
                  style?.kind === "catalog" && style.style.id === item.id
                }
                onSelect={() => {
                  setStyle({ kind: "catalog", style: item });
                }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * A compact row in the options layer: icon, title, one line of detail. It is a
 * `div` rather than a `Button` because a library row carries its own preview
 * control, and a button cannot nest inside a button.
 */
function PanelRow({
  leading,
  title,
  detail,
  selected,
  onSelect,
}: {
  readonly leading: ReactNode;
  readonly title: string;
  readonly detail?: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.target !== event.currentTarget) {
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2.5 rounded-xl border border-border bg-card px-2.5 py-2 text-left transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "border-primary bg-state-selected",
      )}
    >
      {leading}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium leading-5">
          {title}
        </span>
        {detail ? (
          <span className="block truncate text-[11px] font-normal leading-4 text-muted-foreground">
            {detail}
          </span>
        ) : null}
      </span>
      {selected ? (
        <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
          <Check size={12} />
        </span>
      ) : null}
    </div>
  );
}

function PanelIcon({ children }: { readonly children: ReactNode }) {
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-full bg-state-hover text-muted-foreground">
      {children}
    </span>
  );
}

/** Label left, chevron right — the way into a full library. */
function PanelMoreRow({
  label,
  onSelect,
}: {
  readonly label: string;
  readonly onSelect: () => void;
}) {
  return (
    <Button
      type="button"
      variant="quiet"
      onClick={onSelect}
      className="mt-1.5 w-full justify-between px-2.5 text-[13px]"
    >
      <span className="min-w-0 truncate text-left">{label}</span>
      <ChevronRight size={15} />
    </Button>
  );
}

function PanelPresenterTile({
  name,
  detail,
  imageUrl,
  selected,
  onSelect,
}: {
  readonly name: string;
  readonly detail: string;
  readonly imageUrl?: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`${name} · ${detail}`}
      aria-pressed={selected}
      onClick={onSelect}
      className="group/tile relative block min-w-0 cursor-pointer text-left focus-visible:outline-none"
    >
      <span
        className={cn(
          TEMPLATE_TILE_MEDIA,
          TEMPLATE_TILE_RING,
          "grid aspect-[3/4] place-items-center group-focus-visible/tile:ring-1 group-focus-visible/tile:ring-ring",
          selected && TEMPLATE_TILE_RING_SELECTED,
        )}
      >
        {imageUrl ? (
          <img
            src={imageUrl}
            alt=""
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover"
          />
        ) : (
          <UserRoundX size={20} className="text-muted-foreground" />
        )}
        {selected ? (
          <span className={TEMPLATE_TILE_SELECTED_BADGE}>
            <Check size={13} />
          </span>
        ) : null}
      </span>
      <span className="mt-1.5 block truncate px-0.5 text-xs font-medium leading-4 text-foreground">
        {name}
      </span>
      <span className="block truncate px-0.5 text-[11px] leading-4 text-muted-foreground">
        {detail}
      </span>
    </button>
  );
}

function usePresenterGroups(): {
  readonly groups: readonly IntroVideoAvatarGroup[];
  readonly loaded: boolean;
  readonly hasNext: boolean;
} {
  const catalog = useLoadable(introVideoAvatarPickerSignals.catalogPage$);
  const lastCatalog = useLastResolved(
    introVideoAvatarPickerSignals.catalogPage$,
  );
  const generation = useGet(introVideoAvatarPickerSignals.generation$);
  const visible =
    catalog.state === "hasData"
      ? catalog.data
      : lastCatalog?.generation === generation
        ? lastCatalog
        : undefined;
  return {
    groups: visible ? groupIntroVideoAvatars(visible.items) : [],
    loaded: visible !== undefined,
    hasNext: visible?.hasNext ?? false,
  };
}

function useVoiceCatalog(): {
  readonly voices: readonly IntroVideoVoice[];
  readonly complete: boolean;
} {
  const catalog = useLoadable(introVideoVoicePickerSignals.catalogPage$);
  const lastCatalog = useLastResolved(
    introVideoVoicePickerSignals.catalogPage$,
  );
  const generation = useGet(introVideoVoicePickerSignals.generation$);
  const visible =
    catalog.state === "hasData"
      ? catalog.data
      : lastCatalog?.generation === generation
        ? lastCatalog
        : undefined;
  return {
    voices: visible?.items ?? [],
    complete: visible !== undefined && !visible.hasNext,
  };
}

function voiceDetail(voice: IntroVideoVoice): string {
  return [voice.language, voice.gender].filter(Boolean).join(" · ");
}

/**
 * The default-voice row. When a presenter is chosen its own voice is what
 * "default" means, and that voice has a sample, so the row carries the same
 * preview control a library row does.
 */
function DefaultVoiceRow({ signals }: PickerProps) {
  const { t } = useTranslation();
  const avatar = useGet(signals.avatar$);
  const voice = useGet(signals.voice$);
  const setVoice = useSet(signals.setVoice$);
  const title = t(($) => {
    return avatar.kind === "none"
      ? $.chat.introVideo.voice.auto
      : $.chat.introVideo.picker.avatarVoice;
  });
  const sample =
    avatar.kind === "catalog" && avatar.avatar.defaultVoiceSampleUrl
      ? {
          id: avatar.avatar.defaultVoiceId,
          name: avatar.avatar.defaultVoiceName ?? title,
          sampleUrl: avatar.avatar.defaultVoiceSampleUrl,
        }
      : undefined;
  return (
    <PanelRow
      leading={
        sample ? (
          <VoicePreviewControl voice={sample} />
        ) : (
          <PanelIcon>
            <Volume2 size={15} />
          </PanelIcon>
        )
      }
      title={title}
      detail={t(($) => {
        return avatar.kind === "none"
          ? $.chat.introVideo.picker.autoVoiceDescription
          : $.chat.introVideo.voice.defaultDescription;
      })}
      selected={voice.kind === "default"}
      onSelect={() => {
        setVoice({ kind: "default" });
      }}
    />
  );
}

function NoVoiceoverRow({ signals }: PickerProps) {
  const { t } = useTranslation();
  const voice = useGet(signals.voice$);
  const setVoice = useSet(signals.setVoice$);
  return (
    <PanelRow
      leading={
        <PanelIcon>
          <VolumeX size={15} />
        </PanelIcon>
      }
      title={t(($) => {
        return $.chat.introVideo.voice.none;
      })}
      detail={t(($) => {
        return $.chat.introVideo.voice.noneShortDescription;
      })}
      selected={voice.kind === "none"}
      onSelect={() => {
        setVoice({ kind: "none" });
      }}
    />
  );
}

function OptionsVoiceSection({ signals }: PickerProps) {
  const { t } = useTranslation();
  const voice = useGet(signals.voice$);
  const setVoice = useSet(signals.setVoice$);
  const setView = useSet(signals.setPanelView$);
  const { voices, complete } = useVoiceCatalog();
  return (
    <>
      <p className="mb-2 text-xs font-medium text-muted-foreground">
        {t(($) => {
          return $.chat.introVideo.voice.label;
        })}
      </p>
      <div className="grid gap-1.5">
        <DefaultVoiceRow signals={signals} />
        <NoVoiceoverRow signals={signals} />
        {voices.slice(0, PANEL_PREVIEW_COUNT).map((item) => {
          return (
            <PanelRow
              key={item.id}
              leading={<VoicePreviewControl voice={item} />}
              title={item.name}
              detail={voiceDetail(item)}
              selected={voice.kind === "catalog" && voice.voice.id === item.id}
              onSelect={() => {
                setVoice({ kind: "catalog", voice: item });
              }}
            />
          );
        })}
      </div>
      <PanelMoreRow
        label={
          complete
            ? t(
                ($) => {
                  return $.chat.introVideo.picker.allVoicesCount;
                },
                { total: voices.length },
              )
            : t(($) => {
                return $.chat.introVideo.picker.allVoices;
              })
        }
        onSelect={() => {
          setView("voice");
        }}
      />
    </>
  );
}

function OptionsPresenterSection({ signals }: PickerProps) {
  const { t } = useTranslation();
  const avatar = useGet(signals.avatar$);
  const setAvatar = useSet(signals.setAvatar$);
  const setView = useSet(signals.setPanelView$);
  const { groups, loaded, hasNext } = usePresenterGroups();
  return (
    <>
      <p className="mb-2 mt-5 text-xs font-medium text-muted-foreground">
        {t(($) => {
          return $.chat.introVideo.avatar.label;
        })}
      </p>
      <div className="grid grid-cols-3 gap-2">
        <PanelPresenterTile
          name={t(($) => {
            return $.chat.introVideo.avatar.none;
          })}
          detail={t(($) => {
            return $.chat.introVideo.avatar.noneDetail;
          })}
          selected={avatar.kind === "none"}
          onSelect={() => {
            setAvatar({ kind: "none" });
          }}
        />
        {groups.slice(0, PANEL_PREVIEW_COUNT).map((group) => {
          const look = selectedLookInGroup(group, avatar) ?? group.looks[0];
          return (
            <PanelPresenterTile
              key={group.id}
              name={group.name}
              detail={look.name}
              imageUrl={look.previewImageUrl}
              selected={
                avatar.kind === "catalog" && avatar.avatar.groupId === group.id
              }
              onSelect={() => {
                setAvatar({ kind: "catalog", avatar: look });
              }}
            />
          );
        })}
      </div>
      <PanelMoreRow
        label={
          loaded && !hasNext
            ? t(
                ($) => {
                  return $.chat.introVideo.picker.allPresentersCount;
                },
                { total: groups.length },
              )
            : t(($) => {
                return $.chat.introVideo.picker.allPresenters;
              })
        }
        onSelect={() => {
          setView("avatar");
        }}
      />
    </>
  );
}

/**
 * The layer's first screen. It is not a pair of summary rows into two
 * libraries: the defaults and the first of each library are the choice most
 * people make, so they are offered outright and the libraries are the way
 * past them.
 */
function OptionsRootView({ signals }: PickerProps) {
  const { t } = useTranslation();
  return (
    <>
      <OptionsVoiceSection signals={signals} />
      <OptionsPresenterSection signals={signals} />
      <p className="mt-5 rounded-xl bg-state-hover px-3 py-2.5 text-xs leading-5 text-muted-foreground">
        {t(($) => {
          return $.chat.introVideo.picker.optionsNote;
        })}
      </p>
    </>
  );
}

function selectedLookInGroup(
  group: IntroVideoAvatarGroup,
  avatar: IntroVideoOptions["avatar"],
): IntroVideoAvatar | undefined {
  return avatar.kind === "catalog" && avatar.avatar.groupId === group.id
    ? avatar.avatar
    : undefined;
}

function PanelLibrarySearch({
  signals,
  label,
}: PickerProps & { readonly label: string }) {
  const query = useGet(signals.libraryQuery$);
  const setQuery = useSet(signals.setLibraryQuery$);
  return (
    <Input
      aria-label={label}
      placeholder={label}
      className="h-9 text-sm"
      value={query}
      onChange={(event) => {
        setQuery(event.target.value);
      }}
    />
  );
}

function AvatarLibraryView({ signals }: PickerProps) {
  const { t } = useTranslation();
  const selection = useGet(signals.avatar$);
  const setSelection = useSet(signals.setAvatar$);
  const query = useGet(signals.libraryQuery$).trim().toLowerCase();
  const catalog = useLoadable(introVideoAvatarPickerSignals.catalogPage$);
  const paging = useLoadable(introVideoAvatarPickerSignals.paging$);
  const loadMore = useSet(introVideoAvatarPickerSignals.loadMore$);
  const setSentinelRef = useSet(introVideoAvatarPickerSignals.setSentinelRef$);
  const reload = useSet(introVideoAvatarPickerSignals.reload$);
  const pageSignal = useGet(pageSignal$);
  const { groups, loaded, hasNext } = usePresenterGroups();
  const matches = groups.filter((group) => {
    return query === "" || group.name.toLowerCase().includes(query);
  });
  return (
    <>
      <div className="mb-3">
        <PanelLibrarySearch
          signals={signals}
          label={t(($) => {
            return $.chat.introVideo.picker.searchPresenters;
          })}
        />
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-pressed={selection.kind === "none"}
        onClick={() => {
          setSelection({ kind: "none" });
        }}
        className={cn(
          "mb-3 gap-2 border-border px-2.5 text-xs",
          selection.kind === "none" && "border-primary bg-state-selected",
        )}
      >
        <UserRoundX size={14} />
        {t(($) => {
          return $.chat.introVideo.avatar.none;
        })}
      </Button>
      <div className="grid grid-cols-2 items-stretch gap-3">
        {matches.map((group) => {
          return (
            <IntroVideoAvatarGroupCard
              key={group.id}
              group={group}
              selected={
                selection.kind === "catalog" ? selection.avatar : undefined
              }
              onSelect={(avatar) => {
                setSelection({ kind: "catalog", avatar });
              }}
            />
          );
        })}
      </div>
      {catalog.state === "hasError" ? (
        <PickerMessage error onRetry={reload} />
      ) : !loaded ? (
        <div className="mt-3">
          <PickerSkeleton />
        </div>
      ) : matches.length === 0 ? (
        <PickerMessage />
      ) : null}
      <IntroVideoCatalogPagination
        hasNext={hasNext}
        loading={paging.state === "loading"}
        error={paging.state === "hasError" ? paging.error : null}
        onLoadMore={() => {
          detach(loadMore(pageSignal), Reason.DomCallback);
        }}
        onReload={reload}
        onSentinelRef={setSentinelRef}
      />
    </>
  );
}

function VoiceLibraryView({ signals }: PickerProps) {
  const { t } = useTranslation();
  const selection = useGet(signals.voice$);
  const setSelection = useSet(signals.setVoice$);
  const query = useGet(signals.libraryQuery$);
  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <PanelLibrarySearch
            signals={signals}
            label={t(($) => {
              return $.chat.introVideo.picker.searchVoices;
            })}
          />
        </div>
        <VoiceLibraryToolbar />
      </div>
      <VoiceLibraryContent
        query={query}
        header={
          <>
            <DefaultVoiceRow signals={signals} />
            <NoVoiceoverRow signals={signals} />
          </>
        }
        selectedVoiceId={
          selection.kind === "catalog" ? selection.voice.id : undefined
        }
        onSelect={(voice) => {
          setSelection({ kind: "catalog", voice });
        }}
      />
    </>
  );
}

/**
 * The advanced settings, floating 8px inside the dialog rather than docked to
 * its edge. Its close control is the shared 36px `IconButton` the dialog uses
 * for its own, and it lands on the same optical position, so the one × in that
 * corner never changes size or moves when the layer opens; it closes the top
 * layer first, which is what a stacked layer is expected to do. The radius is
 * derived from the dialog's: inner = outer (16) − gap (8).
 */
function OptionsPanel({ signals }: PickerProps) {
  const { t } = useTranslation();
  const view = useGet(signals.panelView$);
  const setView = useSet(signals.setPanelView$);
  const setPanelOpen = useSet(signals.setPanelOpen$);
  const resetOptions = useSet(signals.resetOptions$);
  return (
    <aside
      id="intro-video-options"
      data-intro-video-options={view}
      aria-label={t(($) => {
        return $.chat.introVideo.picker.settings;
      })}
      className={cn(
        "absolute inset-y-2 right-2 z-20 flex flex-col overflow-hidden rounded-lg border border-border bg-card",
        "shadow-[0_8px_24px_-12px_rgba(0,0,0,0.12)] dark:shadow-[0_12px_32px_-12px_rgba(0,0,0,0.5)]",
        "motion-safe:animate-intro-video-options-in",
        OPTIONS_PANEL_WIDTH,
      )}
    >
      <header className="flex h-[52px] shrink-0 items-center gap-1 border-b border-border px-2">
        {view === "root" ? null : (
          <IconButton
            type="button"
            aria-label={t(($) => {
              return $.chat.introVideo.picker.back;
            })}
            onClick={() => {
              setView("root");
            }}
          >
            <ChevronLeft size={18} />
          </IconButton>
        )}
        <p className="min-w-0 flex-1 truncate px-2 text-sm font-semibold">
          {t(($) => {
            return view === "voice"
              ? $.chat.introVideo.picker.allVoices
              : view === "avatar"
                ? $.chat.introVideo.picker.allPresenters
                : $.chat.introVideo.picker.moreOptions;
          })}
        </p>
        <IconButton
          type="button"
          aria-label={t(($) => {
            return $.chat.introVideo.picker.closeOptions;
          })}
          onClick={() => {
            setPanelOpen(false);
          }}
        >
          <X size={20} />
        </IconButton>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4">
        {view === "voice" ? (
          <VoiceLibraryView signals={signals} />
        ) : view === "avatar" ? (
          <AvatarLibraryView signals={signals} />
        ) : (
          <OptionsRootView signals={signals} />
        )}
      </div>
      <footer className="flex h-[56px] shrink-0 items-center gap-2 border-t border-border px-4">
        {view === "root" ? (
          <Button type="button" variant="quiet" onClick={resetOptions}>
            <RotateCcw size={15} />
            {t(($) => {
              return $.chat.introVideo.picker.reset;
            })}
          </Button>
        ) : null}
        <Button
          type="button"
          className="ml-auto"
          onClick={() => {
            setPanelOpen(false);
          }}
        >
          {t(($) => {
            return $.chat.introVideo.picker.done;
          })}
        </Button>
      </footer>
    </aside>
  );
}

/**
 * What the template will produce, stated where the primary action is. Each
 * value is the way back into the layer that owns it — while the layer is open
 * it already says both, so the footer stops repeating them.
 */
function SelectionSummary({ signals }: PickerProps) {
  const { t } = useTranslation();
  const voice = useGet(signals.voice$);
  const avatar = useGet(signals.avatar$);
  const setView = useSet(signals.setPanelView$);
  return (
    <div
      data-intro-video-summary=""
      className="hidden min-w-0 flex-1 items-center gap-1 @[560px]/panel:flex"
    >
      <Button
        type="button"
        variant="quiet"
        size="sm"
        className="min-w-0 gap-1.5 px-2 text-[13px] font-normal"
        onClick={() => {
          setView("root");
        }}
      >
        <Volume2 size={15} />
        <span className="shrink-0 text-muted-foreground">
          {t(($) => {
            return $.chat.introVideo.voice.label;
          })}
        </span>
        <span className="min-w-0 truncate font-medium">
          {voiceSelectionLabel(t, voice, avatar)}
        </span>
      </Button>
      <Button
        type="button"
        variant="quiet"
        size="sm"
        className="min-w-0 gap-1.5 px-2 text-[13px] font-normal"
        onClick={() => {
          setView("root");
        }}
      >
        <UserRound size={15} />
        <span className="shrink-0 text-muted-foreground">
          {t(($) => {
            return $.chat.introVideo.avatar.label;
          })}
        </span>
        <span className="min-w-0 truncate font-medium">
          {avatarSelectionLabel(t, avatar)}
        </span>
      </Button>
    </div>
  );
}

export function IntroVideoPicker({
  signals,
  onSelect,
  onCancel,
}: PickerProps & {
  readonly onSelect: (template: GenerationTemplateRequest) => void;
  readonly onCancel: () => void;
}) {
  const { t } = useTranslation();
  const template = useGet(signals.template$);
  const style = useGet(signals.style$);
  const group = useGet(signals.group$);
  const query = useGet(signals.query$).trim().toLowerCase();
  const panelOpen = useGet(signals.panelOpen$);
  const catalog = useLoadable(introVideoStyleGallerySignals.catalog$);
  const all = catalog.state === "hasData" ? catalog.data : [];
  const items = all.filter((item) => {
    const matchesGroup =
      group === "all" ||
      (group === "other"
        ? !INTRO_VIDEO_STYLE_TAGS.some((tag) => {
            return item.tags.includes(tag);
          })
        : item.tags.includes(group));
    return (
      matchesGroup && (query === "" || item.name.toLowerCase().includes(query))
    );
  });
  const hasOther = all.some((item) => {
    return !INTRO_VIDEO_STYLE_TAGS.some((tag) => {
      return item.tags.includes(tag);
    });
  });
  const hiddenSelection =
    style?.kind === "catalog" &&
    !items.some((item) => {
      return item.id === style.style.id;
    })
      ? style.style.name
      : null;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        className={cn(
          "@container/panel flex min-h-0 flex-1 flex-col",
          "transition-[padding] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]",
          panelOpen && OPTIONS_PANEL_RESERVE,
        )}
      >
        <StyleToolbar signals={signals} />
        <StyleFilterRow
          signals={signals}
          hasOther={hasOther}
          ready={catalog.state === "hasData"}
          shown={items.length}
          total={all.length}
          hiddenSelection={hiddenSelection}
        />
        <StyleGallery
          signals={signals}
          items={items}
          loading={catalog.state === "loading"}
          error={catalog.state === "hasError"}
        />
        <footer className="flex h-[60px] shrink-0 items-center gap-2 border-t border-border px-4 sm:px-6">
          {panelOpen ? null : <SelectionSummary signals={signals} />}
          <div className="flex-1" />
          <Button
            type="button"
            variant="outline"
            className="hidden shrink-0 @[560px]/panel:inline-flex"
            onClick={onCancel}
          >
            {t(($) => {
              return $.chat.introVideo.footer.cancel;
            })}
          </Button>
          <Button
            type="button"
            disabled={!template}
            className="shrink-0"
            onClick={() => {
              if (template) {
                onSelect(template);
              }
            }}
          >
            {style?.kind === "catalog"
              ? t(
                  ($) => {
                    return $.chat.introVideo.picker.useStyle;
                  },
                  { name: style.style.name },
                )
              : t(($) => {
                  return $.chat.introVideo.picker.pickStyle;
                })}
            <ArrowRight size={15} />
          </Button>
        </footer>
      </div>
      {panelOpen ? <OptionsPanel signals={signals} /> : null}
    </div>
  );
}
