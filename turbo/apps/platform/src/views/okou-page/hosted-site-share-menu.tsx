import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Check, ChevronRight, Globe, Loader2, Share2 } from "lucide-react";
import {
  Button,
  Input,
  MENU_ROW_HEIGHT_CLASS,
  Popover,
  PopoverContent,
  PopoverTrigger,
  cn,
} from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { resolveEditableHostedSiteDomain } from "../../lib/platform-host.ts";
import {
  getHostedSiteShareScope,
  type HostedSiteShareSession,
} from "../../signals/hosted-site-sharing.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ShareLinkRow, ShareLinkSkeleton } from "./artifact-share-menu.tsx";

interface ShareButtonProps {
  readonly ariaLabel: string;
  readonly className?: string;
  readonly iconSize?: number;
}

function WebsiteUrlFeedback({
  session,
  checking,
  checkFailed,
  saveFailed,
}: {
  readonly session: HostedSiteShareSession;
  readonly checking: boolean;
  readonly checkFailed: boolean;
  readonly saveFailed: boolean;
}) {
  const { t } = useTranslation();
  const id = session.inputId;
  const validation = useGet(session.validation$);
  const conflict = useGet(session.saveConflict$);
  const failed = saveFailed || conflict;
  const message = failed
    ? t(($) => {
        return $.artifacts.siteUrl.saveFailed;
      })
    : validation === "invalid"
      ? t(($) => {
          return $.artifacts.siteUrl.invalid;
        })
      : validation === "taken"
        ? t(($) => {
            return $.artifacts.siteUrl.taken;
          })
        : checking
          ? t(($) => {
              return $.artifacts.siteUrl.checking;
            })
          : checkFailed
            ? t(($) => {
                return $.artifacts.siteUrl.checkFailed;
              })
            : validation === "available"
              ? t(($) => {
                  return $.artifacts.siteUrl.available;
                })
              : t(($) => {
                  return $.artifacts.siteUrl.hint;
                });
  return (
    <p
      id={`${id}-hint`}
      role="status"
      className={cn(
        "text-xs",
        failed ||
          validation === "invalid" ||
          validation === "taken" ||
          checkFailed
          ? "text-destructive"
          : "text-muted-foreground",
      )}
    >
      {message}
    </p>
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
  if (!details || draft === null || !signal) {
    return null;
  }
  const suffix = new URL(details.url).hostname.slice(details.publicSlug.length);
  return (
    <form
      className="space-y-3 px-2 pb-2 pt-3"
      onSubmit={(event) => {
        // This form owns URL submission; keep navigation with the current preview.
        event.preventDefault();
        onSave();
      }}
    >
      <div className="space-y-2">
        <label htmlFor={id} className="text-sm font-medium">
          {t(($) => {
            return $.artifacts.siteUrl.label;
          })}
        </label>
        <div className="relative">
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
            className="pr-24"
            onChange={(event) => {
              detach(change(event.target.value, signal), Reason.DomCallback);
            }}
            onKeyDown={(event) => {
              // Composition confirmation, including Safari's final key, cannot submit.
              if (
                event.key === "Enter" &&
                (event.nativeEvent.isComposing ||
                  event.nativeEvent.keyCode === 229)
              ) {
                event.preventDefault();
              }
            }}
          />
          <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
            {suffix}
          </span>
        </div>
        <WebsiteUrlFeedback
          session={session}
          checking={checking.state === "loading"}
          checkFailed={checking.state === "hasError"}
          saveFailed={saveFailed}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {t(($) => {
          return $.artifacts.siteUrl.oldUrlWarning;
        })}
      </p>
      <div className="flex justify-end gap-1">
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
  editing,
  link,
  loading,
}: {
  readonly session: HostedSiteShareSession;
  readonly editing: boolean;
  readonly link: string | null;
  readonly loading: boolean;
}) {
  const { t } = useTranslation();
  const signal = useGet(session.signal$);
  const details = useLoadable(session.details$);
  const returnFocus = useGet(session.returnFocus$);
  const edit = useSet(session.edit$);
  const refresh = useSet(session.refresh$);
  const [copying, copy] = useLoadableSet(session.copy$);
  if (editing || !signal) {
    return null;
  }
  if (loading) {
    return <ShareLinkSkeleton />;
  }
  return (
    <>
      <ShareLinkRow
        copying={copying.state === "loading"}
        link={link?.replace(/^https?:\/\//u, "") ?? null}
        onCopy={() => {
          detach(copy(signal), Reason.DomCallback);
        }}
      />
      {details.state === "hasData" &&
        details.data?.isActive &&
        new URL(details.data.url).hostname.endsWith(
          `.${resolveEditableHostedSiteDomain()}`,
        ) && (
          <Button
            autoFocus={returnFocus}
            variant="quiet"
            className="mt-1 w-full justify-between px-2"
            onClick={() => {
              detach(edit(signal), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return $.artifacts.siteUrl.customize;
            })}
            <ChevronRight size={14} className="text-muted-foreground" />
          </Button>
        )}
      {details.state === "hasError" && (
        <div className="flex items-center justify-between gap-2 px-2 py-1">
          <span role="status" className="text-xs text-muted-foreground">
            {t(($) => {
              return $.artifacts.siteUrl.loadFailed;
            })}
          </span>
          <Button
            variant="quiet"
            size="sm"
            onClick={() => {
              refresh();
            }}
          >
            {t(($) => {
              return $.artifacts.sharing.retry;
            })}
          </Button>
        </div>
      )}
    </>
  );
}

function HostedSiteShareSessionMenu({
  session,
  ariaLabel,
  className,
  iconSize = 16,
}: ShareButtonProps & { readonly session: HostedSiteShareSession }) {
  const { t } = useTranslation();
  // The preview mounts this menu before its popover, so preload the current URL here.
  const link = useLoadable(session.copyUrl$);
  const signal = useGet(session.signal$);
  const open = useGet(session.open$);
  const editing = useGet(session.editing$);
  const setOpen = useSet(session.setOpen$);
  const [saving, save] = useLoadableSet(session.save$);
  if (!signal) {
    return null;
  }
  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (saving.state !== "loading") {
          setOpen(nextOpen);
        }
      }}
    >
      <PopoverTrigger
        aria-label={ariaLabel}
        render={<Button variant="quiet" size="icon-sm" className={className} />}
      >
        <Share2 size={iconSize} />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={ariaLabel}
        className="w-80 max-w-[calc(100vw-2rem)] p-1.5"
      >
        <div
          className={cn(
            "flex items-center gap-2 rounded-lg px-2",
            MENU_ROW_HEIGHT_CLASS,
          )}
        >
          <Globe size={16} className="text-muted-foreground" />
          <span className="flex-1 font-medium">
            {t(($) => {
              return $.artifacts.siteUrl.published;
            })}
          </span>
          <Check size={16} />
        </div>
        {editing && (
          <WebsiteUrlEditor
            session={session}
            saving={saving.state === "loading"}
            saveFailed={saving.state === "hasError"}
            onSave={() => {
              detach(save(signal), Reason.DomCallback);
            }}
          />
        )}
        <HostedSiteShareActions
          session={session}
          editing={editing}
          link={link.state === "hasData" ? link.data : null}
          loading={link.state === "loading"}
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
