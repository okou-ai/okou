import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Loader2, RefreshCw, Send, Trash2 } from "lucide-react";
import { Button, CopyButton, Skeleton, buttonVariants } from "@okouai/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";
import { useTranslation } from "react-i18next";
import {
  deleteEmailConnection$,
  createEmailConnectionCode$,
  emailConnectionCode$,
  emailConnectDialogOpen$,
  emailConnectionFinalFocus$,
  emailLinkStatus$,
  setEmailConnectDialogOpen$,
} from "../../signals/okou-page/email.ts";
import { currentUserInfo$ } from "../../signals/auth.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

function EmailAddressRow({
  email,
  primary,
  source,
}: {
  readonly email: string;
  readonly primary: boolean;
  readonly source: "gmail" | "outlook" | undefined;
}) {
  const { t } = useTranslation();
  const [operation, remove] = useLoadableSet(deleteEmailConnection$);
  const signal = useGet(pageSignal$);
  const sourceLabel = t(($) => {
    return primary
      ? $.works.email.signInEmail
      : source === "gmail"
        ? $.works.email.sourceGmail
        : source === "outlook"
          ? $.works.email.sourceOutlook
          : $.works.email.title;
  });
  return (
    <tr aria-label={email} className="border-b border-border last:border-0">
      <td className="min-w-0 py-3 pr-3 align-middle">
        <span className="break-all text-sm font-medium leading-5">{email}</span>
        <span className="mt-1 block text-xs text-muted-foreground sm:hidden">
          {sourceLabel}
        </span>
        {operation.state === "hasError" ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {t(($) => {
              return $.works.email.loadError;
            })}
          </p>
        ) : null}
      </td>
      <td className="hidden py-3 pr-3 align-middle text-xs break-words text-muted-foreground sm:table-cell">
        {sourceLabel}
      </td>
      <td className="py-3 align-middle">
        <Button
          type="button"
          size="icon-sm"
          variant="quiet"
          showTooltip
          aria-label={t(
            ($) => {
              return $.works.email.deleteAria;
            },
            { email },
          )}
          disabled={operation.state === "loading"}
          onClick={() => {
            detach(remove(email, signal), Reason.DomCallback);
          }}
        >
          {operation.state === "loading" ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            <Trash2 aria-hidden="true" />
          )}
        </Button>
      </td>
    </tr>
  );
}

function EmailConnectionsTable({
  emails,
  sources,
  primaryEmail,
}: {
  readonly emails: readonly string[];
  readonly sources: Readonly<Record<string, "gmail" | "outlook">>;
  readonly primaryEmail: string | undefined;
}) {
  const { t } = useTranslation();
  return (
    <table className="w-full table-fixed border-collapse text-left">
      <thead>
        <tr className="border-b border-border">
          <th
            scope="col"
            className="pb-3 pr-3 text-xs font-normal text-muted-foreground"
          >
            {t(($) => {
              return $.works.email.emailAddress;
            })}
          </th>
          <th
            scope="col"
            className="hidden w-24 pb-3 pr-3 text-xs font-normal text-muted-foreground sm:table-cell"
          >
            {t(($) => {
              return $.works.email.source;
            })}
          </th>
          <th scope="col" className="w-9 pb-3">
            <span className="sr-only">
              {t(($) => {
                return $.works.email.actions;
              })}
            </span>
          </th>
        </tr>
      </thead>
      <tbody>
        {emails.map((email) => {
          return (
            <EmailAddressRow
              key={email}
              email={email}
              primary={email === primaryEmail}
              source={sources[email]}
            />
          );
        })}
      </tbody>
    </table>
  );
}

