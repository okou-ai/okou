import { useLoadableSet } from "ccstate-react/experimental";
import type { ArtifactShareStatus } from "@okouai/api-contracts/contracts/artifact-shares";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
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

export function SharePermissionChoices({
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
  // No pending choice is confirmed yet. Keeping every option unchecked also
  // lets native pointer and arrow selection reaffirm the server baseline.
  return (
    <RadioGroup
      aria-label={t(($) => {
        return $.artifacts.sharing.accessLabel;
      })}
      disabled={unavailable}
      aria-busy={saving}
      value={saving ? null : (selected ?? null)}
      onValueChange={(value: string) => {
        return onChange(value as ArtifactShareStatus["audience"]);
      }}
    >
      {options.map(({ audience, Icon, label }) => {
        const isSelected = !saving && selected === audience;
        return (
          <RadioPrimitive.Root
            key={audience}
            value={audience}
            nativeButton
            render={<button type="button" />}
            aria-busy={saving}
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
            {isSelected && <Check size={16} className="shrink-0" />}
          </RadioPrimitive.Root>
        );
      })}
    </RadioGroup>
  );
}

/**
 * The menu's one action. Copying is repeatable and changes nothing, so it takes
 * the neutral button rather than the filled primary a commit such as Save
 * gets; filled, it outweighed the address the menu exists to show.
 *
 * A successful copy is confirmed on this button rather than in a toast;
 * `min-w-28` holds the button's width while its label swaps between the two,
 * and the status line carries the confirmation to screen readers, which a
 * changed button label does not reach.
 */
export function ShareCopyButton({
  copied,
  disabled,
  className,
  onCopy,
}: {
  readonly copied: boolean;
  readonly disabled: boolean;
  readonly className?: string;
  readonly onCopy: () => void;
}) {
  const { t } = useTranslation();
  const copiedLabel = t(($) => {
    return $.artifacts.sharing.copied;
  });
  return (
    <>
      <Button
        variant="neutral"
        size="sm"
        className={cn("min-w-28", className)}
        disabled={disabled}
        onClick={() => {
          return onCopy();
        }}
      >
        {copied ? <Check size={16} /> : <Link2 size={16} />}
        {copied
          ? copiedLabel
          : t(($) => {
              return $.artifacts.sharing.copyLink;
            })}
      </Button>
      <span role="status" className="sr-only">
        {copied ? copiedLabel : ""}
      </span>
    </>
  );
}

export function ShareLoadError({ message }: { readonly message?: string }) {
  const { t } = useTranslation();
  return (
    <div className="mt-1.5 flex items-center justify-between gap-3 px-2 py-1">
      <span className="text-xs text-muted-foreground" role="status">
        {message ??
          t(($) => {
            return $.artifacts.sharing.loadFailed;
          })}
      </span>
    </div>
  );
}

export function ShareSkeleton({
  showCopyButton = true,
}: {
  readonly showCopyButton?: boolean;
}) {
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
      {showCopyButton && (
        <div className="mt-1.5 flex justify-end">
          <Skeleton className="h-8 w-28 rounded-lg" />
        </div>
      )}
    </div>
  );
}

export function ShareMenuContent({
  label,
  selected,
  organizationName,
  loading = false,
  saving = false,
  failed = false,
  unavailable = false,
  showPermissions = true,
  errorMessage,
  onChange,
  copy,
}: {
  readonly label: string;
  readonly selected: ArtifactShareStatus["audience"] | undefined;
  readonly organizationName: string | null;
  readonly loading?: boolean;
  readonly saving?: boolean;
  readonly failed?: boolean;
  readonly unavailable?: boolean;
  readonly showPermissions?: boolean;
  readonly errorMessage?: string | null;
  readonly onChange: (audience: ArtifactShareStatus["audience"]) => void;
  readonly copy?: {
    readonly copied: boolean;
    readonly disabled: boolean;
    readonly onCopy: () => void;
  };
}) {
  const { t } = useTranslation();
  return (
    <PopoverContent
      aria-label={label}
      align="end"
      className="w-80 max-w-[calc(100vw-32px)] p-1.5"
    >
      {showPermissions && (
        <div
          aria-hidden="true"
          className="flex items-center gap-2 px-2 pb-1 pt-1 text-xs font-medium text-muted-foreground"
        >
          {t(($) => {
            return $.artifacts.sharing.accessLabel;
          })}
          {saving && <Loader2 size={14} className="animate-spin" />}
        </div>
      )}
      {loading ? (
        <ShareSkeleton showCopyButton={!!copy} />
      ) : (
        <>
          {showPermissions && (
            <SharePermissionChoices
              selected={failed ? undefined : selected}
              organizationName={failed ? null : organizationName}
              saving={saving}
              unavailable={failed || unavailable}
              onChange={onChange}
            />
          )}
          {failed ? (
            <ShareLoadError />
          ) : (
            <>
              {errorMessage && <ShareLoadError message={errorMessage} />}
              {copy && (
                <div className="mt-1.5 flex justify-end">
                  <ShareCopyButton {...copy} />
                </div>
              )}
            </>
          )}
        </>
      )}
    </PopoverContent>
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
  const [audienceOperation, change] = useLoadableSet(session.change$);
  const requestedOpen = useGet(session.open$);
  const signal = useGet(session.signal$);
  const open = useSet(session.show$);
  const close = useSet(session.close$);
  const copy = useSet(session.copy$);
  const copiedUrl = useGet(session.copiedUrl$);
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

      <ShareMenuContent
        label={title}
        selected={details?.audience}
        organizationName={details?.status?.organization.name ?? null}
        loading={loading}
        saving={audienceOperation.state === "loading"}
        failed={failed}
        onChange={(audience) => {
          detach(change(audience, signal), Reason.DomCallback);
        }}
        copy={{
          copied: !!details?.status && copiedUrl === details.copyUrl,
          disabled: !details?.status,
          onCopy: () => {
            detach(copy(signal), Reason.DomCallback);
          },
        }}
      />
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
