import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Switch,
} from "@okouai/ui";
import { orgModelPolicies$ } from "../../../../signals/external/org-model-policies.ts";
import { isOrgAdmin$ } from "../../../../signals/org.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  autoModelConfirmationOpen$,
  setAutoModelConfirmationOpen$,
  switchOrgModelMode$,
} from "../../../../signals/okou-page/settings/org-model-mode.ts";
import { detach, Reason } from "../../../../signals/utils.ts";

/** Internal Debug-panel control; members never see the organization mode. */
export function OrgModelModeControl() {
  const { t } = useTranslation();
  const isAdmin = useLastResolved(isOrgAdmin$) === true;
  const data = useLastResolved(orgModelPolicies$);
  const pageSignal = useGet(pageSignal$);
  const confirmationOpen = useGet(autoModelConfirmationOpen$);
  const setConfirmationOpen = useSet(setAutoModelConfirmationOpen$);
  const [modeLoadable, switchMode] = useLoadableSet(switchOrgModelMode$);
  const saving = modeLoadable.state === "loading";
  const auto = data?.modelMode === "auto";

  const changeMode = (toAuto: boolean) => {
    detach(
      switchMode(toAuto ? "auto" : "custom", pageSignal),
      Reason.DomCallback,
    );
  };

  if (!isAdmin || data === undefined) {
    return null;
  }

  return (
    <>
      <div className="flex items-center justify-between gap-4 rounded-xl border border-surface-border bg-card p-5">
        <div>
          <h3 className="font-medium">
            {t(($) => {
              return $.settings.models.autoMode.title;
            })}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t(($) => {
              return $.settings.models.autoMode.description;
            })}
          </p>
        </div>
        <Switch
          aria-label={t(($) => {
            return $.settings.models.autoMode.title;
          })}
          checked={auto}
          disabled={saving}
          onCheckedChange={(checked) => {
            if (checked) {
              setConfirmationOpen(true);
            } else {
              changeMode(false);
            }
          }}
        />
      </div>
      {modeLoadable.state === "hasError" && (
        <p role="alert" className="text-sm text-destructive">
          {t(($) => {
            return $.settings.models.autoMode.failed;
          })}
        </p>
      )}
      <AutoModelConfirmation
        open={confirmationOpen}
        saving={saving}
        onOpenChange={setConfirmationOpen}
        onConfirm={() => {
          changeMode(true);
        }}
      />
    </>
  );
}

function AutoModelConfirmation({
  open,
  saving,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.settings.models.autoMode.confirmTitle;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.settings.models.autoMode.confirmDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={saving}
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {t(($) => {
              return $.settings.models.autoMode.cancel;
            })}
          </Button>
          <Button disabled={saving} onClick={onConfirm}>
            {t(($) => {
              return $.settings.models.autoMode.confirm;
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
