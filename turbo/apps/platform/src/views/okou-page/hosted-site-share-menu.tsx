import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { ReactNode } from "react";
import {
  Check,
  ChevronRight,
  Loader2,
  PanelTop,
  Pencil,
  Share2,
} from "lucide-react";
import {
  Button,
  Input,
  MENU_ROW_HEIGHT_CLASS,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
  cn,
} from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { Switch } from "@okouai/ui/components/ui/switch";
import { resolveEditableHostedSiteDomain } from "../../lib/platform-host.ts";
import { captureArtifactAction } from "../../lib/posthog.ts";
import { currentOrgInfo$ } from "../../signals/auth.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import {
  getHostedSiteShareScope,
  type HostedSiteShareSession,
} from "../../signals/hosted-site-sharing.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  ShareCopyButton,
  SharePermissionChoices,
  ShareLoadError,
  ShareSkeleton,
} from "./artifact-share-menu.tsx";

interface ShareButtonProps {
  readonly ariaLabel: string;
  readonly className?: string;
  readonly iconSize?: number;
  readonly readyOnly?: boolean;
}

function HostedSiteBannerSetting({
  session,
}: {
  readonly session: HostedSiteShareSession;
}) {
  const { t } = useTranslation();
  const owner = useLoadable(session.visibility$);
  const banner = useLoadable(session.banner$);
  const current = useLastResolved(session.banner$);
  const [operation, change] = useLoadableSet(session.changeBanner$);
  const signal = useGet(session.signal$);
  const features = useGet(featureSwitch$);
  const rows = features[FeatureSwitchKey.HostedSiteShareRows];
  if (
    !signal ||
    owner.state !== "hasData" ||
    !owner.data ||
    (banner.state === "hasData" && !banner.data) ||
    (features[FeatureSwitchKey.ArtifactPreviewToolbar] && !current)
  ) {
    return null;
  }
  const saving = operation.state === "loading";
  const failed = banner.state === "hasError";
  return (
    <div
      className={
        rows
          ? "mt-1.5 border-t border-border pt-1.5"
          : "mt-4 border-t border-border pt-3"
      }
    >
      <div
        className={cn(
          "flex items-center justify-between",
          rows ? cn("gap-2", MENU_ROW_HEIGHT_CLASS) : "gap-3",
        )}
      >
        {rows && (
          <PanelTop size={16} className="shrink-0 text-muted-foreground" />
        )}
        <span className={cn("text-sm", rows && "min-w-0 flex-1 truncate")}>
          {t(($) => {
            return $.artifacts.siteBanner.label;
          })}
        </span>
        {!current ? (
          <Skeleton className="h-5 w-9 rounded-full" />
        ) : (
          <div className="flex items-center gap-2">
            {saving && <Loader2 size={14} className="animate-spin" />}
            <Switch
              size="compact"
              aria-label={t(($) => {
                return $.artifacts.siteBanner.label;
              })}
              checked={current?.showBanner === true}
              disabled={saving || banner.state !== "hasData"}
              onCheckedChange={(value) => {
                detach(change(value, signal), Reason.DomCallback);
              }}
            />
          </div>
        )}
      </div>
      {failed && (
        <ShareLoadError
          message={t(($) => {
            return $.artifacts.siteBanner.loadFailed;
          })}
        />
      )}
    </div>
  );
}

function HostedSitePermissions({
  session,
}: {
  readonly session: HostedSiteShareSession;
}) {
  const { t } = useTranslation();
  const loadable = useLoadable(session.visibility$);
  const [operation, change] = useLoadableSet(session.changeVisibility$);
  const organization = useLastResolved(currentOrgInfo$);
  const signal = useGet(session.signal$);
  if (!signal || (loadable.state === "hasData" && !loadable.data)) {
    return null;
  }
  const saving = operation.state === "loading";
  const failed = loadable.state === "hasError";
  return (
    <>
      <div className="flex items-center gap-2 px-2 pb-1 pt-1 text-xs font-medium text-muted-foreground">
        {t(($) => {
          return $.artifacts.sharing.accessLabel;
        })}
        {saving && <Loader2 size={14} className="animate-spin" />}
      </div>
      {loadable.state === "loading" && !saving ? (
        <ShareSkeleton showCopyButton={false} />
      ) : (
        <>
          <SharePermissionChoices
            selected={
              loadable.state === "hasData"
                ? loadable.data?.visibility
                : undefined
            }
            organizationName={organization?.name ?? null}
            saving={saving}
            unavailable={failed}
            onChange={(visibility) => {
              detach(change(visibility, signal), Reason.DomCallback);
            }}
          />
          {failed && <ShareLoadError />}
        </>
      )}
    </>
  );
}

type WebsiteUrlFeedback = {
  // A short state that sits beside the field's label.
  readonly status: "checking" | "available" | null;
  readonly message: string;
  readonly error: boolean;
};

