import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Check, Globe, Loader2, Pencil, Share2 } from "lucide-react";
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
import { resolveEditableHostedSiteDomain } from "../../lib/platform-host.ts";
import {
  getHostedSiteShareScope,
  type HostedSiteShareSession,
} from "../../signals/hosted-site-sharing.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ShareCopyButton } from "./artifact-share-menu.tsx";

interface ShareButtonProps {
  readonly ariaLabel: string;
  readonly className?: string;
  readonly iconSize?: number;
}

/**
 * The published address is the menu's title. It is plain text rather than a
 * boxed field because a box is for typing, and the site opens from it. The
 * scheme says nothing the reader needs; the subdomain is the part they chose
 * and the part that tells two sites apart, so it gives way first while the
 * domain stays readable.
 */
function SiteAddress({ link }: { readonly link: string }) {
  const address = link.replace(/^https?:\/\//u, "");
  const dot = address.indexOf(".");
  return (
    <a
      href={link}
      target="_blank"
      rel="noopener noreferrer"
      className="flex min-w-0 font-medium text-foreground underline-offset-4 hover:underline"
    >
      <span className="truncate">
        {dot > 0 ? address.slice(0, dot) : address}
      </span>
      {dot > 0 && (
        <span className="shrink-0 text-muted-foreground">
          {address.slice(dot)}
        </span>
      )}
    </a>
  );
}

function SiteStatus({ link }: { readonly link: string | null }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-2 text-sm">
      <Globe size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        {link === null ? (
          <Skeleton className="h-5 w-40 rounded" />
        ) : (
          <SiteAddress link={link} />
        )}
        <p className="text-xs text-muted-foreground">
          <span>
            {t(($) => {
              return $.artifacts.siteUrl.published;
            })}
          </span>
          {" · "}
          <span>
            {t(($) => {
              return $.artifacts.sharing.publicOption;
            })}
          </span>
        </p>
      </div>
    </div>
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
      {/* The fixed domain is a segment of the field rather than text laid
          over it, so the subdomain keeps the field's full width to itself. */}
      <div className="mt-2 flex h-9 overflow-hidden rounded-lg border border-[hsl(var(--gray-400))] bg-input text-sm transition-colors focus-within:border-primary focus-within:ring-[3px] focus-within:ring-primary/10 has-aria-invalid:border-destructive has-aria-invalid:ring-destructive/10">
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
          className="h-full min-w-0 flex-1 rounded-none border-0 bg-transparent focus:ring-0"
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
        <span className="flex shrink-0 items-center border-l border-[hsl(var(--gray-400))] bg-muted/60 px-3 text-muted-foreground">
          {suffix}
        </span>
      </div>
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
  const refresh = useSet(session.refresh$);
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
  saving,
  saveFailed,
  onSave,
}: {
  readonly session: HostedSiteShareSession;
  readonly saving: boolean;
  readonly saveFailed: boolean;
  readonly onSave: () => void;
}) {
  // Both reads stay subscribed while the editor is open, so Cancel and Save
  // return to settled actions instead of a loading frame.
  const link = useLoadable(session.copyUrl$);
  const details = useLoadable(session.details$);
  const editing = useGet(session.editing$);
  const current = link.state === "hasData" ? link.data : null;
  return (
    <>
      <SiteStatus link={current} />
      {editing ? (
        <WebsiteUrlEditor
          session={session}
          saving={saving}
          saveFailed={saveFailed}
          onSave={onSave}
        />
      ) : (
        <HostedSiteShareActions
          session={session}
          link={current}
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

function HostedSiteShareSessionMenu({
  session,
  ariaLabel,
  className,
  iconSize = 16,
}: ShareButtonProps & { readonly session: HostedSiteShareSession }) {
  const signal = useGet(session.signal$);
  const open = useGet(session.open$);
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
      {/* A small dialog rather than a menu: there are no list rows to inset,
          so it keeps the popover's own padding and grows wide enough for a
          full site address. */}
      <PopoverContent
        align="end"
        aria-label={ariaLabel}
        className="w-90 max-w-[calc(100vw-2rem)]"
      >
        <HostedSiteShareBody
          session={session}
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