export function EmailConnectDialog() {
  const { t } = useTranslation();
  const open = useGet(emailConnectDialogOpen$);
  const setOpen = useSet(setEmailConnectDialogOpen$);
  const finalFocus = useSet(emailConnectionFinalFocus$);
  const status = useLastLoadable(emailLinkStatus$);
  const user = useLastLoadable(currentUserInfo$);
  const primaryEmail =
    user.state === "hasData"
      ? user.data?.primaryEmailAddress?.emailAddress.toLowerCase()
      : undefined;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        smMaxWidth={640}
        contentClassName="grid-cols-1"
        finalFocus={finalFocus}
      >
        <DialogHeader>
          <DialogTitle className="pr-7">
            {t(($) => {
              return $.works.email.manageTitle;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.works.email.manageDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        {status.state === "hasData" &&
        status.data.configured &&
        user.state === "hasData" ? (
          <>
            <EmailConnectionsTable
              emails={status.data.emails}
              sources={status.data.emailSources}
              primaryEmail={primaryEmail}
            />
            <EmailAddAddressCode address={status.data.address} />
            <p className="border-t border-border pt-3 text-xs text-muted-foreground">
              {t(($) => {
                return $.works.email.healthNotice;
              })}
            </p>
          </>
        ) : status.state === "hasError" ||
          user.state === "hasError" ||
          (status.state === "hasData" && !status.data.configured) ? (
          <p role="alert" className="text-sm text-destructive">
            {t(($) => {
              return status.state === "hasError" || user.state === "hasError"
                ? $.works.email.loadError
                : $.works.email.unavailable;
            })}
          </p>
        ) : (
          <div role="status" className="space-y-3">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function EmailAddAddressCode({ address }: { readonly address: string }) {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const generate = useSet(createEmailConnectionCode$);
  const operation = useLoadable(emailConnectionCode$);
  const lastCode = useLastLoadable(emailConnectionCode$);
  const code = lastCode.state === "hasData" ? lastCode.data : null;
  return (
    <div className="space-y-3">
      {code ? (
        <EmailConnectionCodePanel
          address={address}
          code={code}
          pending={operation.state === "loading"}
          onRegenerate={() => {
            detach(generate(signal), Reason.DomCallback);
          }}
        />
      ) : (
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            disabled={operation.state === "loading"}
            onClick={() => {
              detach(generate(signal), Reason.DomCallback);
            }}
          >
            {operation.state === "loading" ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : null}
            {t(($) => {
              return $.works.email.addEmail;
            })}
          </Button>
        </div>
      )}
      {operation.state === "hasError" ? (
        <p role="alert" className="text-sm text-destructive">
          {t(($) => {
            return $.works.email.codeError;
          })}
        </p>
      ) : null}
    </div>
  );
}

function EmailConnectionCodePanel({
  address,
  code,
  pending,
  onRegenerate,
}: {
  readonly address: string;
  readonly code: { readonly code: string; readonly expiresAt: string };
  readonly pending: boolean;
  readonly onRegenerate: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-gray-50 p-4"
      aria-description={t(($) => {
        return $.works.email.codeInstructions;
      })}
    >
      <div className="min-w-0 flex-1 basis-52">
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 font-mono text-xl tracking-wider sm:tracking-widest">
            {code.code}
          </code>
          <CopyButton
            text={code.code}
            showTooltip={false}
            aria-label={t(
              ($) => {
                return $.connectors.providerSettings.agentphone.copyCodeAria;
              },
              { code: code.code },
            )}
          />
          <Button
            type="button"
            variant="quiet"
            size="icon-sm"
            showTooltip
            aria-label={t(($) => {
              return $.works.email.newCode;
            })}
            disabled={pending}
            onClick={onRegenerate}
          >
            {pending ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw aria-hidden="true" />
            )}
          </Button>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <a
            href={`mailto:${address}`}
            className="break-all underline-offset-4 hover:text-foreground hover:underline"
          >
            {t(
              ($) => {
                return $.works.email.sendTo;
              },
              { address },
            )}
          </a>
          <time dateTime={code.expiresAt}>
            {t(($) => {
              return $.connectors.providerSettings.agentphone.codeExpiry;
            })}
          </time>
        </div>
      </div>
      <a
        href={`mailto:${address}?subject=${encodeURIComponent(code.code)}&body=${encodeURIComponent(code.code)}`}
        className={buttonVariants()}
      >
        <Send aria-hidden="true" />
        {t(($) => {
          return $.works.email.open;
        })}
      </a>
    </div>
  );
}
