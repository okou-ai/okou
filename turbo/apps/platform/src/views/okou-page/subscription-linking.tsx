import type { PersonalSubscriptionProviderType } from "@okouai/api-contracts/contracts/model-providers";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuRadioItemIndicator,
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
import { Check, ChevronRight, Cpu } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  connectSubscriptionLinkingProvider$,
  SUBSCRIPTION_PROVIDERS,
  subscriptionLinkingUnlinked$,
  trackSubscriptionLinkingOpened$,
  type SubscriptionLinkingSource,
} from "../../signals/okou-page/subscription-linking.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { PersonalClaudeCodeDeviceAuthDialog } from "./components/settings/claude-code-device-auth-dialog.tsx";
import { PersonalCodexDeviceAuthDialog } from "./components/settings/codex-device-auth-dialog.tsx";
import { ProviderIcon } from "./components/settings/provider-icons.tsx";

/** True once the member is known to have no personal subscription. */
export function useSubscriptionLinkingAvailable(): boolean {
  return useLastResolved(subscriptionLinkingUnlinked$) === true;
}

export function useConnectProvider(source: SubscriptionLinkingSource) {
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
    /** The plans that include the subscription, so members know before signing in. */
    plans: (type: PersonalSubscriptionProviderType) => {
      return type === "codex-oauth-token"
        ? t(($) => {
            return $.settings.models.personal.codexPlans;
          })
        : t(($) => {
            return $.settings.models.personal.claudePlans;
          });
    },
    connect: (type: PersonalSubscriptionProviderType) => {
      detach(connect(source, type, pageSignal), Reason.DomCallback);
    },
  };
}

/** A provider row's name over the plans that include it. */
export function SubscriptionPlanRowText({
  title,
  detail,
  detailId,
}: {
  title: string;
  detail: string;
  detailId?: string;
}) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate">{title}</span>
      <span id={detailId} className="truncate text-xs text-muted-foreground">
        {detail}
      </span>
    </span>
  );
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
 * shows no model picker. Its slot opens the same list the picker will show:
 * Auto on Okou credits, then the subscriptions that run on the member's own
 * plan. Once one is linked, the same slot becomes the model picker.
 */
export function SubscriptionLinkingComposerMenu() {
  const { t } = useTranslation();
  const trackOpened = useSet(trackSubscriptionLinkingOpened$);
  const { title, plans, connect } = useConnectProvider("composer_model_slot");
  const label = t(($) => {
    return $.settings.models.personal.autoTitle;
  });
  const autoLabel = t(($) => {
    return $.settings.models.picker.auto;
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
        className="w-[304px] max-w-[calc(100vw-16px)]"
      >
        <DropdownMenuRadioGroup
          value="auto"
          aria-label={t(($) => {
            return $.settings.models.picker.chatModels;
          })}
        >
          <DropdownMenuRadioItem
            value="auto"
            label={autoLabel}
            aria-label={autoLabel}
            aria-describedby="subscription-linking-auto-detail"
            closeOnClick
            className="pr-2"
          >
            <ProviderIcon type="built-in" size={16} />
            <SubscriptionPlanRowText
              title={autoLabel}
              detail={t(($) => {
                return $.settings.models.personal.autoCredits;
              })}
              detailId="subscription-linking-auto-detail"
            />
            <span className="flex w-4 shrink-0 justify-center">
              <DropdownMenuRadioItemIndicator>
                <Check size={15} aria-hidden="true" />
              </DropdownMenuRadioItemIndicator>
            </span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <p className="px-2 pb-1 pt-2 text-xs text-muted-foreground">
          {t(($) => {
            return $.settings.models.personal.ownPlan;
          })}
        </p>
        {SUBSCRIPTION_PROVIDERS.map((type) => {
          const detailId = `subscription-linking-${type}-plans`;
          return (
            <DropdownMenuItem
              key={type}
              label={title(type)}
              aria-label={title(type)}
              aria-describedby={detailId}
              className="pr-2"
              onClick={() => {
                connect(type);
              }}
            >
              <ProviderIcon type={type} size={16} />
              <SubscriptionPlanRowText
                title={title(type)}
                detail={plans(type)}
                detailId={detailId}
              />
              <span className="shrink-0 text-xs text-muted-foreground">
                {t(($) => {
                  return $.settings.models.personal.connect;
                })}
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One row per subscription; each opens that provider's sign-in. */
export function SubscriptionLinkingProviderItems({
  source,
}: {
  source: "account_menu" | "me_page";
}) {
  const { title, connect } = useConnectProvider(source);
  return (
    <>
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
    </>
  );
}

/**
 * Sits with the credits, the other way runs are paid for, under the same name
 * as the composer slot and Settings > Models. Linked members already see their
 * usage there and manage accounts in Settings, so the row leaves once a
 * subscription is connected.
 */
export function SubscriptionLinkingMenuItem() {
  const { t } = useTranslation();
  const available = useSubscriptionLinkingAvailable();
  if (!available) {
    return null;
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="gap-3 px-3">
        <Cpu size={18} aria-hidden="true" />
        <span className="flex-1">
          {t(($) => {
            return $.settings.models.personal.autoTitle;
          })}
        </span>
        <ChevronRight size={14} aria-hidden="true" />
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-[220px]">
        <SubscriptionLinkingProviderItems source="account_menu" />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** Me lists the same two subscriptions as the account menu, in its own menu. */
export function useSubscriptionLinkingEntry() {
  const { t } = useTranslation();
  const available = useSubscriptionLinkingAvailable();
  const trackOpened = useSet(trackSubscriptionLinkingOpened$);
  return {
    available,
    label: t(($) => {
      return $.settings.models.personal.autoTitle;
    }),
    onOpenChange: (open: boolean) => {
      if (open) {
        trackOpened("me_page");
      }
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
