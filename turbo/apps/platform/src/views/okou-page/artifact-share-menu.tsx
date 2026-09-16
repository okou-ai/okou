import { useId, type KeyboardEvent } from "react";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  Check,
  Copy,
  Globe,
  Loader2,
  LockKeyhole,
  Share2,
  Users,
  X,
} from "lucide-react";
import {
  Button,
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
  cn,
} from "@okouai/ui";
import { useTranslation } from "react-i18next";
import {
  artifactShareDetails$,
  artifactShareRequest$,
  changeArtifactAudience$,
  closeArtifactShare$,
  copyArtifactShare$,
  openArtifactShare$,
  refreshArtifactShare$,
} from "../../signals/artifact-sharing.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

function navigatePermissions(event: KeyboardEvent<HTMLDivElement>) {
  if (
    ![
      "ArrowDown",
      "ArrowRight",
      "ArrowUp",
      "ArrowLeft",
      "Home",
      "End",
    ].includes(event.key)
  )
    return;
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      '[role="radio"]:not(:disabled)',
    ),
  ];
  const index = items.findIndex((item) => {
    return item === event.target;
  });
  if (index < 0) return;
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : (index +
            (event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 1) +
            items.length) %
          items.length;
  event.preventDefault();
  items[next]?.focus();
  items[next]?.click();
}

export function ArtifactShareMenu({
  url,
  copyUrl,
  className,
  iconSize = 16,
  ariaLabel,
}: {
  readonly url: string;
  readonly copyUrl?: string;
  readonly className?: string;
  readonly iconSize?: number;
  readonly ariaLabel?: string;
}) {
  const { t } = useTranslation();
  const key = useId();
  const signal = useGet(pageSignal$);
  const request = useGet(artifactShareRequest$);
  const loadable = useLoadable(artifactShareDetails$);
  const last = useLastResolved(artifactShareDetails$);
  const details =
    last?.request === request && request?.key === key ? last : null;
  const [opening, open] = useLoadableSet(openArtifactShare$);
  const [saving, change] = useLoadableSet(changeArtifactAudience$);
  const [copying, copy] = useLoadableSet(copyArtifactShare$);
  const [refreshing, refresh] = useLoadableSet(refreshArtifactShare$);
  const close = useSet(closeArtifactShare$);
  const busy =
    saving.state === "loading" ||
    copying.state === "loading" ||
    refreshing.state === "loading";
  const ready = loadable.state === "hasData";
  const status = details?.status;
  const title = t(($) => {
    return $.artifacts.actions.share;
  });
  const options = [
    {
      audience: "private",
      Icon: LockKeyhole,
      label: t(($) => {
        return $.artifacts.sharing.onlyMe;
      }),
      description: t(($) => {
        return $.artifacts.sharing.onlyMeDescription;
      }),
    },
    {
      audience: "organization",
      Icon: Users,
      label: t(($) => {
        return $.artifacts.sharing.organization;
      }),
      description: t(
        ($) => {
          return $.artifacts.sharing.organizationDescription;
        },
        {
          organization: status?.organization.name ?? "",
        },
      ),
    },
    {
      audience: "public",
      Icon: Globe,
      label: t(($) => {
        return $.artifacts.sharing.publicAccess;
      }),
      description: t(($) => {
        return $.artifacts.sharing.publicDescription;
      }),
    },
  ] as const;
  return (
    <Popover
      open={Boolean(status)}
      onOpenChange={(next) => {
        if (next)
          detach(open({ key, url, copyUrl }, signal), Reason.DomCallback);
        else if (!busy) close();
      }}
    >
      <PopoverTrigger
        disabled={opening.state === "loading"}
        aria-busy={opening.state === "loading"}
        aria-label={ariaLabel ?? title}
        render={<Button variant="quiet" size="icon-sm" className={className} />}
      >
        {opening.state === "loading" ? (
          <Loader2 size={iconSize} className="animate-spin" />
        ) : (
          <Share2 size={iconSize} />
        )}
      </PopoverTrigger>
      <PopoverContent
        aria-label={title}
        align="end"
        className="w-[368px] max-w-[calc(100vw-32px)] rounded-3xl border border-divider bg-card p-2"
      >
        <div className="flex items-center justify-between px-3 pb-2 pt-2">
          <h2 className="text-sm font-semibold">{title}</h2>
          <PopoverClose
            disabled={busy}
            aria-label={t(($) => {
              return $.artifacts.actions.close;
            })}
            render={<Button variant="quiet" size="icon-sm" />}
          >
            <X size={16} />
          </PopoverClose>
        </div>
        <div
          role="radiogroup"
          onKeyDown={navigatePermissions}
          aria-label={t(($) => {
            return $.artifacts.sharing.accessLabel;
          })}
          className="space-y-1"
        >
          {options.map(({ audience, Icon, label, description }) => {
            return (
              <button
                key={audience}
                type="button"
                role="radio"
                aria-checked={details?.audience === audience}
                tabIndex={details?.audience === audience ? 0 : -1}
                disabled={busy || !ready}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-state-hover disabled:pointer-events-none disabled:opacity-60",
                  details?.audience === audience && "bg-state-hover",
                )}
                onClick={() => {
                  return detach(change(audience, signal), Reason.DomCallback);
                }}
              >
                <Icon size={18} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {description}
                  </span>
                </span>
                {details?.audience === audience && (
                  <Check size={16} className="shrink-0" />
                )}
              </button>
            );
          })}
        </div>
        <div className="mt-2 flex items-center justify-between gap-3 border-t border-divider px-3 pb-2 pt-4">
          <span className="text-xs text-muted-foreground" role="status">
            {saving.state === "loading"
              ? t(($) => {
                  return $.artifacts.sharing.saving;
                })
              : loadable.state === "hasError"
                ? t(($) => {
                    return $.artifacts.sharing.loadFailed;
                  })
                : t(($) => {
                    return $.artifacts.sharing.savedAutomatically;
                  })}
          </span>
          {loadable.state === "hasError" ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                return detach(refresh(signal), Reason.DomCallback);
              }}
            >
              {t(($) => {
                return $.artifacts.sharing.retry;
              })}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={busy || !ready}
              onClick={() => {
                return detach(copy(signal), Reason.DomCallback);
              }}
            >
              <Copy size={14} />
              {t(($) => {
                return $.artifacts.sharing.copyLink;
              })}
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
