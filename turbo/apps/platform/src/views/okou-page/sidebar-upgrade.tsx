import { surfaceVariants } from "@okouai/ui";
import { useGet, useSet, useLastLoadable } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { billingStatusAsync$ } from "../../signals/okou-page/billing.ts";
import { planProImg, planTeamImg } from "./platform-assets.ts";
import {
  openSettingsBillingPlans$,
  setSettingsDialogOpen$,
} from "../../signals/okou-page/settings/settings-dialog.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import { refreshSidebarChatThreadLayoutOnRef$ } from "../../signals/chat-page/sidebar-chat-thread-scroll.ts";

function nextTierInfo(
  tier: string,
): { tier: "pro" | "team"; img: string } | null {
  if (tier === "free" || tier === "limited-free-1" || tier === "pro-suspend") {
    return { tier: "pro", img: planProImg };
  }
  if (tier === "pro") {
    return { tier: "team", img: planTeamImg };
  }
  return null;
}

export function SidebarUpgradeCard() {
  const refreshLayoutRef = useSet(refreshSidebarChatThreadLayoutOnRef$);
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const billingLoadable = useLastLoadable(billingStatusAsync$);
  const billing =
    billingLoadable.state === "hasData" ? billingLoadable.data : null;
  const isAdminLoadable = useLastLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;
  const openBillingPlans = useSet(openSettingsBillingPlans$);
  const openSettings = useSet(setSettingsDialogOpen$);

  if (!isAdmin) {
    return null;
  }

  if (!billing) {
    return null;
  }
  const next = nextTierInfo(billing.tier);
  if (!next) {
    return null;
  }

  const handleClick = () => {
    openBillingPlans();
    detach(openSettings(true, pageSignal), Reason.DomCallback);
  };
  const nextLabel =
    next.tier === "pro"
      ? t(($) => {
          return $.billing.plans.pro.name;
        })
      : t(($) => {
          return $.billing.plans.team.name;
        });

  return (
    <button
      ref={refreshLayoutRef}
      type="button"
      onClick={handleClick}
      className={surfaceVariants({
        radius: "compact",
        className: "flex w-full items-center gap-3 p-2.5 text-left",
      })}
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-[color:var(--nav-copy,var(--color-foreground))]">
          {t(
            ($) => {
              return $.billing.sidebar.getPlan;
            },
            { plan: nextLabel },
          )}
        </p>
        <p className="mt-0.5 text-[11px] text-nav-copy-muted">
          {t(($) => {
            return $.billing.sidebar.description;
          })}
        </p>
      </div>
      <img
        src={next.img}
        alt={nextLabel}
        className="h-14 w-14 shrink-0 object-contain -my-3"
      />
    </button>
  );
}
