import { useGet, useLastLoadable, useSet } from "ccstate-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Coins, PlusCircle } from "lucide-react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@okouai/ui";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import { assistantName$ } from "../../signals/branding.ts";
import { detachedNavigateTo$ } from "../../signals/route.ts";
import { openSettingsDialogAt$ } from "../../signals/okou-page/settings/settings-dialog.ts";
import { slackOrgData$ } from "../../signals/okou-page/slack.ts";
import {
  billingStatusAsync$,
  usagePackCreditsAsync$,
} from "../../signals/okou-page/billing.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { formatLocalizedNumber } from "../../i18n/format.ts";
import { DropdownMenuModalItem } from "../components/dropdown-menu-modal-item.tsx";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";
import { SlackMark } from "./components/slack-mark.tsx";
import { GetStartedEntry } from "./get-started-entry.tsx";

const telegramIconImg = settingsIconAssetUrl("telegram");

/** Whether the org-scoped Slack app is installed. */
function useSlackInstalled(): boolean | null {
  const loadable = useLastLoadable(slackOrgData$);
  if (loadable.state !== "hasData") {
    return null;
  }
  return loadable.data.isInstalled || loadable.data.isConnected;
}

function useCombinedCreditLabel(): string | null {
  const billingLoadable = useLastLoadable(billingStatusAsync$);
  const usagePackLoadable = useLastLoadable(usagePackCreditsAsync$);
  const orgCredits =
    billingLoadable.state === "hasData" ? billingLoadable.data.credits : null;
  const packCredits =
    usagePackLoadable.state === "hasData"
      ? usagePackLoadable.data.totalCredits
      : null;
  if (orgCredits === null || packCredits === null) {
    return null;
  }
  return formatLocalizedNumber(orgCredits + packCredits);
}

function GrowthCreditMenuItem({ openCredits }: { openCredits: () => void }) {
  const { t } = useTranslation();
  const creditLabel = useCombinedCreditLabel();
  if (creditLabel === null) {
    return null;
  }
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuModalItem
        className="gap-3 px-3 py-2.5"
        onModalSelect={openCredits}
        data-testid="growth-credits"
      >
        <Coins className="text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">
          {t(($) => {
            return $.chat.agentPage.growth.credits;
          })}
        </span>
        <span className="shrink-0 font-semibold tabular-nums">
          {creditLabel}
        </span>
      </DropdownMenuModalItem>
    </>
  );
}

function useGrowthActions() {
  const pageSignal = useGet(pageSignal$);
  const openSettings = useSet(openSettingsDialogAt$);
  const navigate = useSet(detachedNavigateTo$);
  return {
    openWorks: () => {
      navigate("/works");
    },
    openInvite: () => {
      detach(openSettings("people", pageSignal), Reason.DomCallback);
    },
    openCredits: () => {
      detach(openSettings("usage", pageSignal), Reason.DomCallback);
    },
  };
}

/**
 * The home page's growth entry.
 *
 * The corner names one thing — whichever growth step is still worth taking —
 * and the panel carries the rest. Slack is a one-time setup so it can be
 * finished; inviting never finishes, so it is the resting state and the entry
 * always has something to say.
 */
