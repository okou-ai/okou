import type { ArtifactShareStatus } from "@okouai/api-contracts/contracts/artifact-shares";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
// The shared `Radio` is the 16px circle meant to sit beside a label. Here the
// whole row is the control and the trailing check marks it, the way
// `DropdownMenu` and `Select` mark theirs, so the row composes `Radio.Root`
// directly and keeps Base UI's roving focus and arrow-key selection.
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import {
  Check,
  Globe,
  Link2,
  Loader2,
  LockKeyhole,
  Share2,
  Users,
} from "lucide-react";
import {
  Button,
  MENU_ROW_HEIGHT_CLASS,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RadioGroup,
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
import { publicAttachmentUrl } from "./attachment-url.ts";

/**
 * What Copy link actually puts on the clipboard, minus the scheme. Showing it
 * is the only way the menu answers "which link am I about to hand out?", so it
 * goes through the same `publicAttachmentUrl` the copy command uses rather than
 * rendering `copyUrl` and hoping the two agree.
 */
function shareLinkLabel(copyUrl: string): string {
  const url = new URL(publicAttachmentUrl(copyUrl), location.origin);
  return `${url.host}${url.pathname}${url.search}${url.hash}`;
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
        return $.artifacts.sharing.onlyMeOption;
      }),
    },
    {
      audience: "organization",
      Icon: Users,
      // A failed permission read still knows the option exists, but not which
      // workspace it names, so the unnamed wording stands in for it.
      label:
        organizationName === null
          ? t(($) => {
              return $.artifacts.sharing.organizationOptionUnnamed;
            })
          : t(
              ($) => {
                return $.artifacts.sharing.organizationOption;
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
        return $.artifacts.sharing.publicOption;
      }),
    },
  ] as const;
  return (
    <RadioGroup
      aria-label={t(($) => {
        return $.artifacts.sharing.accessLabel;
      })}
      disabled={unavailable}
      value={selected ?? null}
      onValueChange={(value) => {
        return onChange(value as ArtifactShareStatus["audience"]);
      }}
    >
      {options.map(({ audience, Icon, label }) => {
        const isSelected = selected === audience;
        return (
          <RadioPrimitive.Root
            key={audience}
            value={audience}
            nativeButton
            render={<button type="button" />}
            aria-busy={isSelected && saving}
            className={cn(
              "flex w-full select-none items-center gap-2 rounded-lg px-2 text-left outline-none transition-colors",
              MENU_ROW_HEIGHT_CLASS,
              unavailable && "opacity-50",
              // `state-hover` says "the pointer is here"; selection owns
              // `state-selected`. Painting both with the hover layer made a
              // hovered row and the current audience the same fill.
              isSelected
                ? "bg-state-selected hover:bg-state-selected-hover"
                : "hover:bg-state-hover",
              unavailable && "hover:bg-transparent",
            )}
          >
            <Icon size={16} className="shrink-0 text-muted-foreground" />
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                isSelected && "font-medium",
              )}
            >
              {label}
            </span>
            {isSelected &&
              (saving ? (
                <Loader2 size={16} className="shrink-0 animate-spin" />
              ) : (
                <Check size={16} className="shrink-0" />
              ))}
          </RadioPrimitive.Root>
        );
      })}
    </RadioGroup>
  );
}

function ShareLinkRow({
  copying,
  link,
  onCopy,
}: {
  readonly copying: boolean;
  readonly link: string | null;
  readonly onCopy: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-1.5 flex items-center gap-2 rounded-lg bg-muted/30 py-1 pl-2.5 pr-1">
      <Link2 size={14} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {link}
      </span>
      <Button
        variant="quiet"
        size="sm"
        className="shrink-0"
        disabled={copying || link === null}
        onClick={() => {
          return onCopy();
        }}
      >
        {copying && <Loader2 size={14} className="animate-spin" />}
        {t(($) => {
          return $.artifacts.sharing.copyLink;
        })}
      </Button>
    </div>
  );
}

function ShareRetryRow({ onRetry }: { readonly onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="mt-1.5 flex items-center justify-between gap-3 px-2 py-1">
      <span className="text-xs text-muted-foreground" role="status">
        {t(($) => {
          return $.artifacts.sharing.loadFailed;
        })}
      </span>
      <Button
        size="sm"
        variant="neutral"
        onClick={() => {
          return onRetry();
        }}
      >
        {t(($) => {
          return $.artifacts.sharing.retry;
        })}
      </Button>
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
    >
      {[0, 1, 2].map((index) => {
        return (
          <div
            key={index}
            className={cn(
              "flex items-center gap-2 px-2",
              MENU_ROW_HEIGHT_CLASS,
            )}
          >
            <Skeleton className="size-4 rounded" />
            <Skeleton className="h-4 w-40 rounded" />
          </div>
        );
      })}
      <div className="mt-1.5 flex items-center gap-2 rounded-lg bg-muted/30 py-1 pl-2.5 pr-1">
        <Skeleton className="size-3.5 rounded" />
        <Skeleton className="h-3 flex-1 rounded" />
        <Skeleton className="h-8 w-20 rounded-lg" />
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
  const failed = loadable.state === "hasError";
  const loading = !details && loadable.state === "loading";
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
      {/* Corner, stroke and shadow stay with `PopoverContent`; a share menu is
          not a dialog and gets no title bar, close button or footer rule. */}
      <PopoverContent
        aria-label={title}
        align="end"
        className="w-80 max-w-[calc(100vw-32px)] p-1.5"
      >
        <div
          aria-hidden="true"
          className="px-2 pb-1 pt-1 text-xs font-medium text-muted-foreground"
        >
          {t(($) => {
            return $.artifacts.sharing.accessLabel;
          })}
        </div>
        {loading ? (
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
              failed && (
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
            {failed ? (
              <ShareRetryRow
                onRetry={() => {
                  return detach(refresh(signal), Reason.DomCallback);
                }}
              />
            ) : (
              <ShareLinkRow
                copying={copying.state === "loading"}
                link={details?.status ? shareLinkLabel(details.copyUrl) : null}
                onCopy={() => {
                  return detach(copy(signal), Reason.DomCallback);
                }}
              />
            )}
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
