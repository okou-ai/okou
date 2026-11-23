import { useGet, useLastResolved, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { HostedSiteShareAccount } from "@okouai/api-contracts/contracts/hosted-site-sharing";
import {
  Button,
  Command,
  CommandInput,
  CommandItem,
  CommandList,
  Skeleton,
} from "@okouai/ui";
import type { HostedSiteShareSession } from "../../signals/hosted-site-sharing.ts";
import { detach, Reason } from "../../signals/utils.ts";

interface PeopleProps {
  readonly session: HostedSiteShareSession;
  readonly busy: boolean;
  readonly failed: boolean;
  readonly onShare: (email: string) => void;
  readonly onRemove: (id: string) => void;
}

function AccountSuggestions({
  accounts,
  loading,
  failed,
  busy,
  onChoose,
}: {
  readonly accounts: readonly HostedSiteShareAccount[] | undefined;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly busy: boolean;
  readonly onChoose: (email: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <CommandList
      className="mt-1 max-h-40"
      aria-label={t(($) => {
        return $.artifacts.people.accounts;
      })}
    >
      {failed ? (
        <p className="px-2 py-2 text-xs text-muted-foreground" role="alert">
          {t(($) => {
            return $.artifacts.people.searchUnavailable;
          })}
        </p>
      ) : loading ? (
        <div
          className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground"
          role="status"
        >
          <Loader2 size={14} className="animate-spin" />
          {t(($) => {
            return $.artifacts.people.searching;
          })}
        </div>
      ) : accounts && accounts.length > 0 ? (
        accounts.map((account) => {
          return (
            <CommandItem
              key={account.userId}
              value={account.email}
              disabled={busy}
              className="px-2 py-2"
              onClick={() => {
                onChoose(account.email);
              }}
            >
              <span className="min-w-0 flex-1">
                {account.name && (
                  <span className="block truncate text-sm">{account.name}</span>
                )}
                <span className="block truncate text-xs text-muted-foreground">
                  {account.email}
                </span>
              </span>
            </CommandItem>
          );
        })
      ) : accounts ? (
        <p className="px-2 py-2 text-xs text-muted-foreground">
          {t(($) => {
            return $.artifacts.people.noAccounts;
          })}
        </p>
      ) : null}
    </CommandList>
  );
}

function AccountSearch({
  session,
  busy,
}: Pick<PeopleProps, "session" | "busy">) {
  const { t } = useTranslation();
  const input = useGet(session.people.input$);
  const valid = useGet(session.people.validEmail$);
  const [accounts, change] = useLoadableSet(session.people.change$);
  const signal = useGet(session.signal$);
  if (!signal) {
    return null;
  }
  const choose = (value: string) => {
    detach(change(value, signal), Reason.DomCallback);
  };
  return (
    <>
      <Command value={input} filter={null} onValueChange={choose}>
        <div className="flex items-center gap-2">
          <CommandInput
            wrapperClassName="min-w-0 flex-1"
            id={session.peopleInputId}
            aria-label={t(($) => {
              return $.artifacts.people.label;
            })}
            placeholder={t(($) => {
              return $.artifacts.people.placeholder;
            })}
            maxLength={254}
            disabled={busy}
            autoComplete="off"
          />
          <Button
            type="submit"
            size="sm"
            disabled={!valid || busy}
            aria-busy={busy}
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {t(($) => {
              return $.artifacts.people.share;
            })}
          </Button>
        </div>
        {input.trim().length >= 2 && (
          <AccountSuggestions
            accounts={accounts.state === "hasData" ? accounts.data : undefined}
            loading={accounts.state === "loading"}
            failed={accounts.state === "hasError"}
            busy={busy}
            onChoose={choose}
          />
        )}
      </Command>
      <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
        {t(($) => {
          return $.artifacts.people.hint;
        })}
      </p>
    </>
  );
}

function PeopleList({
  session,
  busy,
  onRemove,
}: Pick<PeopleProps, "session" | "busy" | "onRemove">) {
  const { t } = useTranslation();
  const shares = useLoadable(session.people.shares$);
  const current = useLastResolved(session.people.shares$);
  if (shares.state === "loading" && !current) {
    return <Skeleton className="mt-3 h-9 w-full rounded-lg" />;
  }
  if (!current) {
    return null;
  }
  if (current.length === 0) {
    return (
      <p className="mt-2 py-2 text-xs text-muted-foreground">
        {t(($) => {
          return $.artifacts.people.empty;
        })}
      </p>
    );
  }
  return (
    <div className="mt-2 max-h-28 overflow-y-auto">
      <ul
        aria-label={t(($) => {
          return $.artifacts.people.viewers;
        })}
      >
        {current.map((share) => {
          return (
            <li key={share.id} className="flex min-h-9 items-center gap-2 py-1">
              <span className="min-w-0 flex-1 truncate text-sm">
                {share.email}
              </span>
              <Button
                type="button"
                size="icon-xs"
                variant="quiet"
                disabled={busy}
                aria-label={t(
                  ($) => {
                    return $.artifacts.people.remove;
                  },
                  { email: share.email },
                )}
                onClick={() => {
                  onRemove(share.id);
                }}
              >
                <X size={14} />
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function HostedSitePeople({
  session,
  busy,
  failed,
  onShare,
  onRemove,
}: PeopleProps) {
  const { t } = useTranslation();
  const valid = useGet(session.people.validEmail$);
  const email = useGet(session.people.input$);
  return (
    <div className="px-2 pb-1 pt-3">
      <form
        onSubmit={(event) => {
          // This form submits an invitation without navigating the preview.
          event.preventDefault();
          if (valid && !busy) {
            onShare(email);
          }
        }}
      >
        <label className="sr-only" htmlFor={session.peopleInputId}>
          {t(($) => {
            return $.artifacts.people.label;
          })}
        </label>
        <AccountSearch session={session} busy={busy} />
      </form>
      {failed && (
        <p className="mt-2 text-xs text-muted-foreground" role="alert">
          {t(($) => {
            return $.artifacts.people.updateUnavailable;
          })}
        </p>
      )}
      <PeopleList session={session} busy={busy} onRemove={onRemove} />
    </div>
  );
}
