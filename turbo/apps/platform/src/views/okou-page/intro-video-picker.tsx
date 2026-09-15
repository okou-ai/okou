import type { ReactNode } from "react";
import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import { Button, Skeleton, cn } from "@okouai/ui";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import {
  ArrowRight,
  Check,
  LayoutTemplate,
  UserRound,
  UserRoundX,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  IntroVideoPickerSignals,
  IntroVideoPickerTab,
} from "../../signals/okou-page/intro-video-picker.ts";
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
import {
  VoiceLibraryContent,
  VoiceLibraryToolbar,
} from "./avatar-template-picker.tsx";
import {
  avatarSelectionLabel,
  styleSelectionLabel,
  voiceSelectionLabel,
} from "./intro-video-selection-labels.ts";

interface PickerProps {
  readonly signals: IntroVideoPickerSignals;
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
        "h-auto w-full justify-start gap-3 whitespace-normal rounded-xl border-border bg-card p-3 text-left hover:bg-gray-50",
        selected && "border-primary",
      )}
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-gray-50 text-muted-foreground">
        {icon}
      </span>
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
    </Button>
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
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
      {Array.from({ length: 6 }, (_, index) => {
        return <Skeleton key={index} className="aspect-video rounded-xl" />;
      })}
    </div>
  );
}

