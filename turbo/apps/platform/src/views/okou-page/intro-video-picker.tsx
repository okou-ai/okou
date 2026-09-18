import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import { Button, Input, Skeleton, cn } from "@okouai/ui";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import {
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
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
import { groupIntroVideoAvatars } from "../../signals/okou-page/intro-video-avatar-groups.ts";
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
import {
  VOICE_PREVIEW_CARD_CLASS,
  VOICE_PREVIEW_CARD_PROPS,
  type VoiceCardVoice,
  VoiceLibraryContent,
  VoiceLibraryToolbar,
  VoicePreviewControl,
} from "./avatar-template-picker.tsx";
import {
  avatarSelectionLabel,
  voiceSelectionLabel,
} from "./intro-video-selection-labels.ts";

/**
 * Width of the advanced options layer, plus the 8px of air it keeps on its
 * right edge and the 8px gutter between it and the gallery. The gallery section
 * reserves the whole figure as padding, so the panel floats over empty space
 * rather than over cards.
 */
const OPTIONS_PANEL_WIDTH = "w-[344px]";
const OPTIONS_PANEL_RESERVE = "pr-[360px]";

interface PickerProps {
  readonly signals: IntroVideoPickerSignals;
}

function PickerOptionBody({
  leading,
  title,
  description,
  selected,
}: {
  readonly leading: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly selected: boolean;
}) {
  return (
    <>
      {leading}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-1 block text-xs font-normal text-muted-foreground">
          {description}
        </span>
      </span>
      {selected && (
        <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
          <Check size={12} />
        </span>
      )}
    </>
  );
}

function PickerOption({
  title,
  description,
  icon,
  selected,
  onSelect,
}: {
  readonly title: string;
  readonly description: string;
  readonly icon: ReactNode;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "h-auto w-full justify-start gap-3 whitespace-normal rounded-xl border-border bg-card p-3 text-left hover:bg-state-hover",
        selected && "border-primary",
      )}
    >
      <PickerOptionBody
        leading={
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-state-hover text-muted-foreground">
            {icon}
          </span>
        }
        title={title}
        description={description}
        selected={selected}
      />
    </Button>
  );
}

/**
 * The avatar's own voice, auditionable like a library voice. A preview button
 * cannot nest inside the plain option's `Button`, so this row owns the same
 * card contract the library cards use and keeps selection on the row itself.
 */
function AvatarVoicePickerOption({
  voice,
  title,
  description,
  selected,
  onSelect,
}: {
  readonly voice: VoiceCardVoice;
  readonly title: string;
  readonly description: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <div
      {...VOICE_PREVIEW_CARD_PROPS}
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
        VOICE_PREVIEW_CARD_CLASS,
        "flex w-full cursor-pointer items-center gap-3 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "border-primary",
      )}
    >
      <PickerOptionBody
        leading={<VoicePreviewControl voice={voice} />}
        title={title}
        description={description}
        selected={selected}
      />
    </div>
  );
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
    <div className="grid grid-cols-2 gap-3 @[560px]/panel:grid-cols-3">
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

function StyleTags({
  signals,
  hasOther,
}: PickerProps & { readonly hasOther: boolean }) {
  const { t } = useTranslation();
  const labels = useIntroVideoStyleGroupLabels();
  const group = useGet(signals.group$);
  const setGroup = useSet(signals.setGroup$);
  return (
    <TemplateFilterPillRow
      className="shrink-0 px-4 sm:px-6"
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
  );
}

