import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Check, Loader2, Pencil, Share2 } from "lucide-react";
import {
  Button,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
  cn,
} from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { Switch } from "@okouai/ui/components/ui/switch";
import { resolveEditableHostedSiteDomain } from "../../lib/platform-host.ts";
import { currentOrgInfo$ } from "../../signals/auth.ts";
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
  if (
    !signal ||
    owner.state !== "hasData" ||
    !owner.data ||
    (banner.state === "hasData" && !banner.data)
  ) {
    return null;
  }
  const saving = operation.state === "loading";
  const failed = banner.state === "hasError";
  return (
    <div className="mt-4 border-t border-border pt-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm">
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

function HostedSiteShareActions({
  session,
  link,
  customizable,
  loadFailed,
}: {
  readonly session: HostedSiteShareSession;
  readonly link: string | null;
  readonly customizable: boolean;
  readonly loadFailed: boolean;
}) {
  const { t } = useTranslation();
  const signal = useGet(session.signal$);
  const returnFocus = useGet(session.returnFocus$);
  const copiedUrl = useGet(session.copiedUrl$);
  const edit = useSet(session.edit$);
  const copy = useSet(session.copy$);
  if (!signal) {
    return null;
  }
  return (
    <>
      {loadFailed && (
        <div className="mt-3 flex items-center justify-between gap-2">
          <span role="status" className="text-xs text-muted-foreground">
            {t(($) => {
              return $.artifacts.siteUrl.loadFailed;
            })}
          </span>
        </div>
      )}
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
          onCopy={() => {
            detach(copy(signal), Reason.DomCallback);
          }}
        />
      </div>
    </>
  );
}

function HostedSiteShareBody({
  session,
  link,
  loading,
  saving,
  saveFailed,
  onSave,
}: {
  readonly session: HostedSiteShareSession;
  readonly link: string | null;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly saveFailed: boolean;
  readonly onSave: () => void;
}) {
  // Stays subscribed while the editor is open, so Cancel and Save return to
  // settled actions instead of a loading frame.
  const details = useLoadable(session.details$);
  const editing = useGet(session.editing$);
  const showPermissions = !editing;
  return (
    <div className={showPermissions ? "p-1.5" : "p-4"}>
      {showPermissions && <HostedSitePermissions session={session} />}
      <div className={cn(showPermissions && "px-2")}>
        {showPermissions && <HostedSiteBannerSetting session={session} />}
        {editing ? (
          <WebsiteUrlEditor
            session={session}
            saving={saving}
            saveFailed={saveFailed}
            onSave={onSave}
          />
        ) : loading ? (
          // Nothing can be copied or customized until the current address is
          // known, so the footer holds its place without offering either.
          <div aria-busy="true" className="mt-4 flex justify-end">
            <Skeleton className="h-8 w-28 rounded-lg" />
          </div>
        ) : (
          <HostedSiteShareActions
            session={session}
            link={link}
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
      </div>
    </div>
  );
}

function HostedSiteShareSessionMenu({
  session,
  ariaLabel,
  className,
  iconSize = 16,
}: ShareButtonProps & { readonly session: HostedSiteShareSession }) {
  // The preview mounts this menu before its popover, so preload the current URL here.
  const link = useLoadable(session.copyUrl$);
  const settings = useLoadable(session.hasSettings$);
  // Preload permissions alongside the current address before Share opens.
  useLoadable(session.visibility$);
  useLoadable(session.banner$);
  const signal = useGet(session.signal$);
  const open = useGet(session.open$);
  const editing = useGet(session.editing$);
  const setOpen = useSet(session.setOpen$);
  const show = useSet(session.show$);
  const [saving, save] = useLoadableSet(session.save$);
  if (!signal) {
    return null;
  }
  return (
    <Popover
      open={open && !(settings.state === "hasData" && !settings.data)}
      onOpenChange={(nextOpen, details) => {
        // Leaving the hover region must not discard a URL draft. Explicit
        // dismissal still cancels editing; an in-flight save keeps its owner.
        if (
          saving.state === "loading" ||
          (!nextOpen && editing && details.reason === "trigger-hover")
        ) {
          details.cancel();
          return;
        }
        if (nextOpen) {
          detach(
            show(details.reason !== "trigger-hover", signal),
            Reason.DomCallback,
          );
        } else {
          setOpen(false);
        }
      }}
    >
      <PopoverTrigger
        openOnHover={!(settings.state === "hasData" && !settings.data)}
        delay={100}
        closeDelay={150}
        aria-label={ariaLabel}
        render={<Button variant="quiet" size="icon-sm" className={className} />}
      >
        <Share2 size={iconSize} />
      </PopoverTrigger>

      <PopoverContent
        align="end"
        aria-label={ariaLabel}
        className="w-90 max-w-[calc(100vw-2rem)] p-0"
      >
        <HostedSiteShareBody
          session={session}
          link={link.state === "hasData" ? link.data : null}
          loading={link.state === "loading"}
          saving={saving.state === "loading"}
          saveFailed={saving.state === "hasError"}
          onSave={() => {
            detach(save(signal), Reason.DomCallback);
          }}
        />
      </PopoverContent>
    </Popover>
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
    <span key={url} ref={mountRef} data-share-url={url} className="inline-flex">
      {session ? (
        <HostedSiteShareSessionMenu session={session} {...props} />
      ) : (
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
