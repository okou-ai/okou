import { Button, Card, Input } from "@okouai/ui";
import { useGet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { friendReferralCodeSchema } from "@okouai/api-contracts/validators/friend-referrals";
import {
  setSignupFriendReferralCode$,
  signupFriendReferralCode$,
  signupFriendReferralReady$,
} from "../../signals/friend-referrals.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

export function SignupFriendReferral() {
  const { t } = useTranslation();
  const code = useGet(signupFriendReferralCode$);
  const ready = useGet(signupFriendReferralReady$);
  const signal = useGet(pageSignal$);
  const [validation, setCode] = useLoadableSet(setSignupFriendReferralCode$);
  const checking = validation.state === "loading";
  const failed = validation.state === "hasError";
  const invalid = !!code && !ready && !checking;
  const message = checking
    ? t(($) => {
        return $.friendReferrals.checkingCode;
      })
    : failed
      ? t(($) => {
          return $.friendReferrals.codeCheckFailed;
        })
      : invalid
        ? friendReferralCodeSchema.safeParse(code).success
          ? t(($) => {
              return $.friendReferrals.codeUnavailable;
            })
          : t(($) => {
              return $.friendReferrals.invalidCode;
            })
        : code
          ? t(($) => {
              return $.friendReferrals.codeApplied;
            })
          : "";

  return (
    <Card className="space-y-2 px-[var(--okou-auth-card-padding-inline)] py-4">
      <label htmlFor="signup-referral-code" className="text-sm font-medium">
        {t(($) => {
          return $.friendReferrals.signupLabel;
        })}
      </label>
      <Input
        id="signup-referral-code"
        name="invitationCode"
        value={code}
        placeholder={t(($) => {
          return $.friendReferrals.signupPlaceholder;
        })}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        aria-invalid={invalid || failed}
        aria-describedby="signup-referral-status"
        onChange={(event) => {
          detach(setCode(event.target.value, signal), Reason.DomCallback);
        }}
      />
      <p
        id="signup-referral-status"
        role="status"
        className={`flex min-h-4 items-center gap-2 text-xs ${invalid || failed ? "text-destructive" : "text-muted-foreground"}`}
      >
        {checking && (
          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
        )}
        {message}
      </p>
      {failed && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            detach(setCode(code, signal), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return $.friendReferrals.retry;
          })}
        </Button>
      )}
    </Card>
  );
}