function StyleGallery({ signals }: PickerProps) {
  const catalog = useLoadable(introVideoStyleGallerySignals.catalog$);
  const reload = useSet(introVideoStyleGallerySignals.reload$);
  const style = useGet(signals.style$);
  const setStyle = useSet(signals.setStyle$);
  const group = useGet(signals.group$);
  const query = useGet(signals.query$).trim().toLowerCase();
  const items =
    catalog.state === "hasData"
      ? catalog.data.filter((item) => {
          const matchesGroup =
            group === "all" ||
            (group === "other"
              ? !INTRO_VIDEO_STYLE_TAGS.some((tag) => {
                  return item.tags.includes(tag);
                })
              : item.tags.includes(group));
          return (
            matchesGroup &&
            (query === "" || item.name.toLowerCase().includes(query))
          );
        })
      : [];
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        data-intro-video-catalog-scroll=""
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-6 pt-4 sm:px-6"
      >
        {catalog.state === "hasError" ? (
          <PickerMessage error onRetry={reload} />
        ) : catalog.state === "loading" ? (
          <PickerSkeleton />
        ) : items.length === 0 ? (
          <PickerMessage />
        ) : (
          // Columns follow the section's own width, not the viewport: the
          // options panel takes 360px off it while the window never changes.
          <div className="grid grid-cols-2 items-start gap-3 @[560px]/panel:grid-cols-3 @[880px]/panel:grid-cols-4">
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
      {/* Soften the hard clip where cards scroll up under the filter row; the
          workflow tab draws the same wash under its own pills. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-6 bg-gradient-to-b from-card to-transparent" />
    </div>
  );
}

function StylePicker({ signals }: PickerProps) {
  const { t } = useTranslation();
  const catalog = useLoadable(introVideoStyleGallerySignals.catalog$);
  const panelOpen = useGet(signals.panelOpen$);
  const setPanelOpen = useSet(signals.setPanelOpen$);
  const hasOther =
    catalog.state === "hasData" &&
    catalog.data.some((item) => {
      return !INTRO_VIDEO_STYLE_TAGS.some((tag) => {
        return item.tags.includes(tag);
      });
    });
  return (
    <>
      {/* 68px, the height the sibling tabs' toolbar row states, so the search
          box does not move when the category changes. */}
      <div className="flex h-[68px] shrink-0 items-center gap-3 px-4 sm:px-6 sm:pr-14">
        <StyleSearch signals={signals} />
        <Button
          type="button"
          variant="outline"
          aria-expanded={panelOpen}
          onClick={() => {
            setPanelOpen(!panelOpen);
          }}
          className="ml-auto shrink-0 gap-2"
        >
          <SlidersHorizontal size={16} />
          {t(($) => {
            return $.chat.introVideo.picker.moreOptions;
          })}
        </Button>
      </div>
      <StyleTags signals={signals} hasOther={hasOther} />
      <StyleGallery signals={signals} />
    </>
  );
}

function AvatarPicker({ signals }: PickerProps) {
  const { t } = useTranslation();
  const selection = useGet(signals.avatar$);
  const setSelection = useSet(signals.setAvatar$);
  const catalog = useLoadable(introVideoAvatarPickerSignals.catalogPage$);
  const lastCatalog = useLastResolved(
    introVideoAvatarPickerSignals.catalogPage$,
  );
  const generation = useGet(introVideoAvatarPickerSignals.generation$);
  const paging = useLoadable(introVideoAvatarPickerSignals.paging$);
  const loadMore = useSet(introVideoAvatarPickerSignals.loadMore$);
  const setSentinelRef = useSet(introVideoAvatarPickerSignals.setSentinelRef$);
  const reload = useSet(introVideoAvatarPickerSignals.reload$);
  const pageSignal = useGet(pageSignal$);
  const visible =
    catalog.state === "hasData"
      ? catalog.data
      : lastCatalog?.generation === generation
        ? lastCatalog
        : undefined;
  const groups = visible ? groupIntroVideoAvatars(visible.items) : [];
  return (
    <>
      <div className="flex shrink-0 items-center gap-2 px-3 pb-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-pressed={selection.kind === "none"}
          onClick={() => {
            setSelection({ kind: "none" });
          }}
          className={cn(
            "gap-2 border-border px-2.5 text-xs",
            selection.kind === "none" && "border-primary bg-state-selected",
          )}
        >
          <UserRoundX size={14} />
          {t(($) => {
            return $.chat.introVideo.avatar.none;
          })}
        </Button>
      </div>
      <div
        data-intro-video-catalog-scroll=""
        className="min-h-0 flex-1 overflow-y-auto px-3 pb-3"
      >
        <div className="grid grid-cols-2 items-stretch gap-3">
          {groups.map((group) => {
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
        ) : visible === undefined ? (
          <div className="mt-3">
            <PickerSkeleton />
          </div>
        ) : groups.length === 0 ? (
          <PickerMessage />
        ) : null}
        <IntroVideoCatalogPagination
          hasNext={visible?.hasNext ?? false}
          loading={paging.state === "loading"}
          error={paging.state === "hasError" ? paging.error : null}
          onLoadMore={() => {
            detach(loadMore(pageSignal), Reason.DomCallback);
          }}
          onReload={reload}
          onSentinelRef={setSentinelRef}
        />
      </div>
    </>
  );
}

function VoicePicker({ signals }: PickerProps) {
  const { t } = useTranslation();
  const avatar = useGet(signals.avatar$);
  const selection = useGet(signals.voice$);
  const setSelection = useSet(signals.setVoice$);
  const defaultVoiceTitle = t(($) => {
    return avatar.kind === "none"
      ? $.chat.introVideo.voice.auto
      : $.chat.introVideo.picker.avatarVoice;
  });
  const defaultVoiceDescription = t(($) => {
    return avatar.kind === "none"
      ? $.chat.introVideo.picker.autoVoiceDescription
      : $.chat.introVideo.voice.defaultDescription;
  });
  const defaultVoiceSample: VoiceCardVoice | undefined =
    avatar.kind === "catalog" && avatar.avatar.defaultVoiceSampleUrl
      ? {
          id: avatar.avatar.defaultVoiceId,
          name: avatar.avatar.defaultVoiceName ?? defaultVoiceTitle,
          sampleUrl: avatar.avatar.defaultVoiceSampleUrl,
        }
      : undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-3 pb-3">
      <div className="flex shrink-0 justify-end">
        <VoiceLibraryToolbar />
      </div>
      <VoiceLibraryContent
        header={
          <>
            {defaultVoiceSample ? (
              <AvatarVoicePickerOption
                voice={defaultVoiceSample}
                title={defaultVoiceTitle}
                description={defaultVoiceDescription}
                selected={selection.kind === "default"}
                onSelect={() => {
                  setSelection({ kind: "default" });
                }}
              />
            ) : (
              <PickerOption
                title={defaultVoiceTitle}
                description={defaultVoiceDescription}
                icon={<Volume2 size={17} />}
                selected={selection.kind === "default"}
                onSelect={() => {
                  setSelection({ kind: "default" });
                }}
              />
            )}
            <PickerOption
              title={t(($) => {
                return $.chat.introVideo.voice.none;
              })}
              description={t(($) => {
                return $.chat.introVideo.voice.noneDescription;
              })}
              icon={<VolumeX size={17} />}
              selected={selection.kind === "none"}
              onSelect={() => {
                setSelection({ kind: "none" });
              }}
            />
          </>
        }
        selectedVoiceId={
          selection.kind === "catalog" ? selection.voice.id : undefined
        }
        onSelect={(voice) => {
          setSelection({ kind: "catalog", voice });
        }}
      />
    </div>
  );
}

/**
 * The panel's first screen: what the two optional settings are currently worth,
 * and a way into each library. Reading the value here is the point — the user
 * never has to open a library to find out what they are getting.
 */
function OptionsRow({
  icon,
  label,
  value,
  onSelect,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly value: string;
  readonly onSelect: () => void;
}) {
  return (
    <Button
      type="button"
      variant="quiet"
      aria-label={label}
      onClick={onSelect}
      className="h-auto w-full justify-start gap-3 rounded-lg px-2 py-2.5 text-left hover:bg-state-hover"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-state-hover text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{label}</span>
        <span className="mt-0.5 block truncate text-xs font-normal text-muted-foreground">
          {value}
        </span>
      </span>
      <ChevronRight size={16} className="shrink-0 text-muted-foreground" />
    </Button>
  );
}

function OptionsRootView({ signals }: PickerProps) {
  const { t } = useTranslation();
  const avatar = useGet(signals.avatar$);
  const voice = useGet(signals.voice$);
  const setView = useSet(signals.setPanelView$);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      <OptionsRow
        icon={<Volume2 size={17} />}
        label={t(($) => {
          return $.chat.introVideo.voice.label;
        })}
        value={voiceSelectionLabel(t, voice, avatar)}
        onSelect={() => {
          setView("voice");
        }}
      />
      <OptionsRow
        icon={<UserRound size={17} />}
        label={t(($) => {
          return $.chat.introVideo.avatar.label;
        })}
        value={avatarSelectionLabel(t, avatar)}
        onSelect={() => {
          setView("avatar");
        }}
      />
    </div>
  );
}