function useWebsiteUrlFeedback(
  session: HostedSiteShareSession,
  checking: boolean,
  checkFailed: boolean,
  saveFailed: boolean,
): WebsiteUrlFeedback {
  const { t } = useTranslation();
  const validation = useGet(session.validation$);
  const conflict = useGet(session.saveConflict$);
  if (saveFailed || conflict) {
    return {
      status: null,
      error: true,
      message: t(($) => {
        return $.artifacts.siteUrl.saveFailed;
      }),
    };
  }
  if (validation === "invalid" || validation === "taken") {
    return {
      status: null,
      error: true,
      message:
        validation === "invalid"
          ? t(($) => {
              return $.artifacts.siteUrl.invalid;
            })
          : t(($) => {
              return $.artifacts.siteUrl.taken;
            }),
    };
  }
  if (!checking && checkFailed) {
    return {
      status: null,
      error: true,
      message: t(($) => {
        return $.artifacts.siteUrl.checkFailed;
      }),
    };
  }
  // Moving the site breaks every link already handed out, so that is said
  // once an address can actually be saved, not before anything was typed.
  return {
    status: checking
      ? "checking"
      : validation === "available"
        ? "available"
        : null,
    error: false,
    message:
      !checking && validation === "available"
        ? t(($) => {
            return $.artifacts.siteUrl.oldUrlWarning;
          })
        : t(($) => {
            return $.artifacts.siteUrl.hint;
          }),
  };
}

function WebsiteUrlStatus({
  status,
}: {
  readonly status: WebsiteUrlFeedback["status"];
}) {
  const { t } = useTranslation();
  return (
    <span
      role="status"
      className="flex items-center gap-1 text-xs text-muted-foreground"
    >
      {status === "checking" &&
        t(($) => {
          return $.artifacts.siteUrl.checking;
        })}
      {status === "available" && (
        <>
          <Check size={14} className="text-green-600" />
          {t(($) => {
            return $.artifacts.siteUrl.available;
          })}
        </>
      )}
    </span>
  );
}

