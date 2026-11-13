import { Autocomplete } from "@base-ui/react/autocomplete";
import { useGet, useSet } from "ccstate-react";
import { ArrowRight, Search, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CommandItem, CommandList, Input, TransientAlert } from "@okouai/ui";
import type { BrowserSignals } from "../../signals/browser/browser.ts";
import type { AddressSuggestion } from "../../signals/browser/navigation/suggestions.ts";

interface AddressProps {
  readonly signals: BrowserSignals;
  readonly canSubmit: boolean;
  readonly navigating: boolean;
}

function BrowserAddressInput({
  signals,
  navigating,
}: Pick<AddressProps, "signals" | "navigating">) {
  const { t } = useTranslation();
  const addressRef = useSet(signals.refs.address$);
  const beginEdit = useSet(signals.beginAddressEdit$);
  const blur = useSet(signals.blurAddress$);
  const compose = useSet(signals.suggestions.compose$);
  return (
    <Autocomplete.Input
      render={<Input />}
      ref={addressRef}
      data-browser-address
      aria-label={t(($) => {
        return $.browserViewer.address;
      })}
      placeholder={t(($) => {
        return $.browserViewer.addressSearchPlaceholder;
      })}
      className="h-8 min-w-0 flex-1"
      enterKeyHint="go"
      autoComplete="off"
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      aria-busy={navigating}
      onFocus={() => {
        beginEdit("focus");
      }}
      onPointerDown={() => {
        beginEdit("interaction");
      }}
      onBeforeInput={() => {
        beginEdit("interaction");
      }}
      onCompositionStart={() => {
        compose(true);
        beginEdit("interaction");
      }}
      onCompositionEnd={() => {
        compose(false);
      }}
      onBlur={() => {
        compose(false);
        blur();
      }}
      onKeyDown={(event) => {
        if (
          event.nativeEvent.isComposing ||
          event.nativeEvent.keyCode === 229
        ) {
          // The form owns submission, including Safari's final Enter after
          // compositionend; IME confirmation must not submit it.
          if (event.key === "Enter") {
            event.preventDefault();
          }
          return;
        }
        beginEdit("interaction");
      }}
    />
  );
}

function AddressSuggestionItem({
  match,
  index,
  disabled,
  onSubmit,
}: {
  readonly match: AddressSuggestion;
  readonly index: number;
  readonly disabled: boolean;
  readonly onSubmit: (match: AddressSuggestion) => void;
}) {
  const { t } = useTranslation();
  const label = !match.available
    ? t(($) => {
        return $.browserViewer.tabUnavailable;
      })
    : match.kind === "tab"
      ? t(($) => {
          return $.browserViewer.switchToTab;
        })
      : match.kind === "search"
        ? t(($) => {
            return $.browserViewer.searchDefaultEngine;
          })
        : t(($) => {
            return $.browserViewer.openAddress;
          });
  const Icon =
    match.kind === "tab" ? Copy : match.kind === "search" ? Search : ArrowRight;
  const text =
    match.kind === "tab"
      ? match.title
      : match.kind === "search"
        ? match.text
        : match.url;
  return (
    <CommandItem
      value={match.id}
      index={index}
      disabled={disabled}
      className="gap-2 px-3 py-2 hover:bg-state-hover"
      onClick={() => {
        onSubmit(match);
      }}
    >
      <Icon size={16} aria-hidden className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{text}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {label}
          {match.kind === "tab" ? ` · ${match.url}` : ""}
        </span>
      </span>
    </CommandItem>
  );
}

function AddressSubmissionNotice({
  signals,
  canSubmit,
  navigating,
}: AddressProps) {
  const { t } = useTranslation();
  const notice = useGet(signals.addressSubmitNotice$);
  return (
    <TransientAlert
      occurrences={notice && (!canSubmit || navigating) ? [notice] : []}
      className="absolute inset-x-2 top-full z-20 mt-1 rounded-lg border border-surface-border bg-popover px-3 py-2 text-xs text-muted-foreground"
    >
      {t(($) => {
        return notice?.kind === "opening"
          ? $.browserViewer.addressOpening
          : $.browserViewer.addressPreparing;
      })}
    </TransientAlert>
  );
}

export function BrowserAddressAutocomplete({
  signals,
  canSubmit,
  navigating,
  onSubmit,
}: AddressProps & {
  readonly onSubmit: (suggestion?: AddressSuggestion) => void;
}) {
  const address = useGet(signals.address$);
  const edit = useSet(signals.editAddress$);
  const suggestions = signals.suggestions;
  const matches = useGet(suggestions.matches$);
  const open = useGet(suggestions.open$);
  const highlighted = useGet(suggestions.highlighted$);
  const composing = useGet(suggestions.composing$);
  const setOpen = useSet(suggestions.setOpen$);
  const highlight = useSet(suggestions.highlight$);
  const notify = useSet(signals.notifyAddressSubmit$);
  const submit = (match?: AddressSuggestion) => {
    if (composing) {
      return;
    }
    if (!canSubmit || navigating) {
      notify(navigating ? "opening" : "preparing");
      return;
    }
    notify(null);
    onSubmit(match);
    setOpen(false);
  };
  return (
    <>
      <Autocomplete.Root<string>
        value={address}
        items={matches.map((match) => {
          return match.id;
        })}
        mode="none"
        filter={null}
        open={open}
        keepHighlight
        openOnInputClick
        onValueChange={(value, details) => {
          if (
            details.reason === "item-press" ||
            details.reason === "escape-key"
          ) {
            // Selecting an action must not replace the typed query with its ID.
            details.cancel();
            return;
          }
          notify(null);
          highlight(null, -1);
          edit(value);
        }}
        onOpenChange={(value) => {
          setOpen(value);
        }}
        onItemHighlighted={(value, details) => {
          // Programmatic list updates must not retarget an explicit selection.
          if (details.reason !== "none") {
            highlight(value ?? null, details.index);
          }
        }}
      >
        <form
          className="flex min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            submit(highlighted ?? undefined);
          }}
        >
          <BrowserAddressInput signals={signals} navigating={navigating} />
        </form>
        <Autocomplete.Portal>
          <Autocomplete.Positioner
            sideOffset={4}
            align="start"
            className="z-50 outline-none"
          >
            <Autocomplete.Popup className="max-h-[var(--available-height)] w-[var(--anchor-width)] overflow-hidden rounded-xl border border-surface-border bg-popover p-1 text-popover-foreground shadow-md">
              <CommandList className="max-h-[min(20rem,var(--available-height))]">
                {matches.map((match, index) => {
                  return (
                    <AddressSuggestionItem
                      key={match.id}
                      match={match}
                      index={index}
                      disabled={!canSubmit || navigating || !match.available}
                      onSubmit={submit}
                    />
                  );
                })}
              </CommandList>
            </Autocomplete.Popup>
          </Autocomplete.Positioner>
        </Autocomplete.Portal>
      </Autocomplete.Root>
      <AddressSubmissionNotice
        signals={signals}
        canSubmit={canSubmit}
        navigating={navigating}
      />
    </>
  );
}