function ConfigurationTabs({ signals }: PickerProps) {
  const { t } = useTranslation();
  const tab = useGet(signals.tab$);
  const setTab = useSet(signals.setTab$);
  const style = useGet(signals.style$);
  const avatar = useGet(signals.avatar$);
  const voice = useGet(signals.voice$);
  const tabs = [
    {
      id: "style",
      label: t(($) => {
        return $.chat.introVideo.picker.style;
      }),
      value: style
        ? styleSelectionLabel(t, style)
        : t(($) => {
            return $.chat.introVideo.picker.chooseStyle;
          }),
      Icon: LayoutTemplate,
      selected: style !== null,
    },
    {
      id: "avatar",
      label: t(($) => {
        return $.chat.introVideo.avatar.label;
      }),
      value: avatarSelectionLabel(t, avatar),
      Icon: UserRound,
      selected: true,
    },
    {
      id: "voice",
      label: t(($) => {
        return $.chat.introVideo.voice.label;
      }),
      value: voice
        ? voiceSelectionLabel(t, voice, avatar)
        : t(($) => {
            return $.chat.introVideo.voice.heading;
          }),
      Icon: Volume2,
      selected: voice !== null,
    },
  ] as const;
  return (
    <div
      role="tablist"
      aria-label={t(($) => {
        return $.chat.introVideo.picker.settings;
      })}
      className="grid shrink-0 grid-cols-3 gap-1 border-b border-border px-4 py-2 sm:px-6 sm:pr-14"
    >
      {tabs.map(({ id, label, value, Icon, selected }, index) => {
        return (
          <Button
            key={id}
            type="button"
            role="tab"
            variant="quiet"
            aria-label={label}
            aria-selected={tab === id}
            aria-controls="intro-video-panel"
            tabIndex={tab === id ? 0 : -1}
            onClick={() => {
              setTab(id);
            }}
            onKeyDown={(event) => {
              const nextIndex =
                event.key === "ArrowRight"
                  ? (index + 1) % tabs.length
                  : event.key === "ArrowLeft"
                    ? (index + tabs.length - 1) % tabs.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? tabs.length - 1
                        : null;
              if (nextIndex === null) {
                return;
              }
              event.preventDefault();
              const next = tabs[nextIndex];
              if (next) {
                setTab(next.id);
                const controls =
                  event.currentTarget.parentElement?.querySelectorAll<HTMLElement>(
                    "[role=tab]",
                  );
                controls?.[nextIndex]?.focus();
              }
            }}
            className={cn(
              "relative h-10 min-w-0 justify-start gap-2 rounded-md px-2 py-1 text-left hover:bg-gray-50",
              tab === id &&
                "bg-gray-50 text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-foreground",
            )}
          >
            <Icon className="hidden shrink-0 text-muted-foreground sm:block" />
            <span className="min-w-0 flex-1 sm:flex sm:items-center sm:gap-2">
              <span className="block shrink-0 text-xs font-medium leading-4 sm:text-sm">
                {label}
              </span>
              <span className="block truncate text-[10px] font-normal leading-3 text-muted-foreground sm:text-xs">
                {value}
              </span>
            </span>
            {selected && (
              <Check size={12} className="shrink-0 text-brand-text" />
            )}
          </Button>
        );
      })}
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
  const tags = [
    ...INTRO_VIDEO_STYLE_TAGS.map((id) => {
      return { id, label: labels[id] };
    }),
    ...(hasOther ? [{ id: "other", label: labels.other }] : []),
  ];
  return (
    <div
      role="group"
      aria-label={t(($) => {
        return $.chat.introVideo.style.browseGroups;
      })}
      className="flex shrink-0 flex-wrap gap-2 px-4 pb-3 sm:px-6"
    >
      {tags.map(({ id, label }) => {
        return (
          <Button
            key={id}
            type="button"
            variant="quiet"
            size="xs"
            aria-pressed={group === id}
            onClick={() => {
              setGroup(group === id ? "all" : id);
            }}
            className={cn(
              "rounded-md border border-border bg-background hover:bg-gray-50",
              group === id &&
                "border-primary bg-gray-50 text-foreground ring-1 ring-primary",
            )}
          >
            {label}
          </Button>
        );
      })}
    </div>
  );
}

function StylePicker({ signals }: PickerProps) {
  const { t } = useTranslation();
  const catalog = useLoadable(introVideoStyleGallerySignals.catalog$);
  const reload = useSet(introVideoStyleGallerySignals.reload$);
  const style = useGet(signals.style$);
  const setStyle = useSet(signals.setStyle$);
  const group = useGet(signals.group$);
  const items =
    catalog.state === "hasData"
      ? catalog.data.filter((item) => {
          return (
            group === "all" ||
            (group === "other"
              ? !INTRO_VIDEO_STYLE_TAGS.some((tag) => {
                  return item.tags.includes(tag);
                })
              : item.tags.includes(group))
          );
        })
      : [];
  const hasOther =
    catalog.state === "hasData" &&
    catalog.data.some((item) => {
      return !INTRO_VIDEO_STYLE_TAGS.some((tag) => {
        return item.tags.includes(tag);
      });
    });
  return (
    <>
      <div className="flex min-w-0 shrink-0 items-center gap-2 px-4 py-3 sm:px-6">
        <h3 className="text-xs font-medium">
          {t(($) => {
            return $.chat.introVideo.picker.chooseStyle;
          })}
        </h3>
        {catalog.state === "hasData" && (
          <span className="text-xs text-muted-foreground">{items.length}</span>
        )}
      </div>
      <StyleTags signals={signals} hasOther={hasOther} />
      <div
        key={group}
        data-intro-video-catalog-scroll=""
        className="min-h-0 flex-1 overflow-y-auto px-4 pb-5 sm:px-6"
      >
        {catalog.state === "hasError" ? (
          <PickerMessage error onRetry={reload} />
        ) : catalog.state === "loading" ? (
          <PickerSkeleton />
        ) : items.length === 0 ? (
          <PickerMessage />
        ) : (
          <div className="grid grid-cols-2 items-start gap-3 lg:grid-cols-3">
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
      <div className="flex shrink-0 items-center gap-2 px-4 py-3 sm:px-6">
        <h3 className="sr-only">
          {t(($) => {
            return $.chat.introVideo.avatar.heading;
          })}
        </h3>
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
            selection.kind === "none" && "border-primary bg-gray-50",
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
        className="min-h-0 flex-1 overflow-y-auto px-4 pb-5 sm:px-6"
      >
        <div className="grid grid-cols-2 items-stretch gap-3 lg:grid-cols-3 xl:grid-cols-4">
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
  const setTab = useSet(signals.setTab$);
  return (
    <>
      <div className="flex shrink-0 items-center justify-between gap-2 px-4 py-3 sm:px-6">
        <h3 className="text-sm font-medium">
          {t(($) => {
            return $.chat.introVideo.voice.heading;
          })}
        </h3>
        <VoiceLibraryToolbar />
      </div>
      <div className="flex min-h-0 flex-1 gap-5 px-4 pb-5 sm:px-6">
        <aside className="hidden w-44 shrink-0 self-start overflow-hidden rounded-xl border border-border md:block">
          <div className="grid aspect-square place-items-center bg-gray-50">
            {avatar.kind === "catalog" && avatar.avatar.previewImageUrl ? (
              <img
                src={avatar.avatar.previewImageUrl}
                alt=""
                className="size-full object-contain"
              />
            ) : (
              <UserRoundX size={32} className="text-muted-foreground" />
            )}
          </div>
          <div className="p-3">
            <p className="text-sm font-medium">
              {avatarSelectionLabel(t, avatar)}
            </p>
            <Button
              type="button"
              variant="quiet"
              size="sm"
              className="mt-2"
              onClick={() => {
                setTab("avatar");
              }}
            >
              {t(($) => {
                return $.chat.introVideo.picker.changeAvatar;
              })}
            </Button>
          </div>
        </aside>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          <PickerOption
            title={t(($) => {
              return avatar.kind === "none"
                ? $.chat.introVideo.voice.auto
                : $.chat.introVideo.picker.avatarVoice;
            })}
            description={t(($) => {
              return avatar.kind === "none"
                ? $.chat.introVideo.picker.autoVoiceDescription
                : $.chat.introVideo.voice.defaultDescription;
            })}
            icon={<Volume2 size={17} />}
            selected={selection?.kind === "default"}
            onSelect={() => {
              setSelection({ kind: "default" });
            }}
          />
          <PickerOption
            title={t(($) => {
              return $.chat.introVideo.voice.none;
            })}
            description={t(($) => {
              return $.chat.introVideo.voice.noneDescription;
            })}
            icon={<VolumeX size={17} />}
            selected={selection?.kind === "none"}
            onSelect={() => {
              setSelection({ kind: "none" });
            }}
          />
          <VoiceLibraryContent
            selectedVoiceId={
              selection?.kind === "catalog" ? selection.voice.id : undefined
            }
            onSelect={(voice) => {
              setSelection({ kind: "catalog", voice });
            }}
          />
        </div>
      </div>
    </>
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
  const tab = useGet(signals.tab$);
  const template = useGet(signals.template$);
  const style = useGet(signals.style$);
  const voice = useGet(signals.voice$);
  const panels: Record<IntroVideoPickerTab, ReactNode> = {
    style: <StylePicker signals={signals} />,
    avatar: <AvatarPicker signals={signals} />,
    voice: <VoicePicker signals={signals} />,
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ConfigurationTabs signals={signals} />
      <div
        id="intro-video-panel"
        role="tabpanel"
        aria-label={t(($) => {
          return tab === "style"
            ? $.chat.introVideo.picker.style
            : tab === "avatar"
              ? $.chat.introVideo.avatar.label
              : $.chat.introVideo.voice.label;
        })}
        className="flex min-h-0 flex-1 flex-col"
      >
        {panels[tab]}
      </div>
      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-4 py-3 sm:px-6">
        <p className="text-xs text-muted-foreground">
          {t(($) => {
            return !style && !voice
              ? $.chat.introVideo.picker.chooseStyleAndVoice
              : !style
                ? $.chat.introVideo.picker.chooseStyle
                : !voice
                  ? $.chat.introVideo.voice.heading
                  : $.chat.introVideo.picker.ready;
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
  );
}
