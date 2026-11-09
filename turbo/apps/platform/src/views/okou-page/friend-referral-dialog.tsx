import type { FriendReferralStatus } from "@okouai/api-contracts/contracts/friend-referrals";
import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Check, Link } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
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
import { questArtUrl } from "./get-started-quest-shell.tsx";

/**
 * The dialog keeps to three text styles: the 18px title, 14px medium body for
 * everything the reader acts on or reads as a value, and 12px for supporting
 * copy. Every block is separated by the same `gap-5`.
 */

function ReferralFigure() {
  return (
    <div className="-mx-6 -mt-6 flex h-50 items-center justify-center bg-illustration-canvas p-6">
      <img
        src={questArtUrl("invite")}
        alt=""
        aria-hidden
        className="block max-h-38 max-w-full object-contain"
      />
    </div>
  );
}

function ReferralSteps() {
  const { t } = useTranslation();
  const steps = [
    t(($) => {
      return $.friendReferrals.stepSignUp;
    }),
    t(($) => {
      return $.friendReferrals.stepUsagePack;
    }),
    t(($) => {
      return $.friendReferrals.stepUpgrade;
    }),
  ];
  return (
    <ol className="grid grid-cols-3 gap-5">
      {steps.map((step, index) => {
        return (
          <li
            key={step}
            className="flex flex-col items-center gap-2 rounded-xl bg-nested-fill px-3 py-4 text-center"
          >
            <span className="flex size-6 items-center justify-center rounded-full bg-primary text-xs text-primary-foreground tabular-nums">
              {formatLocalizedNumber(index + 1)}
            </span>
            <span className="text-sm font-medium">{step}</span>
          </li>
        );
      })}
    </ol>
  );
}

function ReferralStat({
  value,
  label,
}: {
  readonly value: number;
  readonly label: string;
}) {
  return (
    <p className="flex flex-col rounded-xl bg-nested-fill p-3 text-center">
      <span className="text-sm font-medium tabular-nums">
        {formatLocalizedNumber(value)}
      </span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </p>
  );
}

function FriendReferralSkeleton() {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      aria-label={t(($) => {
        return $.friendReferrals.loading;
      })}
    >
      <div className="grid gap-5" aria-hidden="true">
        <Skeleton className="h-9 w-full" />
        <div className="grid grid-cols-2 gap-5">
          <Skeleton className="h-15 w-full rounded-xl" />
          <Skeleton className="h-15 w-full rounded-xl" />
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
  const copied = copyState.state === "hasData" && copyState.data.copied;
  return (
    <>
      <div className="grid gap-2">
        <Button
          className="w-full"
          disabled={copyState.state === "loading"}
          onClick={() => {
            detach(copy(data.code, signal), Reason.DomCallback);
          }}
        >
          {copied ? <Check className="size-4" /> : <Link className="size-4" />}
          {copied
            ? t(($) => {
                return $.friendReferrals.copied;
              })
            : t(($) => {
                return $.friendReferrals.copyLink;
              })}
        </Button>
        {copyState.state === "hasData" && !copyState.data.copied && (
          <p className="text-center text-xs text-destructive" role="alert">
            {t(($) => {
              return $.friendReferrals.copyFailed;
            })}
          </p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-5">
        <ReferralStat
          value={data.registeredCount}
          label={t(($) => {
            return $.friendReferrals.registered;
          })}
        />
        <ReferralStat
          value={data.earnedCredits}
          label={t(($) => {
            return $.friendReferrals.earned;
          })}
        />
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
      <DialogContent smMaxWidth="lg" contentClassName="gap-5">
        <ReferralFigure />
        <DialogHeader className="space-y-1 sm:text-center">
          <DialogTitle>
            {t(($) => {
              return $.friendReferrals.dialogTitle;
            })}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t(($) => {
              return $.friendReferrals.description;
            })}
          </DialogDescription>
        </DialogHeader>
        <ReferralSteps />
        {loading && <FriendReferralSkeleton />}
        {failed && (
          <div className="grid justify-items-center gap-3">
            <p className="text-xs text-destructive" role="alert">
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
        <div className="h-px bg-divider" />
        <p className="text-center text-xs leading-relaxed text-gray-700">
          {t(($) => {
            return $.friendReferrals.terms;
          })}
        </p>
      </DialogContent>
    </Dialog>
  );
}
