import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  cn,
} from "@okouai/ui";
import { SubscriptionUsageRing } from "./subscription-usage-ring.tsx";
import { sidebarSubscriptionUsage$ } from "../../signals/okou-page/account-menu-subscriptions.ts";
import {
  sidebarSubscriptionOpen$,
  setSidebarSubscriptionEntry$,
  previewSidebarSubscriptionUsage$,
  openSidebarSubscriptionUsageDialog$,
  openSidebarSubscriptionResetDialog$,
} from "../../signals/okou-page/sidebar-subscription-entry.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { AccountMenuSubscriptionsPanel } from "./sidebar-subscriptions.tsx";

export function SidebarSubscriptionUsage({
  resetPending,
}: {
  readonly resetPending: boolean;
}) {
  const { t } = useTranslation();
  const usage = useLastResolved(sidebarSubscriptionUsage$);
  const open = useGet(sidebarSubscriptionOpen$);
  const setEntry = useSet(setSidebarSubscriptionEntry$);
  const previewUsage = useSet(previewSidebarSubscriptionUsage$);
  const openUsageDialog = useSet(openSidebarSubscriptionUsageDialog$);
  const openResetDialog = useSet(openSidebarSubscriptionResetDialog$);
  const pageSignal = useGet(pageSignal$);
  if (!usage || usage.rows.length === 0) {
    return null;
  }
  const handleOpenUsage = () => {
    detach(openUsageDialog(pageSignal), Reason.DomCallback);
  };
  const label = t(($) => {
    return $.settings.accountMenu.subscriptions.label;
  });

  return (
    <Popover open={open} onOpenChange={previewUsage}>
      <PopoverTrigger
        ref={setEntry}
        openOnHover
        delay={200}
        closeDelay={250}
        aria-describedby="sidebar-subscription-ring-summary"
        aria-label={
          usage.lowUsage
            ? t(($) => {
                return $.settings.accountMenu.subscriptions.lowUsage;
              })
            : label
        }
        render={
          <Button
            variant="quiet"
            size="icon"
            className={cn(
              "relative size-11 shrink-0 cursor-pointer p-1 text-muted-foreground",
              open && "bg-state-hover",
            )}
          />
        }
      >
        <SubscriptionUsageRing rows={usage.rows} />
      </PopoverTrigger>
      <PopoverContent
        initialFocus={false}
        side="right"
        align="end"
        sideOffset={10}
        className="w-[240px] p-1"
        aria-label={label}
      >
        <AccountMenuSubscriptionsPanel
          showRingKey={usage.rows.length === 2}
          loading={false}
          rows={usage.rows}
          resetControl="button"
          resetPending={resetPending}
          onOpenUsage={handleOpenUsage}
          onResetCodexUsage={openResetDialog}
        />
      </PopoverContent>
    </Popover>
  );
}
