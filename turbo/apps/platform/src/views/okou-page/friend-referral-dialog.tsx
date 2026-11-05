import type { FriendReferralStatus } from "@okouai/api-contracts/contracts/friend-referrals";
import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Check, Copy, Gift, Link } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Skeleton,
} from "@okouai/ui";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  copyFriendReferral$,
  friendReferralOpen$,
  setFriendReferralOpen$,
} from "../../signals/friend-referrals.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { formatLocalizedNumber } from "../../i18n/format.ts";

function FriendReferralSkeleton() {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      aria-label={t(($) => {
        return $.friendReferrals.loading;
      })}
    >
      <div className="space-y-4" aria-hidden="true">
        <div className="space-y-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-12 w-full" />
          <div className="grid grid-cols-2 gap-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 rounded-lg bg-nested-fill p-3">
          {[0, 1].map((index) => {
            return (
              <div key={index}>
                <Skeleton className="h-5 w-8" />
                <Skeleton className="h-5 w-24 max-w-full" />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function FriendReferralDetails({
  data,
}: {
  readonly data: FriendReferralStatus;
}) {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const [copyState, copy] = useLoadableSet(copyFriendReferral$);
  const copiedTarget =
    copyState.state === "hasData" && copyState.data.copied
      ? copyState.data.target
      : null;
  return (
    <>
      <div className="space-y-2">
        <label
          htmlFor="friend-referral-code"
          className="block text-sm font-medium"
        >
          {t(($) => {
            return $.friendReferrals.codeLabel;
          })}
        </label>
        <Input
          id="friend-referral-code"
          readOnly
          value={data.code}
          className="h-12 text-center font-mono text-xl tracking-widest"
        />
        <div className="grid grid-cols-2 gap-2">
          <Button
            disabled={copyState.state === "loading"}
            onClick={() => {
              detach(copy(data.code, "code", signal), Reason.DomCallback);
            }}
          >
            {copiedTarget === "code" ? (
              <Check className="size-4" />
            ) : (
              <Copy className="size-4" />
            )}
            {copiedTarget === "code"
              ? t(($) => {
                  return $.friendReferrals.copied;
                })
              : t(($) => {
                  return $.friendReferrals.copyCode;
                })}
          </Button>
          <Button
            variant="outline"
            disabled={copyState.state === "loading"}
            onClick={() => {
              detach(copy(data.code, "link", signal), Reason.DomCallback);
            }}
          >
            {copiedTarget === "link" ? (
              <Check className="size-4" />
            ) : (
              <Link className="size-4" />
            )}
            {copiedTarget === "link"
              ? t(($) => {
                  return $.friendReferrals.copied;
                })
              : t(($) => {
                  return $.friendReferrals.copyLink;
                })}
          </Button>
        </div>
        {copyState.state === "hasData" && !copyState.data.copied && (
          <p className="text-sm text-destructive" role="alert">
            {t(($) => {
              return $.friendReferrals.copyFailed;
            })}
          </p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-4 rounded-lg bg-nested-fill p-3 text-sm">
        <p>
          <span className="block font-semibold tabular-nums">
            {formatLocalizedNumber(data.registeredCount)}
          </span>
          <span className="text-muted-foreground">
            {t(($) => {
              return $.friendReferrals.registered;
            })}
          </span>
        </p>
        <p>
          <span className="block font-semibold tabular-nums">
            {formatLocalizedNumber(data.earnedCredits)}
          </span>
          <span className="text-muted-foreground">
            {t(($) => {
              return $.friendReferrals.earned;
            })}
          </span>
        </p>
      </div>
    </>
  );
}

export function FriendReferralDialog({
  trigger,
  data,
  loading,
  failed,
  onRetry,
}: {
  readonly trigger: ReactNode;
  readonly data: FriendReferralStatus | null;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly onRetry: () => void;
}) {
  const { t } = useTranslation();
  const open = useGet(friendReferralOpen$);
  const setOpen = useSet(setFriendReferralOpen$);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger}
      <DialogContent smMaxWidth="md">
        <DialogHeader>
          <span className="mb-2 flex size-10 items-center justify-center rounded-lg bg-nested-fill">
            <Gift className="size-5 text-brand-text" />
          </span>
          <DialogTitle>
            {t(($) => {
              return $.friendReferrals.title;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.friendReferrals.description;
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-50 space-y-4">
          {loading && <FriendReferralSkeleton />}
          {failed && (
            <div className="space-y-3">
              <p className="text-sm text-destructive" role="alert">
                {t(($) => {
                  return $.friendReferrals.loadFailed;
                })}
              </p>
              <Button variant="outline" onClick={onRetry}>
                {t(($) => {
                  return $.friendReferrals.retry;
                })}
              </Button>
            </div>
          )}
          {!loading && !failed && data && <FriendReferralDetails data={data} />}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t(($) => {
            return $.friendReferrals.terms;
          })}
        </p>
      </DialogContent>
    </Dialog>
  );
}
