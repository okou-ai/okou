import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { DialogTrigger, IconButton } from "@okouai/ui";
import { useGet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Gift } from "lucide-react";
import { useTranslation } from "react-i18next";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { loadFriendReferral$ } from "../../signals/friend-referrals.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { FriendReferralDialog } from "./friend-referral-dialog.tsx";

export function FriendReferralEntry() {
  const enabled = useGet(featureSwitch$)[FeatureSwitchKey.FriendReferrals];
  return enabled ? <FriendReferralEntryContent /> : null;
}

function FriendReferralEntryContent() {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const [referral, loadReferral] = useLoadableSet(loadFriendReferral$);
  const reload = () => {
    detach(loadReferral(signal), Reason.DomCallback);
  };

  return (
    <FriendReferralDialog
      trigger={
        <DialogTrigger
          onClick={reload}
          render={
            <IconButton
              type="button"
              showTooltip
              aria-label={t(($) => {
                return $.friendReferrals.title;
              })}
              className="size-8 shrink-0 text-muted-foreground"
            />
          }
        >
          <Gift className="size-4" aria-hidden="true" />
        </DialogTrigger>
      }
      data={referral.state === "hasData" ? referral.data : null}
      loading={referral.state === "loading"}
      failed={referral.state === "hasError"}
      onRetry={reload}
    />
  );
}
