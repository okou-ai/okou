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
import type {
  ArtifactShareIdentity,
  AttachmentPreviewSignals,
} from "../../signals/attachment-resource-url.ts";
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
  unavailable = false,
  onChange,
}: {
  readonly selected: ArtifactShareStatus["audience"] | undefined;
  readonly organizationName: string | null;
  readonly saving: boolean;
  readonly unavailable?: boolean;
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
      // A failed permission read still knows the option exists, but not which
      // workspace it names, so the unnamed wording stands in for it.
      description:
        organizationName === null
          ? t(($) => {
              return $.artifacts.sharing.organizationDescriptionUnnamed;
            })
          : t(
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
            disabled={unavailable}
            tabIndex={selected === audience ? 0 : -1}
            aria-busy={selected === audience && saving}
            className={cn(
              "flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors",
              unavailable ? "opacity-50" : "hover:bg-state-hover",
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
  failed,
  copying,
  ready,
  onRetry,
  onCopy,
}: {
  readonly failed: boolean;
  readonly copying: boolean;
  readonly ready: boolean;
  readonly onRetry: () => void;
  readonly onCopy: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "mt-2 flex items-center gap-3 border-t border-divider px-3 pb-2 pt-4",
        failed ? "justify-between" : "justify-end",
      )}
    >
      {failed && (
        <span className="text-xs text-muted-foreground" role="status">
          {t(($) => {
            return $.artifacts.sharing.loadFailed;
          })}
        </span>
      )}
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

function ShareButtonPlaceholder({
  className,
  iconSize = 16,
  ariaLabel,
}: ShareButtonProps) {
  const { t } = useTranslation();
  return (
    <Button
      variant="quiet"
      size="icon-sm"
      className={className}
      aria-label={
        ariaLabel ??
        t(($) => {
          return $.artifacts.actions.share;
        })
      }
    >
      <Share2 size={iconSize} />
    </Button>
  );
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
            {details?.status ? (
              <PermissionChoices
                selected={draft?.audience ?? details.audience}
                organizationName={details.status.organization.name}
                saving={draft !== null}
                onChange={(audience) => {
                  return detach(change(audience, signal), Reason.DomCallback);
                }}
              />
            ) : (
              /* A failed read leaves the audience unknown, not absent. Keeping
                 the choices in place, inert and unselected, holds the menu's
                 shape and shows what Retry will restore. */
              loadable.state === "hasError" && (
                <PermissionChoices
                  selected={undefined}
                  organizationName={null}
                  saving={false}
                  unavailable
                  onChange={() => {
                    return undefined;
                  }}
                />
              )
            )}
            <ShareFooter
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

interface ArtifactShareMenuProps extends ShareButtonProps {
  readonly url: string;
  readonly surface: "dialog" | "sidebar" | "viewer";
  readonly copyUrl?: string;
  readonly artifactShareIdentity$?: AttachmentPreviewSignals["artifactShareIdentity$"];
}

function ArtifactShareMenuContent({
  url,
  surface,
  copyUrl,
  artifactShareIdentity,
  ...buttonProps
}: Omit<ArtifactShareMenuProps, "artifactShareIdentity$"> & {
  readonly artifactShareIdentity?: ArtifactShareIdentity;
}) {
  const scope = getArtifactShareScope(surface);
  const session = useGet(scope.session$);
  const mountRef = useSet(scope.mountRef$);
  const identityKey = artifactShareIdentity
    ? `${artifactShareIdentity.target.kind}:${artifactShareIdentity.target.id}:${artifactShareIdentity.sharedThreadSnapshot === true ? "snapshot" : "artifact"}`
    : "";
  return (
    <span
      key={`${url}:${copyUrl ?? ""}:${identityKey}`}
      ref={mountRef}
      data-share-url={url}
      data-copy-url={copyUrl}
      data-share-target-kind={artifactShareIdentity?.target.kind}
      data-share-target-id={artifactShareIdentity?.target.id}
      data-shared-thread-snapshot={
        artifactShareIdentity?.sharedThreadSnapshot === true
          ? "true"
          : undefined
      }
      className="inline-flex"
    >
      {session ? (
        <ShareSessionMenu session={session} {...buttonProps} />
      ) : (
        <ShareButtonPlaceholder {...buttonProps} />
      )}
    </span>
  );
}

function ResolvedArtifactShareMenu({
  artifactShareIdentity$,
  ...props
}: Omit<ArtifactShareMenuProps, "artifactShareIdentity$"> & {
  readonly artifactShareIdentity$: AttachmentPreviewSignals["artifactShareIdentity$"];
}) {
  const identity = useLoadable(artifactShareIdentity$);
  if (identity.state === "loading") {
    return <ShareButtonPlaceholder {...props} />;
  }
  return (
    <ArtifactShareMenuContent
      {...props}
      {...(identity.state === "hasData" && identity.data
        ? { artifactShareIdentity: identity.data }
        : {})}
    />
  );
}

export function ArtifactShareMenu({
  artifactShareIdentity$,
  ...props
}: ArtifactShareMenuProps) {
  return artifactShareIdentity$ ? (
    <ResolvedArtifactShareMenu
      artifactShareIdentity$={artifactShareIdentity$}
      {...props}
    />
  ) : (
    <ArtifactShareMenuContent {...props} />
  );
}
