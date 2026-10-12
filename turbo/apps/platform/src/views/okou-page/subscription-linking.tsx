import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DropdownMenuItem,
  IconButton,
} from "@okouai/ui";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { ArrowRight, Link2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { brandName$ } from "../../signals/branding.ts";
import { reloadPersonalModelProviders$ } from "../../signals/external/personal-model-providers.ts";
import {
  closeSubscriptionLinking$,
  connectSubscriptionLinkingProvider$,
  dismissSubscriptionLinkingHint$,
  manageLinkedSubscriptions$,
  openSubscriptionLinking$,
  subscriptionLinkingEnabled$,
  subscriptionLinkingHintRef$,
  subscriptionLinkingHintVisible$,
  subscriptionLinkingSource$,
  subscriptionLinkingUnlinked$,
} from "../../signals/okou-page/subscription-linking.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { PersonalClaudeCodeDeviceAuthDialog } from "./components/settings/claude-code-device-auth-dialog.tsx";
import { PersonalCodexDeviceAuthDialog } from "./components/settings/codex-device-auth-dialog.tsx";
import { ProviderIcon } from "./components/settings/provider-icons.tsx";

export function SubscriptionLinkingHint() {
  const visible = useLoadable(subscriptionLinkingHintVisible$);
  const open = useSet(openSubscriptionLinking$);
  const dismiss = useSet(dismissSubscriptionLinkingHint$);
  const hintRef = useSet(subscriptionLinkingHintRef$);
  const pageSignal = useGet(pageSignal$);
  const { t } = useTranslation();

  if (visible.state !== "hasData" || !visible.data) {
    return null;
  }

  return (
    <div
      ref={hintRef}
      className="mt-2 flex items-start gap-2 text-xs text-muted-foreground"
      data-testid="subscription-linking-hint"
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1">
        <span className="py-2">
          {t(($) => {
            return $.subscriptionLinking.hint;
          })}
        </span>
        <Button
          type="button"
          variant="quiet"
          size="sm"
          className="h-11 gap-1 px-1 text-xs text-foreground sm:h-9"
          onClick={() => {
            return open("composer_hint");
          }}
        >
          {t(($) => {
            return $.subscriptionLinking.connect;
          })}
          <ArrowRight size={14} aria-hidden />
        </Button>
      </div>
      <IconButton
        type="button"
        aria-label={t(($) => {
          return $.subscriptionLinking.dismiss;
        })}
        className="size-11 shrink-0 text-muted-foreground hover:bg-gray-50 sm:size-9"
        onClick={() => {
          return detach(dismiss(pageSignal), Reason.DomCallback);
        }}
      >
        <X size={14} aria-hidden />
      </IconButton>
    </div>
  );
}

export function useSubscriptionLinkingEntry() {
  const enabled = useGet(subscriptionLinkingEnabled$);
  const subscriptions = useLoadable(subscriptionLinkingUnlinked$);
  const open = useSet(openSubscriptionLinking$);
  const manage = useSet(manageLinkedSubscriptions$);
  const pageSignal = useGet(pageSignal$);
  const { t } = useTranslation();
  const connected =
    subscriptions.state === "hasData" && subscriptions.data === false;
  const label =
    subscriptions.state !== "hasData"
      ? t(($) => {
          return $.subscriptionLinking.menuLoading;
        })
      : connected
        ? t(($) => {
            return $.subscriptionLinking.manage;
          })
        : t(($) => {
            return $.subscriptionLinking.menuConnect;
          });

  return {
    enabled,
    label,
    onClick: () => {
      if (connected) {
        detach(manage(pageSignal), Reason.DomCallback);
      } else {
        open("account_menu");
      }
    },
  };
}

export function SubscriptionLinkingMenuItem() {
  const entry = useSubscriptionLinkingEntry();
  if (!entry.enabled) {
    return null;
  }
  return (
    <DropdownMenuItem className="gap-3 px-3" onClick={entry.onClick}>
      <Link2 size={18} aria-hidden />
      <span>{entry.label}</span>
    </DropdownMenuItem>
  );
}

// One owner per page shell prevents duplicate authorization dialogs when the
// account menu and Settings > Models share the personal subscription flow.
export function PersonalSubscriptionDialogs() {
  return (
    <>
      <SubscriptionLinkingDialog />
      <PersonalClaudeCodeDeviceAuthDialog />
      <PersonalCodexDeviceAuthDialog />
    </>
  );
}

function SubscriptionLinkingDialog() {
  const enabled = useGet(subscriptionLinkingEnabled$);
  const source = useGet(subscriptionLinkingSource$);
  const close = useSet(closeSubscriptionLinking$);
  const { t } = useTranslation();
  const brandName = useGet(brandName$);
  return (
    <Dialog
      open={enabled && source !== null}
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
    >
      <DialogContent maxWidth="md">
        <DialogHeader className="text-left">
          <DialogTitle className="pr-8 leading-6">
            {t(($) => {
              return $.subscriptionLinking.title;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(
              ($) => {
                return $.subscriptionLinking.description;
              },
              { brandName },
            )}
          </DialogDescription>
        </DialogHeader>
        {source !== null && <SubscriptionProviderChoices />}
      </DialogContent>
    </Dialog>
  );
}

function SubscriptionProviderChoices() {
  const providers = useLoadable(subscriptionLinkingUnlinked$);
  const connect = useSet(connectSubscriptionLinkingProvider$);
  const reload = useSet(reloadPersonalModelProviders$);
  const manage = useSet(manageLinkedSubscriptions$);
  const close = useSet(closeSubscriptionLinking$);
  const pageSignal = useGet(pageSignal$);
  const { t } = useTranslation();
  if (providers.state === "hasError") {
    return (
      <div className="space-y-3">
        <p role="alert" className="text-sm text-muted-foreground">
          {t(($) => {
            return $.settings.models.personal.loadError;
          })}
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            return reload();
          }}
        >
          {t(($) => {
            return $.settings.models.personal.retry;
          })}
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {(
        [
          {
            type: "codex-oauth-token",
            label: t(($) => {
              return $.settings.models.personal.codexTitle;
            }),
          },
          {
            type: "claude-code-oauth-token",
            label: t(($) => {
              return $.settings.models.personal.claudeTitle;
            }),
          },
        ] as const
      ).map((provider) => {
        return (
          <Button
            key={provider.type}
            type="button"
            variant="outline"
            className="h-auto min-h-16 w-full justify-start gap-3 rounded-xl p-4 text-left"
            disabled={providers.state !== "hasData"}
            onClick={() => {
              return detach(
                connect(provider.type, pageSignal),
                Reason.DomCallback,
              );
            }}
          >
            <ProviderIcon type={provider.type} size={24} />
            <span className="min-w-0 flex-1 whitespace-normal">
              {provider.label}
            </span>
            <ArrowRight size={16} aria-hidden />
          </Button>
        );
      })}
      {providers.state === "hasData" && providers.data === false && (
        <Button
          type="button"
          variant="quiet"
          onClick={() => {
            close();
            detach(manage(pageSignal), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return $.subscriptionLinking.manage;
          })}
        </Button>
      )}
      <p className="text-xs text-muted-foreground">
        {t(($) => {
          return $.subscriptionLinking.limits;
        })}
      </p>
    </div>
  );
}
