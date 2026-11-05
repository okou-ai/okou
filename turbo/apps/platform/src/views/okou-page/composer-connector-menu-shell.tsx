import type { ReactNode, Ref } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Search } from "lucide-react";
import { cn, PopoverClose } from "@okouai/ui";
import { isMobileTextInputDevice } from "../../lib/visual-viewport-keyboard.ts";

function focusConnectorSearch(element: HTMLElement | null) {
  const panel = element?.closest("[data-connector-panel]");
  if (
    panel?.closest("[data-slot='popover-content'][data-open]") &&
    panel.ownerDocument.activeElement === panel &&
    !isMobileTextInputDevice()
  ) {
    panel
      .querySelector<HTMLInputElement>("[data-connector-search]")
      ?.focus({ preventScroll: true });
  }
}

function ConnectorSearch({
  search,
  onSearchChange,
}: {
  readonly search: string;
  readonly onSearchChange: (search: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-1 flex shrink-0 items-center gap-2 px-3 py-1 border-b border-border/50">
      <Search
        size={16}
        aria-hidden="true"
        className="pointer-events-none shrink-0 text-muted-foreground"
      />
      <input
        ref={focusConnectorSearch}
        data-connector-search
        type="text"
        aria-label={t(($) => {
          return $.chat.connectors.find;
        })}
        placeholder={t(($) => {
          return $.chat.connectors.find;
        })}
        value={search}
        onChange={(event) => {
          onSearchChange(event.currentTarget.value);
        }}
        className="min-w-0 w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
      />
    </div>
  );
}

function AddConnectors({ onOpen }: { readonly onOpen: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex shrink-0 flex-col p-1">
      <PopoverClose
        render={
          <button
            type="button"
            className="flex w-full items-center gap-2 px-2 py-1.5 rounded-md text-sm text-foreground hover:bg-state-hover transition-colors"
            onClick={onOpen}
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-border/60 text-muted-foreground">
              <Plus size={13} />
            </span>
            {t(($) => {
              return $.chat.connectors.addConnectors;
            })}
          </button>
        }
      />
    </div>
  );
}

function ConnectorMenuViewport({
  children,
  role,
  label,
  showSearch,
  contentRef,
  hidden = false,
}: {
  readonly children: ReactNode;
  readonly role: "list" | "group";
  readonly label: string;
  readonly showSearch: boolean;
  readonly contentRef: Ref<HTMLDivElement> | undefined;
  readonly hidden?: boolean;
}) {
  return (
    <div
      ref={hidden ? undefined : contentRef}
      hidden={hidden}
      tabIndex={contentRef ? -1 : undefined}
      role={role}
      aria-label={label}
      // Hidden overview DOM retains its offset without exposing its controls.
      className={cn(
        "min-h-0 flex-1 flex-col overflow-y-auto pb-2",
        hidden ? "hidden" : "flex",
        !showSearch && "max-h-67 pt-1",
      )}
    >
      {children}
    </div>
  );
}

/** The existing popup chrome is shared; only its connector/account content varies. */
export function ComposerConnectorMenuShell({
  children,
  footer,
  loading,
  hasContent,
  error,
  showSearch,
  search,
  onSearchChange,
  onOpenAddDialog,
  contentKey,
  contentRef,
  detail,
}: {
  readonly children: ReactNode;
  readonly footer: ReactNode;
  readonly loading: boolean;
  readonly hasContent: boolean;
  readonly error?: string;
  readonly showSearch: boolean;
  readonly search: string;
  readonly onSearchChange: (search: string) => void;
  readonly onOpenAddDialog: () => void;
  readonly contentKey?: string;
  readonly contentRef?: Ref<HTMLDivElement>;
  readonly detail?: {
    readonly key: string;
    readonly label: string;
    readonly content: ReactNode;
  };
}) {
  const { t } = useTranslation();
  return (
    <div
      data-connector-panel
      // Base UI focuses this while loading; once ready, search is first.
      tabIndex={loading ? 0 : -1}
      onFocus={(event) => {
        focusConnectorSearch(event.currentTarget);
      }}
      className={cn(
        "flex min-h-0 flex-col outline-none",
        showSearch && "h-100",
      )}
    >
      {error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 p-3 text-sm text-destructive"
        >
          <span>{error}</span>
        </div>
      )}
      {(hasContent || loading) && (
        <div className="flex min-h-0 flex-1 flex-col">
          {showSearch && (
            <ConnectorSearch search={search} onSearchChange={onSearchChange} />
          )}
          {loading ? (
            <div className="flex flex-col pt-1 pb-2 animate-pulse">
              {Array.from({ length: 3 }, (_, i) => {
                return (
                  <div key={i} className="flex items-center gap-2 px-3 py-2">
                    <span className="h-4 w-4 shrink-0 rounded bg-muted/50" />
                    <span className="h-3.5 w-20 rounded bg-muted/50 flex-1" />
                    <span className="h-3 w-6 rounded-full bg-muted/50" />
                  </div>
                );
              })}
            </div>
          ) : (
            <>
              <ConnectorMenuViewport
                key={contentKey}
                contentRef={contentRef}
                role="list"
                label={t(($) => {
                  return $.chat.connectors.title;
                })}
                showSearch={showSearch}
                hidden={Boolean(detail)}
              >
                {children}
              </ConnectorMenuViewport>
              {detail && (
                <ConnectorMenuViewport
                  key={detail.key}
                  contentRef={contentRef}
                  role="group"
                  label={detail.label}
                  showSearch={showSearch}
                >
                  {detail.content}
                </ConnectorMenuViewport>
              )}
            </>
          )}
          <div className="mx-3 shrink-0 border-t border-border/50" />
        </div>
      )}
      <AddConnectors onOpen={onOpenAddDialog} />
      {footer}
    </div>
  );
}