/**
 * The advanced settings, floating 8px inside the dialog rather than docked to
 * its edge. Two close buttons in one corner were the confusion; making the
 * layers visibly separate — inset, own radius, own shadow — is what resolves
 * it. The radius is derived from the dialog's: inner = outer (16) − gap (8).
 */
function OptionsPanel({ signals }: PickerProps) {
  const { t } = useTranslation();
  const view = useGet(signals.panelView$);
  const setView = useSet(signals.setPanelView$);
  const setPanelOpen = useSet(signals.setPanelOpen$);
  return (
    <aside
      data-intro-video-options={view}
      aria-label={t(($) => {
        return $.chat.introVideo.picker.settings;
      })}
      className={cn(
        "absolute inset-y-2 right-2 z-20 flex flex-col overflow-hidden rounded-lg border border-border bg-card",
        "shadow-[0_8px_24px_-12px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.5)]",
        "motion-safe:animate-intro-video-options-in",
        OPTIONS_PANEL_WIDTH,
      )}
    >
      <header className="flex shrink-0 items-center gap-1 p-2">
        {view === "root" ? null : (
          <Button
            type="button"
            variant="quiet"
            size="icon-sm"
            aria-label={t(($) => {
              return $.chat.introVideo.picker.back;
            })}
            onClick={() => {
              setView("root");
            }}
          >
            <ChevronLeft size={16} />
          </Button>
        )}
        <h3
          className={cn(
            "min-w-0 flex-1 truncate text-sm font-medium",
            view === "root" && "pl-2",
          )}
        >
          {t(($) => {
            return view === "voice"
              ? $.chat.introVideo.voice.heading
              : view === "avatar"
                ? $.chat.introVideo.avatar.heading
                : $.chat.introVideo.picker.moreOptions;
          })}
        </h3>
        <Button
          type="button"
          variant="quiet"
          size="icon-sm"
          aria-label={t(($) => {
            return $.chat.introVideo.picker.closeOptions;
          })}
          onClick={() => {
            setPanelOpen(false);
          }}
        >
          <X size={16} />
        </Button>
      </header>
      {view === "voice" ? (
        <VoicePicker signals={signals} />
      ) : view === "avatar" ? (
        <AvatarPicker signals={signals} />
      ) : (
        <OptionsRootView signals={signals} />
      )}
    </aside>
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
  const avatar = useGet(signals.avatar$);
  const voice = useGet(signals.voice$);
  const panelOpen = useGet(signals.panelOpen$);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        className={cn(
          "@container/panel flex min-h-0 flex-1 flex-col",
          "transition-[padding] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]",
          panelOpen && OPTIONS_PANEL_RESERVE,
        )}
      >
        <StylePicker signals={signals} />
        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-4 py-3 sm:px-6">
          <p
            data-intro-video-summary=""
            className="min-w-0 truncate text-xs text-muted-foreground"
          >
            {style
              ? t(
                  ($) => {
                    return $.chat.introVideo.picker.selectionSummary;
                  },
                  {
                    voice: voiceSelectionLabel(t, voice, avatar),
                    avatar: avatarSelectionLabel(t, avatar),
                  },
                )
              : t(($) => {
                  return $.chat.introVideo.picker.chooseStyle;
                })}
          </p>
          <div className="flex shrink-0 gap-2">
            <Button
              type="button"
              variant="outline"
              className="hidden sm:inline-flex"
              onClick={onCancel}
            >
              {t(($) => {
                return $.chat.introVideo.footer.cancel;
              })}
            </Button>
            <Button
              type="button"
              disabled={!template}
              onClick={() => {
                if (template) {
                  onSelect(template);
                }
              }}
            >
              {t(($) => {
                return $.chat.introVideo.picker.useSelection;
              })}
              <ArrowRight size={15} />
            </Button>
          </div>
        </footer>
      </div>
      {panelOpen ? <OptionsPanel signals={signals} /> : null}
    </div>
  );
}