function WebsiteUrlEditor({
  session,
  saving,
  saveFailed,
  onSave,
}: {
  readonly session: HostedSiteShareSession;
  readonly saving: boolean;
  readonly saveFailed: boolean;
  readonly onSave: () => void;
}) {
  const { t } = useTranslation();
  const signal = useGet(session.signal$);
  const id = session.inputId;
  const details = useLastResolved(session.details$);
  const draft = useGet(session.draft$);
  const validation = useGet(session.validation$);
  const [checking, change] = useLoadableSet(session.change$);
  const cancel = useSet(session.cancel$);
  const feedback = useWebsiteUrlFeedback(
    session,
    checking.state === "loading",
    checking.state === "hasError",
    saveFailed,
  );
  if (!details || draft === null || !signal) {
    return null;
  }
  const suffix = new URL(details.url).hostname.slice(details.publicSlug.length);
  return (
    <form
      className="mt-4"
      onSubmit={(event) => {
        // This form owns URL submission; keep navigation with the current preview.
        event.preventDefault();
        onSave();
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium">
          {t(($) => {
            return $.artifacts.siteUrl.label;
          })}
        </label>
        <WebsiteUrlStatus status={feedback.status} />
      </div>

      <Input
        id={id}
        autoFocus
        value={draft}
        disabled={saving}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={63}
        aria-describedby={`${id}-hint`}
        aria-invalid={validation === "invalid" || validation === "taken"}
        suffix={suffix}
        className="mt-2"
        onChange={(event) => {
          detach(change(event.target.value, signal), Reason.DomCallback);
        }}
        onKeyDown={(event) => {
          // Composition confirmation, including Safari's final key, cannot submit.
          if (
            event.key === "Enter" &&
            (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
          ) {
            event.preventDefault();
          }
        }}
      />
      <p
        id={`${id}-hint`}
        role="status"
        className={cn(
          "mt-2 text-xs",
          feedback.error ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {feedback.message}
      </p>
      <div className="mt-4 flex justify-end gap-1">
        <Button
          type="button"
          variant="quiet"
          size="sm"
          disabled={saving}
          onClick={() => {
            cancel();
          }}
        >
          {t(($) => {
            return $.artifacts.siteUrl.cancel;
          })}
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={
            saving || checking.state === "loading" || validation !== "available"
          }
        >
          {saving && <Loader2 size={14} className="animate-spin" />}
          {t(($) => {
            return $.artifacts.siteUrl.save;
          })}
        </Button>
      </div>
    </form>
  );
}

function CustomizeUrlRow({
  address,
  autoFocus,
  onEdit,
}: {
  readonly address: string | null;
  readonly autoFocus: boolean;
  readonly onEdit: () => void;
}) {
  const { t } = useTranslation();
  const label = t(($) => {
    return $.artifacts.siteUrl.customize;
  });
  // A menu row, like the access options above it: the chevron says the row
  // opens the address editor, and the current address is its value.
  return (
    <div className="-mx-2">
      <Button
        autoFocus={autoFocus}
        variant="quiet"
        aria-label={label}
        className="w-full justify-start px-2 font-normal text-foreground"
        onClick={onEdit}
      >
        <Pencil size={16} className="shrink-0 text-muted-foreground" />
        <span className="shrink-0">{label}</span>
        <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">
          {address}
        </span>
        <ChevronRight size={16} className="shrink-0" />
      </Button>
    </div>
  );
}

function HostedSiteShareActions({
  session,
  surface,
  link,
  address,
  customizable,
  loadFailed,
}: {
  readonly session: HostedSiteShareSession;
  readonly surface: "dialog" | "sidebar";
  readonly link: string | null;
  readonly address: string | null;
  readonly customizable: boolean;
  readonly loadFailed: boolean;
}) {
  const { t } = useTranslation();
  const signal = useGet(session.signal$);
  const returnFocus = useGet(session.returnFocus$);
  const copiedUrl = useGet(session.copiedUrl$);
  const edit = useSet(session.edit$);
  const copy = useSet(session.copy$);
  const banner = useLoadable(session.banner$);
  const rows = useGet(featureSwitch$)[FeatureSwitchKey.HostedSiteShareRows];
  if (!signal) {
    return null;
  }
  const copyLink = () => {
    // Analytics must not prevent the user's copy operation from starting.
    detach(copy(signal), Reason.DomCallback);
    captureArtifactAction({
      action: "banner_share",
      surface,
      target: "hosted_site",
      show_banner:
        banner.state === "hasData" && banner.data
          ? banner.data.showBanner
          : "unknown",
    });
  };
  const loadFailedStatus = loadFailed && (
    <div className="mt-3 flex items-center justify-between gap-2">
      <span role="status" className="text-xs text-muted-foreground">
        {t(($) => {
          return $.artifacts.siteUrl.loadFailed;
        })}
      </span>
    </div>
  );
  if (rows) {
    return (
      <>
        {customizable && (
          <CustomizeUrlRow
            address={address}
            autoFocus={returnFocus}
            onEdit={() => {
              detach(edit(signal), Reason.DomCallback);
            }}
          />
        )}
        {loadFailedStatus}
        <ShareCopyButton
          className="mt-1.5 w-full"
          copied={link !== null && copiedUrl === link}
          disabled={link === null}
          onCopy={copyLink}
        />
      </>
    );
  }
  return (
    <>
      {loadFailedStatus}
      <div className="mt-4 flex items-center gap-2">
        {customizable && (
          // `-ml-2` pulls the quiet button's padding into the gutter so its
          // pencil lines up with the globe above it.
          <Button
            autoFocus={returnFocus}
            variant="quiet"
            size="sm"
            className="-ml-2 px-2"
            onClick={() => {
              detach(edit(signal), Reason.DomCallback);
            }}
          >
            <Pencil />
            {t(($) => {
              return $.artifacts.siteUrl.customize;
            })}
          </Button>
        )}
        <ShareCopyButton
          className="ml-auto"
          copied={link !== null && copiedUrl === link}
          disabled={link === null}
          onCopy={copyLink}
        />
      </div>
    </>
  );
}

function HostedSiteShareUrl({
  session,
  surface,
  saving,
  saveFailed,
  onSave,
}: {
  readonly session: HostedSiteShareSession;
  readonly surface: "dialog" | "sidebar";
  readonly saving: boolean;
  readonly saveFailed: boolean;
  readonly onSave: () => void;
}) {
  const link = useLoadable(session.copyUrl$);
  // Stays subscribed while the editor is open, so Cancel and Save return to
  // settled actions instead of a loading frame.
  const details = useLoadable(session.details$);
  const editing = useGet(session.editing$);
  const rows = useGet(featureSwitch$)[FeatureSwitchKey.HostedSiteShareRows];
  return (
    <>
      {editing ? (
        <WebsiteUrlEditor
          session={session}
          saving={saving}
          saveFailed={saveFailed}
          onSave={onSave}
        />
      ) : link.state === "loading" ? (
        // Nothing can be copied or customized until the current address is
        // known, so the footer holds its place without offering either.
        <div
          aria-busy="true"
          className={rows ? "mt-1.5 flex" : "mt-4 flex justify-end"}
        >
          <Skeleton
            className={cn("h-8 rounded-lg", rows ? "w-full" : "w-28")}
          />
        </div>
      ) : (
        <HostedSiteShareActions
          session={session}
          surface={surface}
          link={link.state === "hasData" ? link.data : null}
          address={
            details.state === "hasData" && details.data
              ? new URL(details.data.url).hostname
              : null
          }
          customizable={
            details.state === "hasData" &&
            details.data?.isActive === true &&
            new URL(details.data.url).hostname.endsWith(
              `.${resolveEditableHostedSiteDomain()}`,
            )
          }
          loadFailed={details.state === "hasError"}
        />
      )}
    </>
  );
}

function HostedSiteShareBody({
  session,
  permissions,
  banner,
  children,
}: {
  readonly session: HostedSiteShareSession;
  readonly permissions: ReactNode;
  readonly banner: ReactNode;
  readonly children: ReactNode;
}) {
  const editing = useGet(session.editing$);
  return (
    <div className={editing ? "p-4" : "p-1.5"}>
      {!editing && permissions}
      <div className={cn(!editing && "px-2")}>
        {!editing && banner}
        {children}
      </div>
    </div>
  );
}

function HostedSiteSharePopover({
  session,
  ariaLabel,
  className,
  iconSize = 16,
  readyOnly = false,
  saving,
  children,
}: ShareButtonProps & {
  readonly session: HostedSiteShareSession;
  readonly saving: boolean;
  readonly children: ReactNode;
}) {
  const settings = useLoadable(session.hasSettings$);
  const signal = useGet(session.signal$);
  const open = useGet(session.open$);
  const setOpen = useSet(session.setOpen$);
  const show = useSet(session.show$);
  // Preload even while the trigger is absent. The toolbar does not own these
  // requests through the conditional presence of the popover body.
  useLoadable(session.copyUrl$);
  useLoadable(session.visibility$);
  useLoadable(session.banner$);
  if (
    !signal ||
    (readyOnly && settings.state !== "hasData" && !open && !saving)
  ) {
    return null;
  }
  return (
    <Popover
      open={open && !(settings.state === "hasData" && !settings.data)}
      onOpenChange={(nextOpen, details) => {
        // An in-flight save keeps its owner until it completes.
        if (saving) {
          details.cancel();
          return;
        }
        if (nextOpen) {
          detach(show(signal), Reason.DomCallback);
        } else {
          setOpen(false);
        }
      }}
    >
      <PopoverTrigger
        aria-label={ariaLabel}
        render={
          <Button
            variant="quiet"
            size="icon-sm"
            className={cn(
              "data-popup-open:bg-state-hover data-popup-open:text-foreground",
              className,
            )}
          />
        }
      >
        <Share2 size={iconSize} />
      </PopoverTrigger>

      {children}
    </Popover>
  );
}

function HostedSiteShareSessionMenu({
  session,
  surface,
  permissions,
  banner,
  ...props
}: ShareButtonProps & {
  readonly session: HostedSiteShareSession;
  readonly surface: "dialog" | "sidebar";
  readonly permissions: ReactNode;
  readonly banner: ReactNode;
}) {
  const signal = useGet(session.signal$);
  const [saving, save] = useLoadableSet(session.save$);
  if (!signal) {
    return null;
  }
  // Frame-only preload/open updates keep these body children and their save owner.
  return (
    <HostedSiteSharePopover
      session={session}
      saving={saving.state === "loading"}
      {...props}
    >
      <PopoverContent
        align="end"
        aria-label={props.ariaLabel}
        className="w-90 max-w-[calc(100vw-2rem)] p-0"
      >
        <HostedSiteShareBody
          session={session}
          permissions={permissions}
          banner={banner}
        >
          <HostedSiteShareUrl
            session={session}
            surface={surface}
            saving={saving.state === "loading"}
            saveFailed={saving.state === "hasError"}
            onSave={() => {
              detach(save(signal), Reason.DomCallback);
            }}
          />
        </HostedSiteShareBody>
      </PopoverContent>
    </HostedSiteSharePopover>
  );
}

export function HostedSiteShareMenu({
  url,
  surface,
  ...props
}: ShareButtonProps & {
  readonly url: string;
  readonly surface: "dialog" | "sidebar";
}) {
  const scope = getHostedSiteShareScope(surface);
  const session = useGet(scope.session$);
  const mountRef = useSet(scope.mountRef$);
  return (
    <span
      key={url}
      ref={mountRef}
      data-share-url={url}
      className={props.readyOnly ? "contents" : "inline-flex"}
    >
      {session?.sourceUrl === url ? (
        // Settings have independent subscriptions; URL saves keep these nodes.
        <HostedSiteShareSessionMenu
          session={session}
          surface={surface}
          permissions={<HostedSitePermissions session={session} />}
          banner={<HostedSiteBannerSetting session={session} />}
          {...props}
        />
      ) : props.readyOnly ? null : (
        <Button
          variant="quiet"
          size="icon-sm"
          aria-label={props.ariaLabel}
          className={props.className}
        >
          <Share2 size={props.iconSize ?? 16} />
        </Button>
      )}
    </span>
  );
}
