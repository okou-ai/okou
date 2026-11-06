import { useTranslation } from "react-i18next";
import { limitingSubscriptionUsageWindow } from "../../lib/subscription-usage-windows.ts";
import { formatLocalizedNumber } from "../../i18n/format.ts";
import type { AccountMenuSubscriptionUsageRow } from "../../signals/okou-page/account-menu-subscriptions.ts";
import { ProviderIcon } from "./components/settings/provider-icons.tsx";

// Leave a gap at both poles, including the rounded caps. Both halves rise
// from six o'clock, so equal values finish at the same height.
const LEFT_ARC = "M 13.8 27.8 A 12 12 0 0 1 13.8 4.2";
const RIGHT_ARC = "M 18.2 27.8 A 12 12 0 0 0 18.2 4.2";
const FULL_ARC = "M 16 4 A 12 12 0 0 1 16 28 A 12 12 0 0 1 16 4";

function remainingPercent(row: AccountMenuSubscriptionUsageRow) {
  // ChatGPT's popover exposes only the weekly window. Keep the rail aligned.
  return (
    limitingSubscriptionUsageWindow(
      row.type === "codex-oauth-token"
        ? { fiveHour: null, weekly: row.usage?.weekly ?? null }
        : row.usage,
    )?.remainingPercent ?? null
  );
}

export function SubscriptionUsageRing({
  rows,
}: {
  readonly rows: readonly AccountMenuSubscriptionUsageRow[];
}) {
  const { t } = useTranslation();
  const single = rows.length === 1 ? rows[0] : undefined;
  return (
    <>
      <span
        className="relative flex size-8 shrink-0 items-center justify-center"
        aria-hidden="true"
      >
        <svg
          viewBox="0 0 32 32"
          fill="none"
          className="absolute inset-0 size-8!"
        >
          {rows.map((row) => {
            return (
              <UsageArc
                key={row.type}
                path={
                  single
                    ? FULL_ARC
                    : row.type === "codex-oauth-token"
                      ? LEFT_ARC
                      : RIGHT_ARC
                }
                remaining={remainingPercent(row)}
              />
            );
          })}
        </svg>
        {single ? (
          <ProviderIcon type={single.type} size={14} />
        ) : (
          <span className="size-1.75 rotate-45 rounded-xs bg-muted-foreground/25" />
        )}
      </span>
      <span id="sidebar-subscription-ring-summary" className="sr-only">
        {rows
          .map((row) => {
            const remaining = remainingPercent(row);
            const label =
              row.type === "codex-oauth-token" ? "ChatGPT" : "Claude";
            const value =
              remaining === 0
                ? t(($) => {
                    return $.settings.accountMenu.subscriptions.limitReached;
                  })
                : remaining === null
                  ? "—"
                  : t(
                      ($) => {
                        return $.settings.models.personal.status.left;
                      },
                      {
                        percent: formatLocalizedNumber(remaining / 100, {
                          style: "percent",
                          maximumFractionDigits: 1,
                        }),
                      },
                    );
            return `${label}: ${value}`;
          })
          .join("; ")}
      </span>
    </>
  );
}

function UsageArc({
  path,
  remaining,
}: {
  readonly path: string;
  readonly remaining: number | null;
}) {
  return (
    <g strokeWidth={2.5} strokeLinecap="round">
      <path d={path} className="stroke-muted-foreground/25" />
      {remaining !== null && remaining > 0 && (
        <path
          d={path}
          pathLength={100}
          strokeDasharray={`${String(remaining)} 100`}
          className={
            remaining < 20 ? "stroke-usage-meter-low" : "stroke-chart-blue-400"
          }
        />
      )}
    </g>
  );
}
