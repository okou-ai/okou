import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { OrgModelPoliciesResponse } from "@okouai/api-contracts/contracts/model-providers";
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
import {
  updateOrgModelMode$,
  updateOrgModelPolicies$,
} from "../../../../signals/external/org-model-policies.ts";
import { featureSwitch$ } from "../../../../signals/external/feature-switch.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  autoModelConfirmationOpen$,
  setAutoModelConfirmationOpen$,
} from "../../../../signals/okou-page/settings/org-model-mode.ts";
import { detach, Reason } from "../../../../signals/utils.ts";

export function OrgModelModeControl({
  data,
}: {
  data: OrgModelPoliciesResponse;
}) {
  const { t } = useTranslation();
  const available =
    useLastResolved(featureSwitch$)?.[FeatureSwitchKey.AutoModel] === true;
  const pageSignal = useGet(pageSignal$);
  const confirmationOpen = useGet(autoModelConfirmationOpen$);
  const setConfirmationOpen = useSet(setAutoModelConfirmationOpen$);
  const [modeLoadable, setMode] = useLoadableSet(updateOrgModelMode$);
  const [policyLoadable, updatePolicies] = useLoadableSet(
    updateOrgModelPolicies$,
  );
  const saving =
    modeLoadable.state === "loading" || policyLoadable.state === "loading";
  const auto = data.modelMode === "auto";

  const changeMode = (toAuto: boolean) => {
    detach(
      (async () => {
        if (toAuto) {
          // Preserve providers and member credentials; replace only org policies.
          await updatePolicies(
            {
              policies: [
                {
                  model: "okou-1.0",
                  isDefault: true,
                  defaultProviderType: "built-in",
                  credentialScope: "org",
                  modelProviderId: null,
                  modelProviderSurfaceId: null,
                },
              ],
              revision: data.revision,
              toast: false,
            },
            pageSignal,
          );
          pageSignal.throwIfAborted();
        }
        await setMode(toAuto ? "auto" : "custom", pageSignal);
        pageSignal.throwIfAborted();
        setConfirmationOpen(false);
      })(),
      Reason.DomCallback,
    );
  };

  return (
    <>
      {available && (
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
      )}
      {(modeLoadable.state === "hasError" ||
        policyLoadable.state === "hasError") && (
        <p role="alert" className="text-sm text-destructive">
          {t(($) => {
            return $.settings.models.autoMode.failed;
          })}
        </p>
      )}
      {auto && (
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.settings.models.autoMode.active;
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
