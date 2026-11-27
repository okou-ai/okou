import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Loader2, UserRound, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ArtifactShareAccount } from "@okouai/api-contracts/contracts/artifact-access";
import {
  Button,
  Combobox,
  ComboboxContent,
  ComboboxInputGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Skeleton,
  cn,
} from "@okouai/ui";
import type { State } from "ccstate";
import type { createSharePeopleSignals } from "../../signals/share-people.ts";
import { currentUserInfo$ } from "../../signals/auth.ts";
import { detach, Reason } from "../../signals/utils.ts";

interface PeopleProps {
  readonly session: {
    readonly signal$: State<AbortSignal | null>;
    readonly people: ReturnType<typeof createSharePeopleSignals>;
    readonly peopleInputId: string;
  };
  readonly busy: boolean;
  readonly failed: boolean;
  readonly onShare: (email: string) => void;
  readonly onRemove: (userId: string) => void;
}

function PersonMark({ className }: { readonly className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-full bg-nested-fill text-muted-foreground",
        className,
      )}
    >
      <UserRound size={16} />
    </span>
  );
}

function AccountSuggestions({
  accounts,
  loading,
  failed,
  busy,
}: {
  readonly accounts: readonly ArtifactShareAccount[] | undefined;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly busy: boolean;
}) {
  const { t } = useTranslation();
  return (
    <CommandList
      className="max-h-48"
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
            >
              <PersonMark className="mr-2" />
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
  const open = useGet(session.people.searchOpen$);
  const setOpen = useSet(session.people.setSearchOpen$);
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
      <Combobox
        value={input}
        filter={null}
        open={open && input.trim().length >= 2 && !busy}
        onOpenChange={setOpen}
        openOnInputClick
        onValueChange={(value) => {
          choose(value);
        }}
      >
        <div className="flex items-center gap-2">
          <ComboboxInputGroup className="min-w-0 flex-1">
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
          </ComboboxInputGroup>
          {/* Matches the field's h-9; the primary fill is kept for the
              moment there is an address to commit. */}
          <Button
            type="submit"
            variant={valid ? "default" : "neutral"}
            disabled={!valid || busy}
            aria-busy={busy}
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {t(($) => {
              return $.artifacts.people.share;
            })}
          </Button>
        </div>
        <ComboboxContent>
          <AccountSuggestions
            accounts={accounts.state === "hasData" ? accounts.data : undefined}
            loading={accounts.state === "loading"}
            failed={accounts.state === "hasError"}
            busy={busy}
          />
        </ComboboxContent>
      </Combobox>
    </>
  );
}

function OwnerRow() {
  const { t } = useTranslation();
  const owner = useLastResolved(currentUserInfo$);
  if (!owner) {
    return null;
  }
  const email = owner.primaryEmailAddress?.emailAddress ?? null;
  const name = owner.fullName || email;
  return (
    <li className="flex min-h-11 items-center gap-3 py-1.5">
      <PersonMark />
      <span className="min-w-0 flex-1">
        {name && (
          <span className="block truncate text-sm">
            {t(
              ($) => {
                return $.artifacts.people.you;
              },
              { name },
            )}
          </span>
        )}
        {email && email !== name && (
          <span className="block truncate text-xs text-muted-foreground">
            {email}
          </span>
        )}
      </span>
      <span className="shrink-0 pr-2 text-xs text-muted-foreground">
        {t(($) => {
          return $.artifacts.people.owner;
        })}
      </span>
    </li>
  );
}

/**
 * The owner leads the list, as in every comparable share dialog, so an
 * artifact nobody else can open still shows who has access rather than an
 * empty-state sentence.
 */
function PeopleList({
  session,
  busy,
  onRemove,
}: Pick<PeopleProps, "session" | "busy" | "onRemove">) {
  const { t } = useTranslation();
  const shares = useLoadable(session.people.shares$);
  const current = useLastResolved(session.people.shares$);
  if (shares.state === "loading" && !current) {
    return <Skeleton className="mt-2 h-11 w-full rounded-lg" />;
  }
  if (!current) {
    return null;
  }
  return (
    <ul
      className="mt-2 max-h-44 overflow-y-auto"
      aria-label={t(($) => {
        return $.artifacts.people.viewers;
      })}
    >
      <OwnerRow />
      {current.map((share) => {
        return (
          <li
            key={share.userId}
            className="flex min-h-11 items-center gap-3 py-1.5"
          >
            <PersonMark />
            <span className="min-w-0 flex-1">
              {share.name && share.name !== share.email && (
                <span className="block truncate text-sm">{share.name}</span>
              )}
              <span
                className={cn(
                  "block truncate",
                  share.name && share.name !== share.email
                    ? "text-xs text-muted-foreground"
                    : "text-sm",
                )}
              >
                {share.email}
              </span>
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
                onRemove(share.userId);
              }}
            >
              <X size={14} />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

export function SharePeople({
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
    <div>
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
