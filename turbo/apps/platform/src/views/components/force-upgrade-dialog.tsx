import { useGet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";

import { forceUpgradeDialogOpen$ } from "../../signals/force-upgrade.ts";
import { brandName$ } from "../../signals/branding.ts";

export function ForceUpgradeDialog() {
  const open = useGet(forceUpgradeDialogOpen$);
  const brandName = useGet(brandName$);
  const { t } = useTranslation();

  return (
    <Dialog
      open={open}
      onOpenChange={(_nextOpen, eventDetails) => {
        eventDetails.cancel();
      }}
    >
      <DialogContent maxWidth="md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.shared.forceUpgrade.title;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(
              ($) => {
                return $.shared.forceUpgrade.description;
              },
              { brandName },
            )}
          </DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  );
}