function GrowthEntry({ slackInstalled }: { slackInstalled: boolean }) {
  const { t } = useTranslation();
  const assistantName = useGet(assistantName$);
  const { openWorks, openInvite, openCredits } = useGrowthActions();

  const leadIsSlack = !slackInstalled;

  return (
    <DropdownMenu>
      <div
        // 12px, not the Button default 8px: the split control and the menu it
        // opens read as one object when their outer radii agree.
        className="inline-flex h-8 items-stretch rounded-[12px] border border-[hsl(var(--gray-400))] bg-card shadow-[var(--okou-card-shadow)]"
      >
        <Button
          type="button"
          variant="quiet"
          size="sm"
          className="h-full gap-[9px] rounded-l-[11px] rounded-r-none px-[11px] pr-[9px] text-foreground"
          onClick={leadIsSlack ? openWorks : openInvite}
          data-testid="growth-entry"
        >
          {leadIsSlack ? (
            <SlackMark size={16} />
          ) : (
            <PlusCircle className="text-brand-text" />
          )}
          <span className="text-[13px] font-medium">
            {leadIsSlack
              ? t(
                  ($) => {
                    return $.chat.agentPage.growth.addInSlack;
                  },
                  { assistantName },
                )
              : t(($) => {
                  return $.chat.agentPage.growth.inviteMember;
                })}
          </span>
        </Button>

        <DropdownMenuTrigger asChild>
          <Button
            showTooltip
            type="button"
            variant="quiet"
            size="icon-sm"
            aria-label={t(($) => {
              return $.chat.actions.more;
            })}
            className="h-full w-9 rounded-l-none rounded-r-[11px] border-l border-[hsl(var(--gray-300))] data-popup-open:bg-state-hover data-popup-open:text-foreground"
            data-testid="growth-entry-menu"
          >
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
      </div>

      <DropdownMenuContent align="end" className="w-[268px]">
        <DropdownMenuItem
          className="gap-3 px-3 py-2.5"
          onClick={openWorks}
          data-testid="growth-slack"
        >
          <SlackMark size={16} />
          <span className="min-w-0 flex-1 truncate">
            {slackInstalled
              ? t(
                  ($) => {
                    return $.chat.agentPage.growth.inSlack;
                  },
                  { assistantName },
                )
              : t(
                  ($) => {
                    return $.chat.agentPage.growth.addInSlack;
                  },
                  { assistantName },
                )}
          </span>
          {slackInstalled ? (
            <Check className="shrink-0 text-[#2EB67D]" />
          ) : (
            <span className="shrink-0 text-xs text-muted-foreground">
              {t(($) => {
                return $.chat.agentPage.growth.connect;
              })}
            </span>
          )}
        </DropdownMenuItem>

        <DropdownMenuItem className="gap-3 px-3 py-2.5" onClick={openWorks}>
          <img src={telegramIconImg} alt="" className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {t(($) => {
              return $.chat.agentPage.growth.otherChannels;
            })}
          </span>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuModalItem
          className="gap-3 px-3 py-2.5"
          onModalSelect={openInvite}
          data-testid="growth-invite"
        >
          <PlusCircle className="text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">
            {t(($) => {
              return $.chat.agentPage.growth.inviteMember;
            })}
          </span>
        </DropdownMenuModalItem>

        {/* Content is unmounted while closed, so credit requests stay lazy. */}
        <GrowthCreditMenuItem openCredits={openCredits} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The corner the growth entry sits in.
 *
 * The row spans the page rather than the 900px content column, so the entry
 * lands in the top-right corner — the position the invite button has always
 * held, and the one the menu's `align="end"` is drawn against. It stays outside
 * the page's flex layout so loading it cannot shift the home content.
 */
function CornerHeader({ children }: { children: ReactNode }) {
  return (
    <header className="pointer-events-none absolute inset-x-0 top-0 z-10 hidden bg-transparent px-4 pb-2 pt-4 md:block sm:px-6">
      <div className="pointer-events-auto flex items-center justify-end gap-2">
        {children}
      </div>
    </header>
  );
}

function AdminGrowthEntry() {
  const slackInstalled = useSlackInstalled();
  if (slackInstalled === null) {
    return null;
  }
  return <GrowthEntry slackInstalled={slackInstalled} />;
}

export function GrowthEntryHeader() {
  const isAdminLoadable = useLastLoadable(isOrgAdmin$);
  const isAdmin = isAdminLoadable.state === "hasData" && isAdminLoadable.data;
  const features = useGet(featureSwitch$);
  const questsEnabled = features[FeatureSwitchKey.GetStartedQuests];
  return (
    <>
      {/* Match the former in-flow header's 16px + 32px + 8px height. The
          slot exists from the first render so async role and entry resolution
          cannot move the home content. The corner controls stay absolute. */}
      <div aria-hidden className="hidden h-14 shrink-0 md:block" />
      {/* Getting started is offered to every role — a member can connect,
          build, share and check in on their own — while the workspace controls
          beside it stay admin-only. */}
      {questsEnabled || isAdmin ? (
        <CornerHeader>
          {questsEnabled ? <GetStartedEntry /> : null}
          {isAdmin ? <AdminGrowthEntry /> : null}
        </CornerHeader>
      ) : null}
    </>
  );
}
