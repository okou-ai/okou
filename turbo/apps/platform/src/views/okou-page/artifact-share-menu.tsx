import type { KeyboardEvent } from "react";
import type { ArtifactShareStatus } from "@okouai/api-contracts/contracts/artifact-shares";
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
  Skeleton,
  cn,
} from "@okouai/ui";
import { useTranslation } from "react-i18next";
import {
  getArtifactShareScope,
  type ArtifactShareSession,
} from "../../signals/artifact-sharing.ts";
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
  ) {
    return;
  }
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      '[role="radio"]:not(:disabled)',
    ),
  ];
  const index = items.findIndex((item) => {
    return item === event.target;
  });
  if (index === -1) {
    return;
  }
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

function PermissionChoices({
  selected,
  organizationName,
  saving,
  onChange,
}: {
  readonly selected: ArtifactShareStatus["audience"] | undefined;
  readonly organizationName: string;
  readonly saving: boolean;
  readonly onChange: (audience: ArtifactShareStatus["audience"]) => void;
}) {
  const { t } = useTranslation();
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
          organization: organizationName,
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
            aria-checked={selected === audience}
            tabIndex={selected === audience ? 0 : -1}
            aria-busy={selected === audience && saving}
            className={cn(
              "flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-state-hover",
              selected === audience && "bg-state-hover",
            )}
            onClick={() => {
              return onChange(audience);
            }}
          >
            <Icon size={18} className="shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{label}</span>
              <span className="block text-xs text-muted-foreground">
                {description}
              </span>
            </span>
            {selected === audience &&
              (saving ? (
                <Loader2 size={16} className="shrink-0 animate-spin" />
              ) : (
                <Check size={16} className="shrink-0" />
              ))}
          </button>
        );
      })}
    </div>
  );
}

function ShareFooter({
  saving,
  failed,
  copying,
  ready,
  onRetry,
  onCopy,
}: {
  readonly saving: boolean;
  readonly failed: boolean;
  readonly copying: boolean;
  readonly ready: boolean;
  readonly onRetry: () => void;
  readonly onCopy: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-2 flex items-center justify-between gap-3 border-t border-divider px-3 pb-2 pt-4">
      <span className="text-xs text-muted-foreground" role="status">
        {saving
          ? t(($) => {
              return $.artifacts.sharing.saving;
            })
          : failed
            ? t(($) => {
                return $.artifacts.sharing.loadFailed;
              })
            : t(($) => {
                return $.artifacts.sharing.savedAutomatically;
              })}
      </span>
      {failed ? (
        <Button
          size="sm"
          onClick={() => {
            return onRetry();
          }}
        >
          {t(($) => {
            return $.artifacts.sharing.retry;
          })}
        </Button>
      ) : (
        <Button
          size="sm"
          disabled={copying || !ready}
          onClick={() => {
            return onCopy();
          }}
        >
          {copying ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Copy size={14} />
          )}
          {t(($) => {
            return $.artifacts.sharing.copyLink;
          })}
        </Button>
      )}
    </div>
  );
}

function ShareSkeleton() {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      aria-label={t(($) => {
        return $.artifacts.sharing.loadingPermissions;
      })}
      className="space-y-1"
    >
      {[0, 1, 2].map((index) => {
        return (
          <div key={index} className="flex items-center gap-3 px-3 py-3">
            <Skeleton className="size-[18px] rounded" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-24 rounded" />
              <Skeleton className="h-3 w-48 rounded" />
            </div>
          </div>
        );
      })}
      <div className="flex justify-end border-t border-divider px-3 pb-2 pt-4">
        <Skeleton className="h-8 w-28 rounded-lg" />
      </div>
    </div>
  );
}

interface ShareButtonProps {
  readonly className?: string;
  readonly iconSize?: number;
  readonly ariaLabel?: string;
}

function ShareSessionMenu({
  session,
  className,
  iconSize = 16,
  ariaLabel,
}: ShareButtonProps & { readonly session: ArtifactShareSession }) {
  const { t } = useTranslation();
  // Subscribing as soon as the preview mounts preloads permissions before Share.
  const loadable = useLoadable(session.details$);
  const details = useLastResolved(session.details$);
  const draft = useGet(session.draft$);
  const requestedOpen = useGet(session.open$);
  const signal = useGet(session.signal$);
  const open = useSet(session.show$);
  const close = useSet(session.close$);
  const change = useSet(session.change$);
  const refresh = useSet(session.refresh$);
  const [copying, copy] = useLoadableSet(session.copy$);
  const title = t(($) => {
    return $.artifacts.actions.share;
  });
  if (!signal) {
    throw new Error("Artifact sharing session is not mounted");
  }
  const recipient = loadable.state === "hasData" && !loadable.data?.status;
  return (
    <Popover
      open={requestedOpen && !recipient}
      onOpenChange={(next) => {
        if (next) {
          detach(open(signal), Reason.DomCallback);
        } else {
          close();
        }
      }}
    >
      <PopoverTrigger
        aria-label={ariaLabel ?? title}
        render={<Button variant="quiet" size="icon-sm" className={className} />}
      >
        <Share2 size={iconSize} />
      </PopoverTrigger>
      <PopoverContent
        aria-label={title}
        align="end"
        className="w-[368px] max-w-[calc(100vw-32px)] rounded-3xl border border-divider bg-card p-2"
      >
        <div className="flex items-center justify-between px-3 pb-2 pt-2">
          <h2 className="text-sm font-semibold">{title}</h2>
          <PopoverClose
            aria-label={t(($) => {
              return $.artifacts.actions.close;
            })}
            render={<Button variant="quiet" size="icon-sm" />}
          >
            <X size={16} />
          </PopoverClose>
        </div>
        {!details && loadable.state === "loading" ? (
          <ShareSkeleton />
        ) : (
          <>
            {details?.status && (
              <PermissionChoices
                selected={draft?.audience ?? details.audience}
                organizationName={details.status.organization.name}
                saving={draft !== null}
                onChange={(audience) => {
                  return detach(change(audience, signal), Reason.DomCallback);
                }}
              />
            )}
            <ShareFooter
              saving={draft !== null}
              failed={loadable.state === "hasError"}
              copying={copying.state === "loading"}
              ready={Boolean(details?.status)}
              onRetry={() => {
                return detach(refresh(signal), Reason.DomCallback);
              }}
              onCopy={() => {
                return detach(copy(signal), Reason.DomCallback);
              }}
            />
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function ArtifactShareMenu({
  url,
  surface,
  copyUrl,
  ...buttonProps
}: ShareButtonProps & {
  readonly url: string;
  readonly surface: "dialog" | "sidebar" | "viewer";
  readonly copyUrl?: string;
}) {
  const { t } = useTranslation();
  const scope = getArtifactShareScope(surface);
  const session = useGet(scope.session$);
  const mountRef = useSet(scope.mountRef$);
  return (
    <span
      key={`${url}:${copyUrl ?? ""}`}
      ref={mountRef}
      data-share-url={url}
      data-copy-url={copyUrl}
      className="inline-flex"
    >
      {session ? (
        <ShareSessionMenu session={session} {...buttonProps} />
      ) : (
        <Button
          variant="quiet"
          size="icon-sm"
          className={buttonProps.className}
          aria-label={
            buttonProps.ariaLabel ??
            t(($) => {
              return $.artifacts.actions.share;
            })
          }
        >
          <Share2 size={buttonProps.iconSize ?? 16} />
        </Button>
      )}
    </span>
  );
}
