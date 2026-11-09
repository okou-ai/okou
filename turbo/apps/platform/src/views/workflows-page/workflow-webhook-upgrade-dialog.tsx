import { useGet, useLastResolved, useSet } from "ccstate-react";
import { Lock } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui";
import { useTranslation } from "react-i18next";

import { isOrgAdmin$ } from "../../signals/org.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  setWorkflowWebhookUpgradeDialogOpen$,
  workflowWebhookUpgradeDialogOpen$,
} from "../../signals/workflows-page/workflows-signals.ts";
import {
  openSettingsBillingPlans$,
  setSettingsDialogOpen$,
} from "../../signals/okou-page/settings/settings-dialog.ts";
import { detach, Reason } from "../../signals/utils.ts";

export function WorkflowWebhookUpgradeDialog() {
  const { t } = useTranslation();
  const open = useGet(workflowWebhookUpgradeDialogOpen$);
  const setOpen = useSet(setWorkflowWebhookUpgradeDialogOpen$);
  const isAdmin = useLastResolved(isOrgAdmin$) ?? false;
  const openBillingPlans = useSet(openSettingsBillingPlans$);
  const setSettingsDialogOpen = useSet(setSettingsDialogOpen$);
  const pageSignal = useGet(pageSignal$);

  const upgrade = () => {
    setOpen(false);
    openBillingPlans();
    detach(
      setSettingsDialogOpen(true, pageSignal),
      Reason.DomCallback,
      "open Team billing plans for webhook automations",
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent smMaxWidth="md">
        <DialogHeader>
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-50 text-amber-700">
            <Lock size={19} />
          </div>
          <DialogTitle>
            {t(($) => {
              return $.workflows.automations.webhook.upgrade.title;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.workflows.automations.webhook.upgrade.description;
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-xl border border-border/60 bg-muted/30 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
              {t(($) => {
                return $.workflows.automations.webhook.paidBadge;
              })}
            </span>
            <span className="text-sm font-medium text-foreground">
              {t(($) => {
                return $.workflows.automations.webhook.upgrade.benefitTitle;
              })}
            </span>
          </div>
          <p className="mt-1.5 text-sm leading-5 text-muted-foreground">
            {t(($) => {
              return $.workflows.automations.webhook.upgrade.benefitDescription;
            })}
          </p>
        </div>
        {!isAdmin ? (
          <p className="text-sm text-muted-foreground">
            {t(($) => {
              return $.workflows.automations.webhook.upgrade.adminHint;
            })}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setOpen(false);
            }}
          >
            {isAdmin
              ? t(($) => {
                  return $.workflows.common.cancel;
                })
              : t(($) => {
                  return $.workflows.common.close;
                })}
          </Button>
          {isAdmin ? (
            <Button type="button" onClick={upgrade}>
              {t(($) => {
                return $.workflows.automations.webhook.upgrade.upgradeAction;
              })}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
