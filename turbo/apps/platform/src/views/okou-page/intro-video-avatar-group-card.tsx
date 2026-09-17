import type { IntroVideoAvatar } from "@okouai/api-contracts/contracts/intro-video-presenter";
import { Button, cn } from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import { Check, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  introVideoAvatarGroupSignals,
  type IntroVideoAvatarGroup,
} from "../../signals/okou-page/intro-video-avatar-groups.ts";
import {
  setIntroVideoAvatarThumbnailRef$,
  settleIntroVideoAvatarPreview$,
} from "../../signals/okou-page/intro-video-avatar-media.ts";

function LookThumbnails({
  group,
  active,
}: {
  readonly group: IntroVideoAvatarGroup;
  readonly active: IntroVideoAvatar;
}) {
  const { t } = useTranslation();
  const previewLook = useSet(introVideoAvatarGroupSignals.previewLook$);
  const setThumbnailRef = useSet(setIntroVideoAvatarThumbnailRef$);
  return (
    <div className="flex gap-1.5 overflow-x-auto overscroll-x-contain p-2.5 sm:p-3">
      {group.looks.map((look) => {
        return (
          <button
            key={look.id}
            type="button"
            aria-label={t(
              ($) => {
                return $.chat.introVideo.avatar.previewLook;
              },
              {
                name: look.name,
              },
            )}
            aria-pressed={look.id === active.id}
            title={look.name}
            className={cn(
              "size-11 shrink-0 overflow-hidden rounded-lg border-(length:--border-width-emphasis) bg-muted transition-colors hover:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              look.id === active.id ? "border-primary" : "border-transparent",
            )}
            onClick={() => {
              previewLook({ groupId: group.id, lookId: look.id });
            }}
          >
            {look.previewImageUrl ? (
              <img
                ref={setThumbnailRef}
                data-src={look.previewImageUrl}
                data-intro-video-avatar-thumbnail=""
                alt=""
                loading="lazy"
                decoding="async"
                fetchPriority="low"
                className="h-full w-full object-contain"
              />
            ) : (
              <UserRound size={18} className="mx-auto text-muted-foreground" />
            )}
          </button>
        );
      })}
    </div>
  );
}

export function IntroVideoAvatarGroupCard({
  group,
  selected,
  onSelect,
}: {
  readonly group: IntroVideoAvatarGroup;
  readonly selected: IntroVideoAvatar | undefined;
  readonly onSelect: (avatar: IntroVideoAvatar) => void;
}) {
  const { t } = useTranslation();
  const settlePreview = useSet(settleIntroVideoAvatarPreview$);
  const previews = useGet(introVideoAvatarGroupSignals.previewLookIds$);
  const selectedLook = selected?.groupId === group.id ? selected : undefined;
  const avatar =
    group.looks.find((look) => {
      return look.id === previews[group.id];
    }) ??
    selectedLook ??
    group.looks[0];
  const namePrefix = `${group.name} in `;
  const lookName = avatar.name.startsWith(namePrefix)
    ? avatar.name.slice(namePrefix.length)
    : avatar.name;
  return (
    <div
      data-intro-video-avatar-group={group.id}
      className={cn(
        "min-w-0 overflow-hidden rounded-xl border bg-card transition-colors hover:border-foreground/20",
        selectedLook ? "border-primary" : "border-border",
      )}
    >
      <div className="aspect-[4/3] overflow-hidden bg-muted">
        {avatar.previewImageUrl ? (
          <img
            key={avatar.id}
            src={avatar.previewImageUrl}
            data-intro-video-avatar-preview=""
            alt={avatar.name}
            loading="lazy"
            decoding="async"
            fetchPriority="high"
            className="h-full w-full object-contain"
            onLoad={(event) => {
              settlePreview(event.currentTarget);
            }}
            onError={(event) => {
              settlePreview(event.currentTarget);
            }}
          />
        ) : (
          <span className="grid h-full place-items-center text-muted-foreground">
            <UserRound size={32} />
          </span>
        )}
      </div>
      <LookThumbnails group={group} active={avatar} />
      <div className="flex min-h-12 items-center gap-2 px-2.5 pb-2.5 sm:px-3 sm:pb-3">
        <div className="min-w-0 flex-1">
          <strong className="block truncate text-sm font-medium text-foreground">
            {group.name}
          </strong>
          <span
            className="mt-0.5 block truncate text-xs text-muted-foreground"
            title={avatar.name}
          >
            {lookName}
          </span>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          aria-pressed={selectedLook?.id === avatar.id}
          aria-label={`${t(($) => {
            return $.chat.introVideo.avatar.heading;
          })}: ${avatar.name}`}
          onClick={() => {
            onSelect(avatar);
          }}
        >
          {selectedLook?.id === avatar.id ? <Check size={13} /> : null}
          {t(($) => {
            return $.artifacts.templates.use;
          })}
        </Button>
      </div>
    </div>
  );
}
