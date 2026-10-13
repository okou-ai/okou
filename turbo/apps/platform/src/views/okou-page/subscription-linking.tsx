import type { PersonalSubscriptionProviderType } from "@okouai/api-contracts/contracts/model-providers";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui";
import { useGet, useLastResolved, useSet } from "ccstate-react";
import { ChevronRight, Cpu } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  connectSubscriptionLinkingProvider$,
  openSubscriptionLinkingSettings$,
  subscriptionLinkingUnlinked$,
  trackSubscriptionLinkingOpened$,
  type SubscriptionLinkingSource,
} from "../../signals/okou-page/subscription-linking.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { PersonalClaudeCodeDeviceAuthDialog } from "./components/settings/claude-code-device-auth-dialog.tsx";
import { PersonalCodexDeviceAuthDialog } from "./components/settings/codex-device-auth-dialog.tsx";
import { ProviderIcon } from "./components/settings/provider-icons.tsx";

const SUBSCRIPTION_PROVIDERS: readonly PersonalSubscriptionProviderType[] = [
  "codex-oauth-token",
  "claude-code-oauth-token",
];

/** True once the member is known to have no personal subscription. */
export function useSubscriptionLinkingAvailable(): boolean {
  return useLastResolved(subscriptionLinkingUnlinked$) === true;
}

function useConnectProvider(source: SubscriptionLinkingSource) {
  const { t } = useTranslation();
  const connect = useSet(connectSubscriptionLinkingProvider$);
  const pageSignal = useGet(pageSignal$);
  return {
    title: (type: PersonalSubscriptionProviderType) => {
      return type === "codex-oauth-token"
        ? t(($) => {
            return $.settings.models.personal.codexTitle;
          })
        : t(($) => {
            return $.settings.models.personal.claudeTitle;
          });
    },
    connect: (type: PersonalSubscriptionProviderType) => {
      detach(connect(source, type, pageSignal), Reason.DomCallback);
    },
  };
}

/**
 * The provider marks at rest take the composer's muted icon colour, so the
 * slot reads as one more quiet control; hover and the open menu restore the
 * brand colours.
 */
function SubscriptionProviderMarks() {
  return (
    <span
      aria-hidden="true"
      className="flex items-center gap-1 opacity-70 brightness-0 transition-[filter,opacity] group-hover:opacity-100 group-hover:brightness-100 group-data-popup-open:opacity-100 group-data-popup-open:brightness-100 dark:invert dark:group-hover:invert-0 dark:group-data-popup-open:invert-0"
    >
      {SUBSCRIPTION_PROVIDERS.map((type) => {
        return <ProviderIcon key={type} type={type} size={16} />;
      })}
    </span>
  );
}

/**
 * Members without a personal subscription have only Auto, so the composer
 * shows no model picker. Its slot offers the subscriptions that add models;
 * once one is linked, the same slot becomes the model picker.
 */
export function SubscriptionLinkingComposerMenu() {
  const { t } = useTranslation();
  const trackOpened = useSet(trackSubscriptionLinkingOpened$);
  const { title, connect } = useConnectProvider("composer_model_slot");
  const label = t(($) => {
    return $.settings.models.personal.autoTitle;
  });
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) {
          trackOpened("composer_model_slot");
        }
      }}
    >
      <TooltipProvider delay={300}>
        <Tooltip>
          <DropdownMenuTrigger
            render={
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="quiet"
                    size="sm"
                    className="group shrink-0 gap-1 px-2"
                    aria-label={label}
                  />
                }
              />
            }
          >
            <SubscriptionProviderMarks />
          </DropdownMenuTrigger>
          <TooltipContent side="top" className="text-xs">
            {label}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DropdownMenuContent
        side="top"
        align="end"
        sideOffset={8}
        aria-label={label}
        className="w-56"
      >
        <p className="px-2 pb-1 pt-1.5 text-xs text-muted-foreground">
          {label}
        </p>
        {SUBSCRIPTION_PROVIDERS.map((type) => {
          return (
            <DropdownMenuItem
              key={type}
              onClick={() => {
                connect(type);
              }}
            >
              <ProviderIcon type={type} size={16} />
              <span className="min-w-0 truncate">{title(type)}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Sits with the credits, the other way runs are paid for. Linked members
 * already see their usage there and manage accounts in Settings, so the row
 * leaves once a subscription is connected.
 */
export function SubscriptionLinkingMenuItem() {
  const { t } = useTranslation();
  const available = useSubscriptionLinkingAvailable();
  const { title, connect } = useConnectProvider("account_menu");
  if (!available) {
    return null;
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="gap-3 px-3">
        <Cpu size={18} aria-hidden="true" />
        <span className="flex-1">
          {t(($) => {
            return $.subscriptionLinking.menuConnect;
          })}
        </span>
        <ChevronRight size={14} aria-hidden="true" />
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-[220px]">
        {SUBSCRIPTION_PROVIDERS.map((type) => {
          return (
            <DropdownMenuItem
              key={type}
              className="gap-3 px-3"
              onClick={() => {
                connect(type);
              }}
            >
              <ProviderIcon type={type} size={18} />
              <span>{title(type)}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

export function useSubscriptionLinkingEntry() {
  const { t } = useTranslation();
  const available = useSubscriptionLinkingAvailable();
  const open = useSet(openSubscriptionLinkingSettings$);
  const pageSignal = useGet(pageSignal$);
  return {
    available,
    label: t(($) => {
      return $.subscriptionLinking.menuConnect;
    }),
    onClick: () => {
      detach(open(pageSignal), Reason.DomCallback);
    },
  };
}

// One owner per page shell prevents duplicate authorization dialogs when the
// composer, the account menu and Settings > Models share the personal
// subscription flow.
export function PersonalSubscriptionDialogs() {
  return (
    <>
      <PersonalClaudeCodeDeviceAuthDialog />
      <PersonalCodexDeviceAuthDialog />
    </>
  );
}
